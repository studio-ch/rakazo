import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  SnapshotRef,
} from "./contract.js";
import { decodeTar, type WorkspaceLimits } from "./tar.js";

export * from "./contract.js";

export const RAKAZO_UPSTREAM_COMMIT = "a4ebad0cae4f9d0d3f6e7b3c30316b2bf6d924db";
export const RAKAZO_CONTRACT_VERSION = "0.1.0";

const DEFAULT_LIMITS: WorkspaceLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxFiles: 100_000,
  maxPathBytes: 1024,
};

export interface XcloudSandboxConfig {
  apiUrl: string;
  serviceToken: string;
  regionId: string;
  flavorSlug: string;
  imageRef: string;
  networkRef?: string;
  adminUsername?: string;
  displayWidth?: number;
  displayHeight?: number;
  prepareTimeoutMs?: number;
  preparePollMs?: number;
  workspaceLimits?: Partial<WorkspaceLimits>;
  fetch?: typeof globalThis.fetch;
}

interface ComputerDto {
  id: string;
  botId: string;
  providerRef: string;
  fresh: boolean;
  state: string;
  workspaceRoot: string;
  instanceId: string | null;
  agentStatus: string;
  platform: string;
  error: string | null;
}

interface NdjsonFrame {
  stream?: "stdout" | "stderr";
  data?: string;
  exit?: { code: number; timedOut: boolean; error?: string };
}

export class XcloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "XcloudApiError";
  }
}

export class XcloudCapabilityError extends Error {
  constructor(capability: string) {
    super(`${capability} is unavailable in the non-graphical Xcloud adapter`);
    this.name = "XcloudCapabilityError";
  }
}

function normalizeRelativePath(value: string, maxPathBytes: number): string {
  if (value.includes("\0") || value.startsWith("/"))
    throw new Error("workspace path must be relative");
  const normalized = posix.normalize(value || ".");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("workspace path escapes its root");
  }
  if (Buffer.byteLength(normalized) > maxPathBytes) {
    throw new Error(`workspace path exceeds ${maxPathBytes} bytes`);
  }
  return normalized;
}

function joinWorkspace(root: string, relative: string, maxPathBytes: number): string {
  const normalized = normalizeRelativePath(relative, maxPathBytes);
  if (normalized === ".") throw new Error("workspace file path must not be empty");
  return posix.join(root, normalized);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("operation aborted");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("operation aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) abort();
    });
  });
}

export class XcloudSandboxProvider implements SandboxProvider {
  private readonly apiUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly limits: WorkspaceLimits;
  private readonly latestLease = new Map<string, ControlLeaseRef>();
  private readonly latestScreenCapability = new Map<string, string>();

  constructor(private readonly config: XcloudSandboxConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.fetcher = config.fetch ?? globalThis.fetch;
    this.limits = { ...DEFAULT_LIMITS, ...config.workspaceLimits };
    if (
      !this.apiUrl ||
      !config.serviceToken ||
      !config.regionId ||
      !config.flavorSlug ||
      !config.imageRef
    ) {
      throw new Error("apiUrl, serviceToken, regionId, flavorSlug, and imageRef are required");
    }
  }

