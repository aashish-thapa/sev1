import { describe, expect, it } from "vitest";
import { ROLE_IDS } from "../../domain/incident.ts";
import { openIncident } from "../incident.ts";
import { checkoutMeltdown } from "../scenarios/checkout-meltdown.ts";
import { runLine } from "../shell/shell.ts";
import { suggestionsFor } from "./laptop-identity.ts";

describe("laptop suggestions", () => {
  it.each(ROLE_IDS)("every %s suggestion is a real command that role can run", (role) => {
    const cluster = openIncident(checkoutMeltdown).cluster;
    for (const line of suggestionsFor(role, "checkout-api")) {
      const result = runLine(line, { cluster, scenario: checkoutMeltdown, history: [], role });
      const firstError = result.output.find((output) => output.tone === "err")?.text ?? "";
      expect(firstError, `${role}: ${line}`).not.toMatch(/command not found|permission denied|unknown command|usage|Forbidden|403/i);
    }
  });
});
