import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { MOUNTED_APP_DOCUMENT_READY } from "./document-readiness.js";

function ready(
  options: {
    state?: string | null;
    welcome?: boolean;
    shell?: string;
    email?: boolean;
    marks?: string[];
    text?: string;
    rootChildren?: number;
  } = {},
) {
  const { state = "ready", marks = [], text = "" } = options;
  return runInNewContext(MOUNTED_APP_DOCUMENT_READY, {
    performance: { getEntriesByName: (name: string) => (marks.includes(name) ? [{}] : []) },
    document: {
      body: { innerText: text },
      getElementById: () => ({ childElementCount: options.rootChildren ?? 0 }),
      querySelectorAll: () => [],
      querySelector: (selector: string) => {
        if (selector === "[data-rakazo-app-state]")
          return state === null ? null : { getAttribute: () => state };
        if (selector === '[data-testid="welcome-page"]') return options.welcome ? {} : null;
        if (selector === '[data-testid="shell-root"]')
          return options.shell ? { getAttribute: () => options.shell } : null;
        if (selector.startsWith("form input")) return options.email ? {} : null;
        return null;
      },
    },
  });
}

describe("mounted desktop document readiness", () => {
  it("accepts the signed-out welcome surface independently of translated copy", () => {
    expect(ready({ welcome: true, text: "Registrieren" })).toBe(true);
    expect(
      readFileSync(new URL("../../web/src/pages/Welcome.tsx", import.meta.url), "utf8"),
    ).toContain('data-testid="welcome-page"');
  });
  it("does not accept a welcome surface before the session resolves", () => {
    expect(
      ready({ welcome: true, state: "session-pending", marks: ["rk:renderer:session-committed"] }),
    ).toBe(false);
  });
  it("accepts email auth and fully bootstrapped shells", () => {
    expect(ready({ email: true })).toBe(true);
    expect(ready({ shell: "true" })).toBe(true);
  });
  it("rejects empty ready routes and unbootstrapped shells", () => {
    expect(ready()).toBe(false);
    expect(ready({ shell: "false" })).toBe(false);
  });
  it("preserves the plain fixture fallback without accepting loading shells", () => {
    expect(ready({ state: null, rootChildren: 1 })).toBe(true);
    for (const text of ["Loading…", "Loading...", "Opening your Space…"]) {
      expect(ready({ state: null, rootChildren: 1, text })).toBe(false);
    }
  });
});