  describe() {
    return {
      id: "xcloud",
      contractVersion: RAKAZO_CONTRACT_VERSION,
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const response = await this.fetcher(`${this.apiUrl}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${this.config.serviceToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        detail?: string;
        title?: string;
      } | null;
      throw new XcloudApiError(
        response.status,
        body?.detail ?? body?.title ?? `Xcloud API returned ${response.status}`,
      );
    }
    return response;
  }

  private async computer(id: string, signal: AbortSignal): Promise<ComputerDto> {
    const response = await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(id)}`,
      {},
      signal,
    );
    return (await response.json()) as ComputerDto;
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const response = await this.request(
      "/v1/xcloud/computers/provision",
      {
        method: "POST",
        body: JSON.stringify({
          externalComputerKey: request.botId,
          workspaceId: context.workspaceId,
          ...(request.providerRef ? { providerRef: request.providerRef } : {}),
          regionId: this.config.regionId,
          flavorSlug: this.config.flavorSlug,
          imageRef: this.config.imageRef,
          networkRef: this.config.networkRef ?? "default",
          adminUsername: this.config.adminUsername ?? "admin",
          displayWidth: this.config.displayWidth ?? 1920,
          displayHeight: this.config.displayHeight ?? 1080,
        }),
      },
      context.signal,
    );
    const dto = (await response.json()) as ComputerDto;
    return {
      id: dto.id,
      botId: dto.botId,
      kind: "xcloud",
      providerRef: dto.providerRef,
      ...(dto.fresh ? { fresh: true } : {}),
    };
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const deadline = Date.now() + (this.config.prepareTimeoutMs ?? 15 * 60_000);
    while (true) {
      const dto = await this.computer(computer.providerRef, context.signal);
      if (dto.state === "running" && dto.agentStatus === "healthy") {
        const prepared = await this.collect(
          computer,
          { argv: ["/bin/mkdir", "-p", "--", dto.workspaceRoot], timeoutMs: 60_000 },
          context,
          posix.dirname(dto.workspaceRoot),
        );
        if (prepared.code !== 0)
          throw new Error(prepared.stderr || "could not prepare Xcloud workspace");
        return;
      }
      if (dto.state === "error" || dto.error)
        throw new Error(dto.error ?? "Xcloud computer failed");
      if (Date.now() >= deadline)
        throw new Error("timed out waiting for the Xcloud computer agent");
      await sleep(this.config.preparePollMs ?? 2_000, context.signal);
    }
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* this.executeInHome(computer, request, context);
  }

  private async *executeInHome(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
    home?: string,
  ): AsyncIterable<ProcessEvent> {
    const dto = await this.computer(computer.providerRef, context.signal);
    if (!dto.instanceId) throw new Error("Xcloud computer has no instance");
    const response = await this.request(
      `/v1/xcloud/instances/${encodeURIComponent(dto.instanceId)}/agent/exec`,
      {
        method: "POST",
        body: JSON.stringify({ ...request, home: home ?? dto.workspaceRoot }),
      },
      context.signal,
    );
    if (!response.body) throw new Error("Xcloud exec returned no stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let sawExit = false;
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const frame = JSON.parse(line) as NdjsonFrame;
        if (frame.stream && frame.data !== undefined) {
          yield { type: frame.stream, data: Buffer.from(frame.data, "base64").toString("utf8") };
        }
        if (frame.exit) {
          sawExit = true;
          if (frame.exit.error) {
            yield {
              type: "stderr",
              data: `${frame.exit.error}${frame.exit.error.endsWith("\n") ? "" : "\n"}`,
            };
          }
          yield { type: "exit", code: frame.exit.code };
        }
      }
      if (done) break;
    }
    if (pending.trim()) throw new Error("Xcloud exec returned a truncated NDJSON frame");
    if (!sawExit) throw new Error("Xcloud exec ended without an exit event");
  }

  private async collect(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
    home?: string,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    let stdout = "";
    let stderr = "";
    let code = -1;
    for await (const event of this.executeInHome(computer, request, context, home)) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    return { stdout, stderr, code };
  }

