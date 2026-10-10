import type { Role } from "./incident.ts";

export type RoleInfo = {
  readonly label: string;
  /** The room in the office that belongs to this role. */
  readonly room: string;
  readonly blurb: string;
};

export const ROLE_INFO: Record<Role, RoleInfo> = {
  infrastructure: { label: "Infra / SRE", room: "Data centre", blurb: "Pods, databases, networks — the pager is yours." },
  frontend: { label: "Frontend", room: "Web studio", blurb: "Browsers, bundles, Web Vitals, the checkout page." },
  mobile: { label: "Mobile", room: "Device lab", blurb: "iOS and Android releases, crashes, remote config." },
  security: { label: "Security", room: "SOC", blurb: "Attacks, leaked keys, the WAF — and false alarms." },
  data: { label: "Data & ML", room: "Data lab", blurb: "Pipelines, warehouses, models, the revenue numbers." },
};
