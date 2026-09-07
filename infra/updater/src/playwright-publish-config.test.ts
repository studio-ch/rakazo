// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expressions are literal workflow fixtures.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const configured = {
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-value",
  AWS_DEFAULT_REGION: "test-region",
  S3_BUCKET: "test-bucket",
  S3_ENDPOINT: "https://storage.example.invalid",
  PLAYWRIGHT_PUBLIC_BASE_URL: "https://reports.example.invalid",
};

function checkConfiguration(values: Partial<typeof configured>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "playwright-config-"));
  try {
    const output = path.join(dir, "output");
    const summary = path.join(dir, "summary");
    const result = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/check-playwright-publish-config.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...Object.fromEntries(Object.keys(configured).map((key) => [key, ""])),
          ...values,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    return {
      status: result.status,
      logs: result.stdout + result.stderr,
      output: readFileSync(output, "utf8"),
      summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Step {
  id?: string;
  name?: string;
  run?: string;
  if?: string;
}
function workflowSteps(file: string, job: string): Step[] {
  const workflow = parse(readFileSync(path.join(repoRoot, ".github/workflows", file), "utf8")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return workflow.jobs[job]?.steps ?? [];
}

describe("optional Playwright report publication", () => {
  it("skips an unconfigured gallery successfully and points to retained CI artifacts", () => {
    const result = checkConfiguration({});
    expect(result.status).toBe(0);
    expect(result.output).toBe("enabled=false\n");
    expect(result.logs).not.toContain("::warning::");
    expect(result.summary).toContain("originating CI run artifacts");
  });

  it.each(Object.keys(configured) as Array<keyof typeof configured>)(
    "does not enable publication when %s is missing or print configured values",
    (missing) => {
      const result = checkConfiguration({ ...configured, [missing]: "" });
      expect(result.status).toBe(0);
      expect(result.output).toBe("enabled=false\n");
      expect(result.logs).toContain("::warning::");
      for (const value of Object.values(configured)) {
        expect(result.logs + result.summary + result.output).not.toContain(value);
      }
    },
  );

  it("enables a fully configured gallery without exposing credentials", () => {
    const result = checkConfiguration(configured);
    expect(result.status).toBe(0);
    expect(result.output).toBe("enabled=true\n");
    expect(result.logs + result.summary).toBe("");
  });

  it("gates every report-only step before installing dependencies or downloading artifacts", () => {
    const steps = workflowSteps("publish-playwright-report.yml", "publish");
    const configIndex = steps.findIndex((step) => step.id === "report_config");
    expect(configIndex).toBe(1);
    expect(steps[configIndex]?.run).toBe("bash scripts/check-playwright-publish-config.sh");
    for (const step of steps.slice(configIndex + 1)) {
      expect(step.if, step.name ?? step.run).toContain(
        "steps.report_config.outputs.enabled == 'true'",
      );
    }
  });

  it("shares the guard with Playwright without gating tests or artifact retention", () => {
    const steps = workflowSteps("playwright.yml", "playwright");
    expect(steps.find((step) => step.id === "report_config")?.run).toBe(
      "bash scripts/check-playwright-publish-config.sh",
    );
    expect(steps.find((step) => step.name === "Run Playwright tests")?.if).toBeUndefined();
    expect(steps.find((step) => step.name === "Upload Playwright artifacts")?.if).toBe(
      "always() && inputs.upload_artifacts",
    );
  });
});
