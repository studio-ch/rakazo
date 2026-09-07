/**
 * Structural subset of @rakazo/adapter-kit@0.1.0, including the spaceId
 * context introduced before upstream 6673b7b1489e1b62b1e0be34ae441637760f22c8.
 *
 * Keeping this tiny contract local lets the adapter ship independently while
 * remaining assignable to Rakazo's SandboxProvider. Retain legacy workspaceId
 * callers while translating the current spaceId to Xcloud's wire contract.
 */
interface AdapterContextBase {
  operationId: string;
  traceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  screenLeaseId?: string;
  signal: AbortSignal;
}

export type AdapterContext = AdapterContextBase &
  ({ spaceId: string; workspaceId?: string } | { spaceId?: string; workspaceId: string });

export interface AdapterDescriptor<T> {
  id: string;
  contractVersion: string;
  adapterVersion: string;
  capabilities: T;
}

export interface SandboxCapabilities {
  graphical: boolean;
  pty: boolean;
  snapshots: boolean;
  takeover: boolean;
  persistentHome: boolean;
  multiScreen?: boolean;
}

export interface ComputerRef {
  id: string;
  botId: string;
  kind: "xcloud";
  providerRef: string;
  fresh?: boolean;
}

export interface CommandRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
  timeoutMs?: number;
}

export type ProcessEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number };

export interface PortableFile {
  path: string;
  content: Uint8Array;
  executable?: boolean;
}

export interface ComputerFileEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  executable?: boolean;
}

export interface ScreenRequest {
  view: "stream" | "snapshot";
  interactive?: boolean;
  controlToken?: string;
}

export interface ScreenSession {
  url: string | null;
  mimeType: string;
  close(): Promise<void>;
}

export type ComputerInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | {
      kind: "pointer";
      x: number;
      y: number;
      button?: "left" | "right";
      type: "move" | "down" | "up" | "click";
    }
  | { kind: "clipboard"; text: string };

export interface ControlLeaseRef {
  leaseId: string;
  holder: "user" | "bot";
  fence: number;
}

export interface ComputerObservation {
  frameId: string;
  capturedAt: string;
  mimeType: "image/png" | "image/jpeg";
  image: Uint8Array;
  width: number;
  height: number;
}

export type ComputerAction =
  | ComputerInput
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "wait"; ms: number }
  | { kind: "open"; path: string }
  | { kind: "launch"; application: string; uri?: string };

export interface ComputerActionRequest {
  actions: ComputerAction[];
  observe?: boolean;
  settleMs?: number;
}

export interface ComputerActionResult {
  completed: number;
  observation?: ComputerObservation;
}

export interface SnapshotRef {
  id: string;
  createdAt: string;
}

export interface SandboxProvider {
  describe(): AdapterDescriptor<SandboxCapabilities>;
  provision(
    request: { botId: string; homePath: string; providerRef?: string; providerKind?: string },
    context: AdapterContext,
  ): Promise<ComputerRef>;
  prepare(computer: ComputerRef, context: AdapterContext): Promise<void>;
  execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent>;
  listFiles(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]>;
  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array>;
  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext): Promise<void>;
  exportWorkspace(computer: ComputerRef, context: AdapterContext): AsyncIterable<PortableFile>;
  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void>;
  connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession>;
  setScreenControl?(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void>;
  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void>;
  observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation>;
  act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult>;
  snapshot(computer: ComputerRef, context: AdapterContext): Promise<SnapshotRef>;
  keepAlive?(computer: ComputerRef): Promise<void>;
  releaseScreen?(computer: ComputerRef, context: AdapterContext): Promise<void>;
  stop(computer: ComputerRef, context: AdapterContext): Promise<void>;
  destroy(computer: ComputerRef, context: AdapterContext): Promise<void>;
}
