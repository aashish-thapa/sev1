/**
 * What a company can be and buy. Prices sit against job-mode pay: an intern earns $24 an hour and a
 * good day of shifts a few hundred dollars, so founding takes a few days' earnings and a server
 * room a couple of good work days. All amounts are cents.
 */
import type { Role } from "../incident.ts";

export const CATEGORY_IDS = ["ecommerce", "fintech", "social", "saas"] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export type Category = {
  readonly id: CategoryId;
  readonly title: string;
  readonly pitch: string;
  /** What a healthy, fully served work day brings in before shipped work raises it. */
  readonly baseRevenueCents: number;
  /** Requests a second the product needs served; servers short of it lose revenue. */
  readonly demandRps: number;
  /** Roles the product leans on; with nobody in one, its issues need a contractor. */
  readonly keyRoles: readonly Role[];
};

export const CATEGORIES: readonly Category[] = [
  {
    id: "ecommerce",
    title: "E-commerce",
    pitch: "A shop: checkout, payments, orders, and the sales that break them.",
    baseRevenueCents: 150_000,
    demandRps: 300,
    keyRoles: ["infrastructure", "frontend", "mobile", "data"],
  },
  {
    id: "fintech",
    title: "Fintech",
    pitch: "Money movement: ledgers, card payments, fraud, and auditors who read everything.",
    baseRevenueCents: 200_000,
    demandRps: 200,
    keyRoles: ["infrastructure", "security", "data"],
  },
  {
    id: "social",
    title: "Social app",
    pitch: "A consumer app: feeds, notifications, mobile releases, and traffic that spikes.",
    baseRevenueCents: 120_000,
    demandRps: 600,
    keyRoles: ["infrastructure", "frontend", "mobile"],
  },
  {
    id: "saas",
    title: "B2B SaaS",
    pitch: "Software for businesses: APIs, tenants, uptime promises in every contract.",
    baseRevenueCents: 180_000,
    demandRps: 250,
    keyRoles: ["infrastructure", "frontend", "security", "data"],
  },
];

/** The least a member in each role may be paid per work day. Offers below it are refused. */
export const ROLE_MINIMUM_PAY_CENTS: Readonly<Record<Role, number>> = {
  infrastructure: 12_000,
  frontend: 10_000,
  mobile: 10_000,
  security: 12_000,
  data: 11_000,
};

export const ROOM_KIND_IDS = ["bay", "server-room"] as const;
export type RoomKindId = (typeof ROOM_KIND_IDS)[number];

export type RoomKind = {
  readonly id: RoomKindId;
  readonly title: string;
  readonly costCents: number;
  /** Paid every work day the company owns it. */
  readonly upkeepCents: number;
  /** Desks it adds; members (founder included) can't outnumber desks. */
  readonly seats: number;
  /** Server racks it adds; servers need a rack each. */
  readonly racks: number;
};

export const ROOM_KINDS: readonly RoomKind[] = [
  { id: "bay", title: "Open-plan bay", costCents: 80_000, upkeepCents: 2_000, seats: 4, racks: 0 },
  { id: "server-room", title: "Server room", costCents: 150_000, upkeepCents: 5_000, seats: 0, racks: 4 },
];

export const SERVER_TIER_IDS = ["small", "medium", "large"] as const;
export type ServerTierId = (typeof SERVER_TIER_IDS)[number];

export type ServerTier = {
  readonly id: ServerTierId;
  readonly title: string;
  readonly costCents: number;
  readonly upkeepCents: number;
  /** Requests a second it can serve. */
  readonly capacityRps: number;
};

export const SERVER_TIERS: readonly ServerTier[] = [
  { id: "small", title: "Small server", costCents: 30_000, upkeepCents: 500, capacityRps: 100 },
  { id: "medium", title: "Medium server", costCents: 90_000, upkeepCents: 1_200, capacityRps: 300 },
  { id: "large", title: "Large server", costCents: 250_000, upkeepCents: 3_000, capacityRps: 900 },
];

/** Work days of the founder's own pay the seed must cover beyond the first room. */
export const FOUNDING_RUNWAY_DAYS = 7;
/** Each finished task adds this share of base revenue to the day, up to MAX_SHIPPED_BONUS. */
export const SHIPPED_TASK_BONUS = 0.05;
export const MAX_SHIPPED_BONUS = 0.5;
/** What a contractor charges to resolve one issue, by the issue's tier (1…5). */
export const CONTRACTOR_FEE_CENTS: Readonly<Record<1 | 2 | 3 | 4 | 5, number>> = { 1: 15_000, 2: 30_000, 3: 60_000, 4: 100_000, 5: 200_000 };

export const categoryById = (id: CategoryId): Category => CATEGORIES.find((category) => category.id === id) ?? CATEGORIES[0];
export const roomKindById = (id: RoomKindId): RoomKind => ROOM_KINDS.find((room) => room.id === id) ?? ROOM_KINDS[0];
export const serverTierById = (id: ServerTierId): ServerTier => SERVER_TIERS.find((tier) => tier.id === id) ?? SERVER_TIERS[0];
