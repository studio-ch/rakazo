import { describe, expect, it } from "vitest";
import { decodeTar } from "./tar.js";

function tarEntry(path: string, content: Buffer, mode = 0o644, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

async function* chunks(value: Buffer) {
  for (let offset = 0; offset < value.length; offset += 37)
    yield value.subarray(offset, offset + 37);
}

const limits = {
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
  maxFiles: 10,
  maxPathBytes: 128,
};

describe("decodeTar", () => {
  it("streams regular and executable files across arbitrary chunk boundaries", async () => {
    const archive = Buffer.concat([
      tarEntry("./notes/result.txt", Buffer.from("portable")),
      tarEntry("./bin/tool", Buffer.from([0, 255, 1, 128]), 0o755),
      Buffer.alloc(1024),
    ]);
    const files = [];
    for await (const file of decodeTar(chunks(archive), limits, new AbortController().signal)) {
      files.push(file);
    }
    expect(files).toEqual([
      { path: "notes/result.txt", content: Uint8Array.from(Buffer.from("portable")) },
      { path: "bin/tool", content: Uint8Array.from([0, 255, 1, 128]), executable: true },
    ]);
  });

  it("rejects traversal and special entries", async () => {
    const traversal = Buffer.concat([tarEntry("../secret", Buffer.from("no")), Buffer.alloc(1024)]);
    await expect(async () => {
      for await (const _file of decodeTar(
        chunks(traversal),
        limits,
        new AbortController().signal,
      )) {
        // consume
      }
    }).rejects.toThrow(/escapes/);

    const special = tarEntry("./pipe", Buffer.alloc(0), 0o644, "6");
    await expect(async () => {
      for await (const _file of decodeTar(
        chunks(Buffer.concat([special, Buffer.alloc(1024)])),
        limits,
        new AbortController().signal,
      )) {
        // consume
      }
    }).rejects.toThrow(/unsupported tar entry/);
  });

  it("rejects empty and incomplete streams instead of accepting a failed export", async () => {
    await expect(async () => {
      for await (const _file of decodeTar(
        chunks(Buffer.alloc(0)),
        limits,
        new AbortController().signal,
      )) {
        // consume
      }
    }).rejects.toThrow(/truncated tar stream/);

    await expect(async () => {
      for await (const _file of decodeTar(
        chunks(Buffer.alloc(512)),
        limits,
        new AbortController().signal,
      )) {
        // consume
      }
    }).rejects.toThrow(/truncated tar stream/);
  });

  it("enforces file, count, and total limits", async () => {
    const archive = Buffer.concat([tarEntry("./large", Buffer.alloc(1025)), Buffer.alloc(1024)]);
    await expect(async () => {
      for await (const _file of decodeTar(chunks(archive), limits, new AbortController().signal)) {
        // consume
      }
    }).rejects.toThrow(/file limit/);
  });
});
