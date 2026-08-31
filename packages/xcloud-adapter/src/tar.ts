import type { PortableFile } from "./contract.js";

export interface WorkspaceLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxPathBytes: number;
}

const BLOCK = 512;

function stringField(block: Uint8Array, offset: number, length: number): string {
  const end = block.indexOf(0, offset);
  const limit = end >= offset && end < offset + length ? end : offset + length;
  return Buffer.from(block.subarray(offset, limit)).toString("utf8");
}

function octalField(block: Uint8Array, offset: number, length: number): number {
  const raw = stringField(block, offset, length).trim().replace(/\0/g, "");
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar number: ${raw}`);
  return value;
}

function normalizeTarPath(value: string, limits: WorkspaceLimits): string {
  const stripped = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!stripped || stripped.startsWith("/") || stripped.includes("\0")) {
    throw new Error(`invalid workspace path in tar: ${JSON.stringify(value)}`);
  }
  const parts = stripped.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`workspace path escapes its root: ${value}`);
  }
  if (Buffer.byteLength(stripped) > limits.maxPathBytes) {
    throw new Error(`workspace path exceeds ${limits.maxPathBytes} bytes`);
  }
  return stripped;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  let cursor = 0;
  while (cursor < data.length) {
    const space = data.indexOf(0x20, cursor);
    if (space < 0) throw new Error("invalid pax header");
    const length = Number.parseInt(Buffer.from(data.subarray(cursor, space)).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > data.length) {
      throw new Error("invalid pax record length");
    }
    const line = Buffer.from(data.subarray(space + 1, cursor + length - 1)).toString("utf8");
    const equals = line.indexOf("=");
    if (equals > 0) result[line.slice(0, equals)] = line.slice(equals + 1);
    cursor += length;
  }
  return result;
}

/** Incremental ustar/pax reader. It buffers at most one declared file. */
export async function* decodeTar(
  chunks: AsyncIterable<Uint8Array>,
  limits: WorkspaceLimits,
  signal: AbortSignal,
): AsyncIterable<PortableFile> {
  let buffer = Buffer.alloc(0);
  let pendingPax: Record<string, string> = {};
  let pendingLongPath: string | null = null;
  let files = 0;
  let total = 0;

  const append = (chunk: Uint8Array) => {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
  };

  for await (const chunk of chunks) {
    if (signal.aborted) throw signal.reason ?? new Error("workspace export aborted");
    append(chunk);
    while (buffer.length >= BLOCK) {
      const header = buffer.subarray(0, BLOCK);
      if (header.every((byte) => byte === 0)) {
        // A valid tar stream ends with two zero blocks. Waiting for both is
        // important for streamed workspace exports: an upstream command that
        // fails before writing stdout otherwise looks exactly like a valid,
        // empty workspace to the adapter.
        if (buffer.length < BLOCK * 2) break;
        const second = buffer.subarray(BLOCK, BLOCK * 2);
        if (!second.every((byte) => byte === 0)) {
          throw new Error("invalid tar end marker");
        }
        return;
      }
      const expectedChecksum = octalField(header, 148, 8);
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      const actualChecksum = [...checksumHeader].reduce((sum, byte) => sum + byte, 0);
      if (expectedChecksum !== actualChecksum) throw new Error("invalid tar header checksum");
      const size = octalField(header, 124, 12);
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (buffer.length < BLOCK + padded) break;

      const type = String.fromCharCode(header[156] ?? 0);
      const body = buffer.subarray(BLOCK, BLOCK + size);
      buffer = buffer.subarray(BLOCK + padded);

      const headerName = stringField(header, 0, 100);
      const prefix = stringField(header, 345, 155);
      const rawPath =
        pendingPax.path ?? pendingLongPath ?? (prefix ? `${prefix}/${headerName}` : headerName);

      if (type === "x" || type === "g") {
        pendingPax = { ...pendingPax, ...parsePax(body) };
        continue;
      }
      if (type === "L") {
        pendingLongPath = Buffer.from(body).toString("utf8").replace(/\0+$/, "");
        continue;
      }
      if (type === "1" || type === "2" || type === "3" || type === "4" || type === "6") {
        throw new Error(`unsupported tar entry type ${type} for ${rawPath}`);
      }
      if (type === "5") {
        pendingPax = {};
        pendingLongPath = null;
        continue;
      }
      if (type !== "0" && type !== "\0") {
        throw new Error(`unsupported tar entry type ${JSON.stringify(type)} for ${rawPath}`);
      }

      const path = normalizeTarPath(rawPath, limits);
      if (size > limits.maxFileBytes) {
        throw new Error(`${path} exceeds the ${limits.maxFileBytes}-byte file limit`);
      }
      files += 1;
      total += size;
      if (files > limits.maxFiles) throw new Error(`workspace exceeds ${limits.maxFiles} files`);
      if (total > limits.maxTotalBytes) {
        throw new Error(`workspace exceeds the ${limits.maxTotalBytes}-byte total limit`);
      }
      const mode = octalField(header, 100, 8);
      const content = Uint8Array.from(body);
      yield { path, content, ...(mode & 0o111 ? { executable: true } : {}) };
      pendingPax = {};
      pendingLongPath = null;
    }
  }
  throw new Error("truncated tar stream");
}
