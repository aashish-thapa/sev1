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

/** Starter commands for the chip row: how to look around, the real fix, and the tempting wrong moves. */
export function suggestionsFor(role: Role, deploymentName: string): readonly string[] {
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
      return ["rum overview", "rum session", "flags list", "flags history checkout.auto_retry", "flags set payment_element_v2 off", "flags set checkout.auto_retry off"];
    case "mobile":
      return ["releases status", "remote-config get checkout_retry_policy", "releases halt ios 7.3.0", "remote-config set checkout_retry_policy backoff"];
    case "security":
      return ["siem show SEC-4471", "siem search auth-summary", "siem search checkout-sessions", "waf top", "waf block --top 500", "siem resolve SEC-4471 --disposition benign"];
    case "data":
      return ["warehouse run revenue-vs-orders", "warehouse run orphaned-captures", "warehouse run multi-charge-carts", "reconcile submit"];
  }
}
