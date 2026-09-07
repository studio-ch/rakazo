import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../.github/workflows/upstream-sync.yml"),
    "utf8",
  ),
) as { jobs: { sync: { steps: Array<{ id?: string; run?: string }> } } };
const script = workflow.jobs.sync.steps.find((step) => step.id === "merge")?.run;

function runSync(mode: "open" | "current" | "conflict" | "merge") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "upstream-sync-test-"));
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
      gh() {
        echo "gh $*" >> "$CALLS"
        if [[ "$1 $2" == "pr list" ]]; then
          if [[ "$MODE" == open ]]; then echo https://example.invalid/pull/1; fi
        fi
      }
      git() {
        echo "git $*" >> "$CALLS"
        case "$1" in
          merge-base) [[ "$MODE" == current ]];;
          merge) [[ "$2" == --abort || "$MODE" != conflict ]];;
          diff) echo packages/example.ts;;
          rev-parse) echo 0123456789abcdef;;
        esac
      }
      ${script}
    `,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MODE: mode,
          CALLS: path.join(dir, "calls"),
          GITHUB_OUTPUT: path.join(dir, "output"),
          GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
        },
      },
    );
    const read = (name: string) => {
      try {
        return readFileSync(path.join(dir, name), "utf8");
      } catch {
        return "";
      }
    };
    return {
      status: result.status,
      calls: read("calls"),
      output: read("output"),
      summary: read("summary"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("upstream sync workflow", () => {
  it("preserves an open compatibility PR without touching git", () => {
    const result = runSync("open");
    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("git ");
    expect(result.output).toContain("changed=false");
    expect(result.summary).toContain("https://example.invalid/pull/1");
  });

  it("does nothing when main already contains upstream", () => {
    const result = runSync("current");
    expect(result.status).toBe(0);
    expect(result.output).toContain("changed=false");
    expect(result.calls).not.toContain("git push");
  });

  it("reports conflicts and aborts without publishing partial work", () => {
    const result = runSync("conflict");
    expect(result.status).toBe(1);
    expect(result.summary).toContain("packages/example.ts");
    expect(result.calls).toContain("git merge --abort");
    expect(result.calls).not.toContain("git push");
    expect(result.calls).not.toContain("gh pr create");
  });

  it("publishes a successful merge for compatibility review", () => {
    const result = runSync("merge");
    expect(result.status).toBe(0);
    expect(result.output).toContain("changed=true");
    expect(result.calls).toContain(
      "git push --force-with-lease origin automation/xcloud-upstream-sync",
    );
    expect(result.calls).toContain("gh pr create");
  });
});
