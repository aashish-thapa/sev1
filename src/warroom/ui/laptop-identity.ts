import type { Role } from "../../domain/incident.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import type { Scenario } from "../scenario.ts";

export { hostFor, promptFor } from "../shell/prompt.ts";

/** First lines on a freshly opened terminal: where you are, who you are, and your part in this incident. */
export function laptopBanner(scenario: Scenario, role: Role): string[] {
  const briefing = scenario.roleBriefings?.[role];
  return [
    role === "infrastructure" ? "Linux prod-bastion 6.8.0-1021-aws x86_64" : `${ROLE_INFO[role].label} laptop · SSO session active`,
    `Signed in as on-call (${ROLE_INFO[role].label}).`,
    ...(briefing ? [`Your part: ${briefing}`] : []),
    "Type help for what you can run.",
  ];
}

/**
 * Starter commands for the chip row: how to look around, the real fix, and the tempting wrong moves.
 * A scenario can list its own per role; otherwise the role gets its everyday ones, which for the
 * commerce roles only look around, so they give nothing away in an incident that isn't the meltdown.
 */
export function suggestionsFor(scenario: Scenario, role: Role, deploymentName: string): readonly string[] {
  return scenario.suggestions?.[role] ?? everydayChips(role, deploymentName);
}

function everydayChips(role: Role, deploymentName: string): readonly string[] {
  switch (role) {
    case "infrastructure":
      return [
        "kubectl get pods",
        "kubectl top pods",
        `kubectl rollout history deployment/${deploymentName}`,
        'psql -c "select state, count(*) from pg_stat_activity group by state"',
        `curl -s http://${deploymentName}:8080/actuator/health`,
        `kubectl rollout restart deployment/${deploymentName}`,
        `kubectl rollout undo deployment/${deploymentName}`,
        `kubectl scale deployment/${deploymentName} --replicas=6`,
      ];
    case "frontend":
      return ["rum overview", "rum errors", "flags list"];
    case "mobile":
      return ["releases status", "remote-config list"];
    case "security":
      return ["siem alerts", "waf rules", "waf top"];
    case "data":
      return ["warehouse saved", "warehouse tables", "reconcile status"];
  }
}
