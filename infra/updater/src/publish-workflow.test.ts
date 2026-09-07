import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowText = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/publish-server-image.yml"),
  "utf8",
);
interface WorkflowJob {
  steps?: Array<{ id?: string; run?: string }>;
  if?: string;
  needs?: string;
  "runs-on"?: string;
  strategy?: { matrix?: { arch?: string[]; include?: Array<Record<string, string>> } };
}

const workflow = parse(workflowText) as {
  jobs: { validate: WorkflowJob; build: WorkflowJob; publish: WorkflowJob };
};

describe("server image publish workflow", () => {
  it("uses the same Xcloud image names for validation, digest builds, and publication", () => {
    const images = {
      app: "ghcr.io/studio-ch/rakazo-xcloud",
      updater: "ghcr.io/studio-ch/rakazo-xcloud-updater",
      computer: "ghcr.io/studio-ch/rakazo-xcloud-computer",
    };
    for (const job of Object.values(workflow.jobs)) {
      if (!job.strategy) continue;
      const mapped = Object.fromEntries(
        (job.strategy.matrix?.include ?? [])
          .filter((entry) => entry.name)
          .map((entry) => [entry.name, entry.image]),
      );
      expect(mapped).toEqual(images);
    }
    expect(workflowText).toContain("name=${{ matrix.image }},push-by-digest=true");
    expect(workflowText).toContain("IMAGE: ${{ matrix.image }}");
    expect(workflowText).toContain("artifact-metadata: write");
  });

  it.each([
    ["tag", "xcloud-v1.2.3", true],
    ["tag", "xcloud-v0.0.0", true],
    ["tag", "xcloud-v1.2.3-rc.1", false],
    ["tag", "xcloud-v1.2.3-alpha.1", false],
    ["tag", "xcloud-v1.02.3", false],
    ["tag", "v1.2.3", false],
    ["branch", "xcloud-v1.2.3", false],
    ["branch", "main", false],
  ])("classifies %s %s without promoting prereleases", (refType, refName, stable) => {
    const script = workflow.jobs.publish.steps?.find((step) => step.id === "release")?.run;
    expect(script).toBeTruthy();
    const dir = mkdtempSync(path.join(os.tmpdir(), "release-tag-test-"));
    try {
      const output = path.join(dir, "output");
      execFileSync("bash", ["-eu", "-c", script ?? ""], {
        env: { ...process.env, REF_TYPE: refType, REF_NAME: refName, GITHUB_OUTPUT: output },
      });
      expect(readFileSync(output, "utf8").trim()).toBe(`stable=${stable}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds every architecture natively instead of emulating arm64", () => {
    expect(workflowText).not.toContain("setup-qemu-action");
    const build = workflow.jobs.build;
    expect(build["runs-on"]).toContain("matrix.runner");
    expect(build.strategy?.matrix?.arch).toEqual(["amd64", "arm64"]);
    const runners = Object.fromEntries(
      (build.strategy?.matrix?.include ?? [])
        .filter((entry) => entry.arch !== undefined)
        .map((entry) => [entry.arch, entry.runner]),
    );
    expect(runners).toEqual({ amd64: "ubuntu-latest", arm64: "ubuntu-24.04-arm" });
  });

  it("publishes one verified multi-arch manifest per image after both builds", () => {
    const publish = workflow.jobs.publish;
    expect(publish.needs).toBe("build");
    expect(workflowText).toContain("push-by-digest=true");
    expect(workflowText).toContain("docker buildx imagetools create");
    expect(workflowText).toContain("for want in linux/amd64 linux/arm64");
    expect(workflowText).toContain("actions/attest-build-provenance@");
  });

  it("keeps pull requests read-only and every action pinned to a commit", () => {
    const validate = workflow.jobs.validate;
    const build = workflow.jobs.build;
    const publish = workflow.jobs.publish;
    expect(validate.if).toBe("github.event_name == 'pull_request'");
    expect(build.if).toBe("github.event_name != 'pull_request'");
    expect(publish.if).toBe("github.event_name != 'pull_request'");
    expect(workflowText).toContain("push: false");
    for (const match of workflowText.matchAll(/uses:\s+([^\s#]+)/g)) {
      expect(match[1], match[1]).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
