import { describe, expect, it } from "vitest";
import { ROLE_IDS, type Role } from "../../domain/incident.ts";
import { openIncident } from "../incident.ts";
import type { Evidence, Scenario } from "../scenario.ts";
import { checkoutMeltdown } from "../scenarios/checkout-meltdown.ts";
import { completeLine, runLine } from "../shell/shell.ts";
import { suggestionsFor } from "./laptop-identity.ts";

function expectRunnable(scenario: Scenario, role: Role) {
  const cluster = openIncident(scenario).cluster;
  for (const line of suggestionsFor(scenario, role, "checkout-api")) {
    const result = runLine(line, { cluster, scenario, history: [], role });
    const firstError = result.output.find((output) => output.tone === "err")?.text ?? "";
    expect(firstError, `${role}: ${line}`).not.toMatch(/command not found|permission denied|unknown command|usage|Forbidden|403/i);
  }
}

describe("laptop suggestions", () => {
  it.each(ROLE_IDS)("every %s suggestion in the meltdown is a real command that role can run", (role) => {
    expectRunnable(checkoutMeltdown, role);
  });

  it.each(ROLE_IDS)("every everyday %s suggestion is a real command that role can run", (role) => {
    expectRunnable({ ...checkoutMeltdown, suggestions: undefined }, role);
  });

  it("offers a scenario's own chips, and only looks around without them", () => {
    expect(suggestionsFor(checkoutMeltdown, "security", "checkout-api")).toContain("waf block --top 500");
    expect(suggestionsFor({ ...checkoutMeltdown, suggestions: undefined }, "security", "checkout-api")).toEqual(["siem alerts", "waf rules", "waf top"]);
    expect(suggestionsFor({ ...checkoutMeltdown, suggestions: { security: ["siem search tls-fingerprints"] } }, "security", "checkout-api")).toEqual([
      "siem search tls-fingerprints",
    ]);
  });
});

describe("scenario evidence", () => {
  const view = (tool: Evidence["tool"], name: string, line: string): Evidence => ({ tool, name, description: `${name} for this incident`, run: () => [line] });
  const scenario: Scenario = {
    ...checkoutMeltdown,
    evidence: [
      view("siem", "tls-fingerprints", "JA4 t13d1516h2 · 61% of POST /session"),
      view("siem", "auth-summary", "login attempts / min   9,140"),
      view("rum", "autocomplete", "TypeError: address.lines is undefined"),
      view("warehouse", "declined-good-customers", "declined 1,204"),
      view("releases", "crashes", "7.3.0 · NSInvalidArgumentException"),
    ],
  };
  const cluster = openIncident(scenario).cluster;
  const shell = (role: Role, line: string) =>
    runLine(line, { cluster, scenario, history: [], role })
      .output.map((output) => output.text)
      .join("\n");
  const complete = (role: Role, line: string) => completeLine(line, { cluster, scenario, history: [], role }).line;

  it("lists and runs a scenario's own views beside each tool's built-ins", () => {
    expect(shell("security", "siem search tls-fingerprints")).toBe("JA4 t13d1516h2 · 61% of POST /session");
    expect(shell("security", "siem search checkout-sessions")).toContain("POST /checkout grouped by session");
    expect(shell("security", "siem search nope")).toContain("card-velocity, tls-fingerprints");
    expect(shell("frontend", "rum autocomplete")).toBe("TypeError: address.lines is undefined");
    expect(shell("frontend", "rum overview")).toContain("checkout-web");
    expect(shell("data", "warehouse saved")).toContain("declined-good-customers");
    expect(shell("data", "warehouse run declined-good-customers")).toBe("declined 1,204");
    expect(shell("data", "warehouse show declined-good-customers")).toBe("-- declined-good-customers for this incident");
    expect(shell("mobile", "releases crashes")).toBe("7.3.0 · NSInvalidArgumentException");
    expect(complete("security", "siem search t")).toBe("siem search tls-fingerprints ");
    expect(complete("frontend", "rum a")).toBe("rum autocomplete ");
  });

  it("replaces a built-in view that shares its name", () => {
    expect(shell("security", "siem search auth-summary")).toBe("login attempts / min   9,140");
  });

  it("stays out of tools it wasn't written for", () => {
    expect(shell("frontend", "rum tls-fingerprints")).toContain('unknown command "tls-fingerprints"');
  });
});
