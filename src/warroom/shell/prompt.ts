import type { Role } from "../../domain/incident.ts";

/** Infra works from the prod bastion; everyone else from their own laptop with their team's tools. */
export function hostFor(role: Role): string {
  return role === "infrastructure" ? "prod-bastion" : `${role}-laptop`;
}

export function promptFor(role: Role): string {
  return `oncall@${hostFor(role)}:~$`;
}
