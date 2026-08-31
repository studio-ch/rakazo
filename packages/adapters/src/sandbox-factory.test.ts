import { describe, expect, it } from "vitest";
import { NO_SANDBOX_MESSAGE } from "./none-sandbox.js";
import { createSandboxProvider } from "./sandbox-factory.js";

const ctx = {
  operationId: "op",
  traceId: "tr",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", () => {
    const sandbox = createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("returns none when requested or when the kind is empty", async () => {
    expect(createSandboxProvider("none", {}).describe().id).toBe("none");
    expect(createSandboxProvider("", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("none", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(NO_SANDBOX_MESSAGE);
  });

  it("returns provider-specific managed sandbox emulators", () => {
    expect(createSandboxProvider("e2b-emulator", {}).describe().id).toBe("e2b-emulator");
    expect(createSandboxProvider("daytona-emulator", {}).describe().id).toBe("daytona-emulator");
    expect(createSandboxProvider("box-emulator", {}).describe()).toMatchObject({
      id: "box-emulator",
      capabilities: { multiScreen: false },
    });
  });

  it("boots without a remote key and keeps computers unavailable", async () => {
    expect(createSandboxProvider("e2b", {}).describe().id).toBe("none");
    expect(createSandboxProvider("daytona", {}).describe().id).toBe("none");
    expect(createSandboxProvider("box", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("e2b", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/E2B_API_KEY/);
    expect(createSandboxProvider("box", { boxApiKey: "test-box-key" }).describe().id).toBe("box");
  });

  it("constructs Xcloud only with the complete runtime configuration", async () => {
    const missing = createSandboxProvider("xcloud", {});
    expect(missing.describe().id).toBe("none");
    await expect(missing.provision({ botId: "b", homePath: "/tmp" }, ctx)).rejects.toThrow(
      /XCLOUD_API_URL/,
    );

    const xcloud = createSandboxProvider("xcloud", {
      xcloudApiUrl: "https://api.xcloud.invalid",
      xcloudServiceToken: "test-service-token",
      xcloudRegionId: "region-test",
      xcloudFlavorSlug: "mac.small",
      xcloudImageRef: "tahoe-test",
    });
    expect(xcloud.describe()).toMatchObject({
      id: "xcloud",
      capabilities: { graphical: true, pty: false, multiScreen: false },
    });
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use none | docker | e2b | daytona | box | xcloud | e2b-emulator | daytona-emulator | box-emulator | desktop | fake.',
    );
  });
});
