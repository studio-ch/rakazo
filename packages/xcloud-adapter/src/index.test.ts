import { describe, expect, it, vi } from "vitest";
import { type AdapterContext, type ComputerRef, XcloudSandboxProvider } from "./index.js";

const computer: ComputerRef = {
  id: "computer-1",
  botId: "team-computer",
  kind: "xcloud",
  providerRef: "computer-1",
};

function context(): AdapterContext {
  return {
    operationId: "op-1",
    traceId: "trace-1",
    spaceId: "workspace-1",
    userId: "user-1",
    screenLeaseId: "screen-lease-1",
    signal: new AbortController().signal,
  };
}

function config(fetcher: typeof fetch) {
  return {
    apiUrl: "https://cloud.example",
    serviceToken: "sk_live_secret",
    regionId: "00000000-0000-4000-8000-000000000001",
    flavorSlug: "mac.small",
    imageRef: "golden-gate",
    fetch: fetcher,
  };
}

const dto = {
  id: "computer-1",
  botId: "team-computer",
  providerRef: "computer-1",
  fresh: false,
  state: "running",
  workspaceRoot: "/Users/admin/rakazo-home",
  instanceId: "instance-1",
  agentStatus: "healthy",
  platform: "macos",
  error: null,
};

describe("XcloudSandboxProvider", () => {
  it("declares the stage-four macOS capabilities and pins the Rakazo contract", () => {
    const provider = new XcloudSandboxProvider(config(vi.fn()));
    expect(provider.describe()).toMatchObject({
      id: "xcloud",
      contractVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: false,
      },
    });
  });

  it.each([
    { spaceId: "workspace-1" },
    { workspaceId: "workspace-1" },
    { spaceId: "workspace-1", workspaceId: "legacy-workspace" },
  ])("provisions with namespace %j and preserves fresh", async (namespace) => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        externalComputerKey: "team-computer",
        workspaceId: "workspace-1",
        flavorSlug: "mac.small",
        imageRef: "golden-gate",
      });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_live_secret");
      return Response.json({ ...dto, fresh: true }, { status: 201 });
    });
    const provider = new XcloudSandboxProvider(config(fetcher));
    await expect(
      provider.provision({ botId: "team-computer", homePath: "/ignored" }, {
        ...context(),
        spaceId: undefined,
        ...namespace,
      } as AdapterContext),
    ).resolves.toEqual({ ...computer, fresh: true });
  });

  it("maps the agent NDJSON stream to Rakazo ProcessEvents and confines cwd", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/xcloud/computers/computer-1")) return Response.json(dto);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ cwd: "notes", home: "/Users/admin/rakazo-home" });
      return new Response(
        [
          JSON.stringify({ stream: "stdout", data: Buffer.from("ok\n").toString("base64") }),
          JSON.stringify({ stream: "stderr", data: Buffer.from("warn\n").toString("base64") }),
          JSON.stringify({ exit: { code: 7, timedOut: false, error: "" } }),
          "",
        ].join("\n"),
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    });
    const provider = new XcloudSandboxProvider(config(fetcher));
    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["test"], cwd: "notes" },
      context(),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "ok\n" },
      { type: "stderr", data: "warn\n" },
      { type: "exit", code: 7 },
    ]);
  });

  it("creates a missing workspace from its existing parent directory", async () => {
    const execBodies: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/v1/xcloud/computers/computer-1")) {
        return Response.json(dto);
      }
      execBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        `${JSON.stringify({ exit: { code: 0, timedOut: false, error: "" } })}\n`,
        {
          headers: { "Content-Type": "application/x-ndjson" },
        },
      );
    });
    const provider = new XcloudSandboxProvider(config(fetcher));

    await provider.prepare(computer, context());

    expect(execBodies).toEqual([
      {
        argv: ["/bin/mkdir", "-p", "--", "/Users/admin/rakazo-home"],
        timeoutMs: 60_000,
        home: "/Users/admin",
      },
    ]);
  });

  it("surfaces a pre-stream agent error before the synthetic exit event", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/v1/xcloud/computers/computer-1")) {
        return Response.json(dto);
      }
      return new Response(
        `${JSON.stringify({ exit: { code: -1, timedOut: false, error: "agent transport unavailable" } })}\n`,
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    });
    const provider = new XcloudSandboxProvider(config(fetcher));
    const events = [];
    for await (const event of provider.execute(computer, { argv: ["/bin/true"] }, context())) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stderr", data: "agent transport unavailable\n" },
      { type: "exit", code: -1 },
    ]);
  });

  it("returns a capability-backed noVNC URL and revokes it on close", async () => {
    const methods: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      methods.push(init?.method ?? "GET");
      expect(String(input)).toContain("/screen/session");
      if (init?.method === "DELETE") {
        expect(JSON.parse(String(init.body))).toEqual({
          screenKey: "primary",
          capability: "capability",
        });
        return new Response(null, { status: 204 });
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({
        screenKey: "primary",
        screenLeaseId: "screen-lease-1",
      });
      return Response.json({
        viewerPath: "/v1/xcloud/computers/computer-1/screen/viewer",
        wsPath: "/v1/xcloud/computers/computer-1/screen/ws",
        capability: "capability",
        screenKey: "primary",
        generation: 4,
        interactive: false,
      });
    });
    const provider = new XcloudSandboxProvider(config(fetcher));
    const session = await provider.connectScreen(computer, { view: "stream" }, context());
    expect(session.mimeType).toBe("text/html");
    expect(session.url).toContain("/screen/viewer?");
    expect(session.url).toContain("generation=4");
    expect(session.url).not.toContain("password");
    await session.close();
    expect(methods).toEqual(["POST", "DELETE"]);
  });

  it("changes screen control without creating a second viewer session", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain("/screen/control");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        screenKey: "primary",
        interactive: true,
        controlToken: "control-token-1234",
        screenLeaseId: "screen-lease-1",
      });
      return new Response(null, { status: 204 });
    });
    const provider = new XcloudSandboxProvider(config(fetcher));
    await provider.setScreenControl(computer, true, context(), "control-token-1234");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
