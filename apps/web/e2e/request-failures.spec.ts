import { expect, test } from "@playwright/test";
import { isExpectedAuthCapabilitiesAbort } from "./helpers";

test("only the optional same-origin auth capability cancellation is expected", () => {
  const appUrl = "http://127.0.0.1:5180/sign-in";
  const cases = [
    ["GET", "/api/auth/capabilities", "net::ERR_ABORTED", true],
    ["GET", "/api/auth/capabilities", "net::ERR_CONNECTION_REFUSED", false],
    ["GET", "/api/auth/capabilities", "net::ERR_TIMED_OUT", false],
    ["GET", "/api/auth/capabilities", null, false],
    ["POST", "/api/auth/capabilities", "net::ERR_ABORTED", false],
    ["GET", "/api/auth/get-session", "net::ERR_ABORTED", false],
    ["POST", "/rpc/threads/stop", "net::ERR_ABORTED", false],
    ["GET", "/api/auth/capabilities?unexpected=1", "net::ERR_ABORTED", false],
    ["GET", "http://127.0.0.1:5181/api/auth/capabilities", "net::ERR_ABORTED", false],
    ["GET", "https://other.example.test/api/auth/capabilities", "net::ERR_ABORTED", false],
  ] as const;

  for (const [method, url, errorText, expected] of cases) {
    const request = {
      method: () => method,
      url: () => new URL(url, appUrl).href,
      failure: () => (errorText === null ? null : { errorText }),
    };
    expect(isExpectedAuthCapabilitiesAbort(request, appUrl), `${method} ${url} ${errorText}`).toBe(
      expected,
    );
  }
});
