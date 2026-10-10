import type { Role } from "../../domain/incident.ts";
import { err, type OutputLine } from "./types.ts";

export const COMPANY_DOMAIN = "marlow.example";

/** SSO groups each role's on-call belongs to; in-house tools authorise against these. */
export const SSO_GROUPS: Record<Role, readonly string[]> = {
  infrastructure: ["eng-sre", "k8s-prod-operators"],
  frontend: ["eng-web", "flags-prod-writers"],
  mobile: ["eng-mobile", "remote-config-publishers", "app-store-release-managers"],
  security: ["sec-soc", "waf-admins"],
  data: ["data-eng", "payments-recon", "ml-platform"],
};

export function operatorName(role: Role): string {
  return `oncall-${role}`;
}

export function operatorEmail(role: Role): string {
  return `${operatorName(role)}@${COMPANY_DOMAIN}`;
}

/** The refusal our in-house CLIs print when the caller's SSO groups don't grant the tool. */
export function ssoRefusal(tool: string, requiredGroup: string, role: Role): readonly OutputLine[] {
  return err(
    `${tool}: 403 Forbidden: ${operatorEmail(role)} is not in ${requiredGroup}`,
    `${tool}: your groups: ${SSO_GROUPS[role].join(", ")} — ask in #access-requests`,
  );
}