  async listFiles(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const dto = await this.computer(computer.providerRef, context.signal);
    const relative = normalizeRelativePath(path, this.limits.maxPathBytes);
    const script = [
      "set -eu",
      'cd -- "$1"',
      'target="$2"',
      '[[ -d "$target" ]] || exit 44',
      'while IFS= read -r -d "" entry; do',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: zsh parameter expansion, not JavaScript interpolation.
      "  name=${entry#./}",
      '  encoded=$(printf %s "$name" | /usr/bin/base64 | /usr/bin/tr -d "\\n")',
      '  if [[ -d "$entry" ]]; then printf "dir\\t0\\t0\\t%s\\n" "$encoded";',
      '  elif [[ -f "$entry" ]]; then',
      '    size=$(/usr/bin/stat -f %z "$entry")',
      '    mode=$(/usr/bin/stat -f %Lp "$entry")',
      '    printf "file\\t%s\\t%s\\t%s\\n" "$size" "$mode" "$encoded"',
      "  fi",
      'done < <(/usr/bin/find "$target" -mindepth 1 -maxdepth 1 -print0)',
    ].join("\n");
    const result = await this.collect(
      computer,
      {
        argv: ["/bin/zsh", "-c", script, "xcloud-list", dto.workspaceRoot, relative],
        timeoutMs: 60_000,
      },
      context,
    );
    if (result.code !== 0) throw new Error(result.stderr || `listFiles exited ${result.code}`);
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [kind, size, mode, encoded] = line.split("\t");
        if ((kind !== "file" && kind !== "dir") || !size || !mode || !encoded) {
          throw new Error("invalid listFiles response from guest");
        }
        const entryPath = Buffer.from(encoded, "base64").toString("utf8");
        return {
          path: entryPath,
          kind,
          size: Number(size),
          ...(kind === "file" && Number.parseInt(mode, 8) & 0o111 ? { executable: true } : {}),
        };
      });
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const dto = await this.computer(computer.providerRef, context.signal);
    if (!dto.instanceId) throw new Error("Xcloud computer has no instance");
    const absolute = joinWorkspace(dto.workspaceRoot, path, this.limits.maxPathBytes);
    const response = await this.request(
      `/v1/xcloud/instances/${encodeURIComponent(dto.instanceId)}/agent/files?path=${encodeURIComponent(absolute)}`,
      {},
      context.signal,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const maxBytes = Math.min(
      options?.maxBytes ?? this.limits.maxFileBytes,
      this.limits.maxFileBytes,
    );
    if (bytes.byteLength > maxBytes) throw new Error(`computer file exceeds ${maxBytes} bytes`);
    return bytes;
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    if (file.content.byteLength > this.limits.maxFileBytes) {
      throw new Error(`${file.path} exceeds the ${this.limits.maxFileBytes}-byte file limit`);
    }
    const dto = await this.computer(computer.providerRef, context.signal);
    if (!dto.instanceId) throw new Error("Xcloud computer has no instance");
    const absolute = joinWorkspace(dto.workspaceRoot, file.path, this.limits.maxPathBytes);
    const parent = posix.dirname(absolute);
    const mkdir = await this.collect(
      computer,
      { argv: ["/bin/mkdir", "-p", "--", parent], timeoutMs: 60_000 },
      context,
    );
    if (mkdir.code !== 0) throw new Error(mkdir.stderr || `mkdir exited ${mkdir.code}`);
    await this.request(
      `/v1/xcloud/instances/${encodeURIComponent(dto.instanceId)}/agent/files?path=${encodeURIComponent(absolute)}&mode=${file.executable ? "0755" : "0644"}`,
      {
        method: "POST",
        body: Buffer.from(file.content),
        headers: { "Content-Type": "application/octet-stream" },
      },
      context.signal,
    );
  }

  private async setBrowserRunning(
    computer: ComputerRef,
    running: boolean,
    context: AdapterContext,
  ) {
    const argv = running
      ? ["/usr/bin/open", "-a", "Safari"]
      : ["/usr/bin/osascript", "-e", 'tell application "Safari" to quit'];
    await this.collect(computer, { argv, timeoutMs: 30_000 }, context).catch(() => undefined);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    await this.setBrowserRunning(computer, false, context);
    try {
      const response = await this.request(
        `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/workspace/export`,
        {},
        context.signal,
      );
      if (!response.body) throw new Error("Xcloud workspace export returned no body");
      const reader = response.body.getReader();
      const chunks = async function* () {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      };
      yield* decodeTar(chunks(), this.limits, context.signal);
    } finally {
      if (context.operationId !== "stop" && context.operationId !== "computer.sleep") {
        await this.setBrowserRunning(computer, true, {
          ...context,
          signal: new AbortController().signal,
        });
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const dto = await this.computer(computer.providerRef, context.signal);
    const stage = `${dto.workspaceRoot}.import-${randomUUID()}`;
    const operationResponse = await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/workspace/import`,
      { method: "POST" },
      context.signal,
    );
    const { operationId } = (await operationResponse.json()) as { operationId: string };
    const completeImport = async (success: boolean, error?: string) => {
      await this.request(
        `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/workspace/import/${encodeURIComponent(operationId)}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ success, ...(error ? { error: error.slice(0, 1000) } : {}) }),
        },
        new AbortController().signal,
      ).then(() => undefined);
    };
    await this.setBrowserRunning(computer, false, context);
    let count = 0;
    let total = 0;
    try {
      const setup = await this.collect(
        computer,
        { argv: ["/bin/mkdir", "-p", "--", stage], timeoutMs: 60_000 },
        context,
      );
      if (setup.code !== 0) throw new Error(setup.stderr || `staging mkdir exited ${setup.code}`);
      for await (const file of files) {
        if (context.signal.aborted)
          throw context.signal.reason ?? new Error("workspace import aborted");
        const relative = normalizeRelativePath(file.path, this.limits.maxPathBytes);
        if (relative === ".") throw new Error("workspace file path must not be empty");
        count += 1;
        total += file.content.byteLength;
        if (count > this.limits.maxFiles)
          throw new Error(`workspace exceeds ${this.limits.maxFiles} files`);
        if (file.content.byteLength > this.limits.maxFileBytes) {
          throw new Error(`${relative} exceeds the ${this.limits.maxFileBytes}-byte file limit`);
        }
        if (total > this.limits.maxTotalBytes) {
          throw new Error(`workspace exceeds the ${this.limits.maxTotalBytes}-byte total limit`);
        }
        const stagedComputer = { ...computer };
        const absolute = posix.join(stage, relative);
        const parent = posix.dirname(absolute);
        const mkdir = await this.collect(
          stagedComputer,
          { argv: ["/bin/mkdir", "-p", "--", parent], timeoutMs: 60_000 },
          context,
        );
        if (mkdir.code !== 0) throw new Error(mkdir.stderr || `mkdir exited ${mkdir.code}`);
        if (!dto.instanceId) throw new Error("Xcloud computer has no instance");
        await this.request(
          `/v1/xcloud/instances/${encodeURIComponent(dto.instanceId)}/agent/files?path=${encodeURIComponent(absolute)}&mode=${file.executable ? "0755" : "0644"}`,
          {
            method: "POST",
            body: Buffer.from(file.content),
            headers: { "Content-Type": "application/octet-stream" },
          },
          context.signal,
        );
      }
      const backup = `${dto.workspaceRoot}.previous-${randomUUID()}`;
      const swapScript = [
        "set -eu",
        "root=$1; stage=$2; backup=$3",
        "had_root=0",
        'if [[ -e "$root" ]]; then /bin/mv -- "$root" "$backup"; had_root=1; fi',
        'if /bin/mv -- "$stage" "$root"; then [[ $had_root = 0 ]] || /bin/rm -rf -- "$backup";',
        'else [[ $had_root = 0 ]] || /bin/mv -- "$backup" "$root"; exit 1; fi',
      ].join("\n");
      const swap = await this.collect(
        computer,
        {
          argv: ["/bin/zsh", "-c", swapScript, "xcloud-import", dto.workspaceRoot, stage, backup],
          timeoutMs: 120_000,
        },
        context,
      );
      if (swap.code !== 0) throw new Error(swap.stderr || `workspace swap exited ${swap.code}`);
      await completeImport(true);
    } catch (error) {
      await this.collect(
        computer,
        { argv: ["/bin/rm", "-rf", "--", stage], timeoutMs: 60_000 },
        { ...context, signal: new AbortController().signal },
      ).catch(() => undefined);
      await completeImport(false, (error as Error).message).catch(() => undefined);
      throw error;
    } finally {
      await this.setBrowserRunning(computer, true, {
        ...context,
        signal: new AbortController().signal,
      });
    }
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/stop`,
      { method: "POST" },
      context.signal,
    );
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}`,
      { method: "DELETE" },
      context.signal,
    );
  }

  async keepAlive(): Promise<void> {}

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const response = await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/screen/session`,
      {
        method: "POST",
        body: JSON.stringify({
          ...request,
          screenKey: "primary",
          screenLeaseId: context.screenLeaseId,
        }),
      },
      context.signal,
    );
    const session = (await response.json()) as {
      viewerPath: string;
      wsPath: string;
      capability: string;
      screenKey: string;
      generation: number;
      interactive: boolean;
    };
    this.latestScreenCapability.set(computer.providerRef, session.capability);
    const url = new URL(session.viewerPath, `${this.apiUrl}/`);
    url.searchParams.set("wsPath", session.wsPath);
    url.searchParams.set("capability", session.capability);
    url.searchParams.set("screenKey", session.screenKey);
    url.searchParams.set("generation", String(session.generation));
    url.searchParams.set("interactive", String(session.interactive));
    return {
      url: url.toString(),
      mimeType: "text/html",
      close: async () => {
        await this.request(
          `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/screen/session`,
          {
            method: "DELETE",
            body: JSON.stringify({ screenKey: session.screenKey, capability: session.capability }),
          },
          new AbortController().signal,
        ).then(() => undefined);
        if (this.latestScreenCapability.get(computer.providerRef) === session.capability) {
          this.latestScreenCapability.delete(computer.providerRef);
        }
      },
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    if (interactive && !controlToken)
      throw new Error("interactive screen requires a control token");
    await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/screen/control`,
      {
        method: "POST",
        body: JSON.stringify({
          screenKey: "primary",
          interactive,
          controlToken,
          screenLeaseId: context.screenLeaseId,
        }),
      },
      context.signal,
    ).then(() => undefined);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    this.latestLease.set(computer.providerRef, lease);
    await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/screen/input`,
      { method: "POST", body: JSON.stringify({ input, lease, screenKey: "primary" }) },
      context.signal,
    );
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const response = await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/screen/observe`,
      {},
      context.signal,
    );
    const image = new Uint8Array(await response.arrayBuffer());
    const capturedAt = new Date().toISOString();
    return {
      frameId: `${computer.providerRef}:${capturedAt}`,
      capturedAt,
      mimeType: "image/png",
      image,
      width: Number(response.headers.get("x-xcloud-screen-width") ?? 0),
      height: Number(response.headers.get("x-xcloud-screen-height") ?? 0),
    };
  }

  async act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult> {
    const lease = this.latestLease.get(computer.providerRef);
    let completed = 0;
    for (const action of request.actions) {
      if (context.signal.aborted)
        throw context.signal.reason ?? new Error("computer action aborted");
      if (action.kind === "wait") {
        await sleep(Math.max(0, Math.min(action.ms, 5_000)), context.signal);
      } else if (action.kind === "open") {
        const result = await this.collect(
          computer,
          { argv: ["/usr/bin/open", action.path] },
          context,
        );
        if (result.code !== 0) throw new Error(result.stderr || `open exited ${result.code}`);
      } else if (action.kind === "launch") {
        const argv = [
          "/usr/bin/open",
          "-a",
          action.application,
          ...(action.uri ? [action.uri] : []),
        ];
        const result = await this.collect(computer, { argv }, context);
        if (result.code !== 0) throw new Error(result.stderr || `launch exited ${result.code}`);
      } else {
        if (!lease) throw new Error("sendInput must establish a control lease before act");
        await this.request(
          `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/screen/input`,
          { method: "POST", body: JSON.stringify({ input: action, lease, screenKey: "primary" }) },
          context.signal,
        );
      }
      completed += 1;
    }
    if (request.settleMs)
      await sleep(Math.max(0, Math.min(request.settleMs, 5_000)), context.signal);
    return {
      completed,
      ...(request.observe === false ? {} : { observation: await this.observe(computer, context) }),
    };
  }

  async snapshot(computer: ComputerRef, context: AdapterContext): Promise<SnapshotRef> {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const capability = this.latestScreenCapability.get(computer.providerRef);
    if (!context.screenLeaseId && !capability) return;
    await this.request(
      `/v1/xcloud/computers/${encodeURIComponent(computer.providerRef)}/screen/session`,
      {
        method: "DELETE",
        body: JSON.stringify({
          screenKey: "primary",
          screenLeaseId: context.screenLeaseId,
          capability,
        }),
      },
      context.signal,
    ).then(() => undefined);
    this.latestScreenCapability.delete(computer.providerRef);
  }
}
