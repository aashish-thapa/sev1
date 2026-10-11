import type { Level } from "../../domain/career.ts";
import { isPro, isReleasedFor, type Entitlements } from "../../domain/entitlements.ts";
import type { Role } from "../../domain/incident.ts";
import type { Random } from "../../domain/random.ts";
import type { Scenario } from "../scenario.ts";
import { addressAutocomplete500s } from "./address-autocomplete-500s.ts";
import { androidStagedRollout500s } from "./android-staged-rollout-500s.ts";
import { botFloodSingleIp } from "./bot-flood-single-ip.ts";
import { cardTestingSoar } from "./card-testing-soar.ts";
import { checkoutMeltdown } from "./checkout-meltdown.ts";
import { checkoutPoolLeak } from "./checkout-pool-leak.ts";
import { deadKillSwitch } from "./dead-kill-switch.ts";
import { crashOnCheckout } from "./crash-on-checkout.ts";
import { credentialStuffingHosting } from "./credential-stuffing-hosting.ts";
import { forcedUpdateWall } from "./forced-update-wall.ts";
import { fraudModelRegression } from "./fraud-model-regression.ts";
import { fraudThresholdFailOpen } from "./fraud-threshold-fail-open.ts";
import { iosRetryConfig } from "./ios-retry-config.ts";
import { oomAfterDeploy } from "./oom-after-deploy.ts";
import { ordersIndexInvalid } from "./orders-index-invalid.ts";
import { pinnedCertRotation } from "./pinned-cert-rotation.ts";
import { refundDoubleCharges } from "./refund-double-charges.ts";
import { residentialProxyStuffing } from "./residential-proxy-stuffing.ts";
import { scaledToZero } from "./scaled-to-zero.ts";
import { staleFraudFeatures } from "./stale-fraud-features.ts";
import { staleServiceWorker } from "./stale-service-worker.ts";
import { webAutoRetryStorm } from "./web-auto-retry-storm.ts";
import { INFRA_TIER1_INCIDENTS } from "./infra-tier1-incidents.ts";
import { INFRA_TIER2_INCIDENTS } from "./infra-tier2-incidents.ts";
import { INFRA_TIER3_INCIDENTS } from "./infra-tier3-incidents.ts";
import { INFRA_TIER4_INCIDENTS } from "./infra-tier4-incidents.ts";
import { FRONTEND_TIER1_INCIDENTS } from "./frontend-tier1-incidents.ts";
import { FRONTEND_TIER2_INCIDENTS } from "./frontend-tier2-incidents.ts";
import { FRONTEND_TIER3_INCIDENTS } from "./frontend-tier3-incidents.ts";
import { FRONTEND_TIER4_INCIDENTS } from "./frontend-tier4-incidents.ts";
import { MOBILE_TIER1_INCIDENTS } from "./mobile-tier1-incidents.ts";
import { MOBILE_TIER2_INCIDENTS } from "./mobile-tier2-incidents.ts";
import { MOBILE_TIER3_INCIDENTS } from "./mobile-tier3-incidents.ts";
import { MOBILE_TIER4_INCIDENTS } from "./mobile-tier4-incidents.ts";
import { SECURITY_TIER1_INCIDENTS } from "./security-tier1-incidents.ts";
import { SECURITY_TIER2_INCIDENTS } from "./security-tier2-incidents.ts";
import { SECURITY_TIER3_INCIDENTS } from "./security-tier3-incidents.ts";
import { SECURITY_TIER4_INCIDENTS } from "./security-tier4-incidents.ts";
import { DATA_TIER1_INCIDENTS } from "./data-tier1-incidents.ts";
import { DATA_TIER2_INCIDENTS } from "./data-tier2-incidents.ts";
import { DATA_TIER3_INCIDENTS } from "./data-tier3-incidents.ts";
import { DATA_TIER4_INCIDENTS } from "./data-tier4-incidents.ts";

/** Every live incident the game ships; the app and the room server read this one list. */
export const SCENARIOS: readonly Scenario[] = [
  scaledToZero,
  crashOnCheckout,
  oomAfterDeploy,
  checkoutPoolLeak,
  ordersIndexInvalid,
  checkoutMeltdown,
  webAutoRetryStorm,
  addressAutocomplete500s,
  deadKillSwitch,
  staleServiceWorker,
  iosRetryConfig,
  androidStagedRollout500s,
  forcedUpdateWall,
  pinnedCertRotation,
  botFloodSingleIp,
  credentialStuffingHosting,
  cardTestingSoar,
  residentialProxyStuffing,
  refundDoubleCharges,
  fraudModelRegression,
  fraudThresholdFailOpen,
  staleFraudFeatures,
  ...INFRA_TIER1_INCIDENTS,
  ...INFRA_TIER2_INCIDENTS,
  ...INFRA_TIER3_INCIDENTS,
  ...INFRA_TIER4_INCIDENTS,
  ...FRONTEND_TIER1_INCIDENTS,
  ...FRONTEND_TIER2_INCIDENTS,
  ...FRONTEND_TIER3_INCIDENTS,
  ...FRONTEND_TIER4_INCIDENTS,
  ...MOBILE_TIER1_INCIDENTS,
  ...MOBILE_TIER2_INCIDENTS,
  ...MOBILE_TIER3_INCIDENTS,
  ...MOBILE_TIER4_INCIDENTS,
  ...SECURITY_TIER1_INCIDENTS,
  ...SECURITY_TIER2_INCIDENTS,
  ...SECURITY_TIER3_INCIDENTS,
  ...SECURITY_TIER4_INCIDENTS,
  ...DATA_TIER1_INCIDENTS,
  ...DATA_TIER2_INCIDENTS,
  ...DATA_TIER3_INCIDENTS,
  ...DATA_TIER4_INCIDENTS,
];

/** Each role's own War Rooms, easiest first. A role's ladder grows as its incidents are written. */
const LADDERS: Readonly<Record<Role, readonly Scenario[]>> = {
  infrastructure: [
    scaledToZero, crashOnCheckout, ...INFRA_TIER1_INCIDENTS,
    oomAfterDeploy, ...INFRA_TIER2_INCIDENTS,
    checkoutPoolLeak, ...INFRA_TIER3_INCIDENTS,
    ordersIndexInvalid, ...INFRA_TIER4_INCIDENTS,
  ],
  frontend: [
    webAutoRetryStorm, ...FRONTEND_TIER1_INCIDENTS,
    addressAutocomplete500s, ...FRONTEND_TIER2_INCIDENTS,
    deadKillSwitch, ...FRONTEND_TIER3_INCIDENTS,
    staleServiceWorker, ...FRONTEND_TIER4_INCIDENTS,
  ],
  mobile: [
    iosRetryConfig, ...MOBILE_TIER1_INCIDENTS,
    androidStagedRollout500s, ...MOBILE_TIER2_INCIDENTS,
    forcedUpdateWall, ...MOBILE_TIER3_INCIDENTS,
    pinnedCertRotation, ...MOBILE_TIER4_INCIDENTS,
  ],
  security: [
    botFloodSingleIp, ...SECURITY_TIER1_INCIDENTS,
    credentialStuffingHosting, ...SECURITY_TIER2_INCIDENTS,
    cardTestingSoar, ...SECURITY_TIER3_INCIDENTS,
    residentialProxyStuffing, ...SECURITY_TIER4_INCIDENTS,
  ],
  data: [
    refundDoubleCharges, ...DATA_TIER1_INCIDENTS,
    fraudModelRegression, ...DATA_TIER2_INCIDENTS,
    fraudThresholdFailOpen, ...DATA_TIER3_INCIDENTS,
    staleFraudFeatures, ...DATA_TIER4_INCIDENTS,
  ],
};

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/** A War Room opens at the career level one below its tier: interns get tier 1, staff everything. */
export function isUnlocked(scenario: Scenario, level: Level): boolean {
  return scenario.tier <= level + 1;
}

/** A role's ladder and the cross-team incident, easiest first. */
function warRoomsFor(role: Role): readonly Scenario[] {
  return [...LADDERS[role], checkoutMeltdown];
}

/**
 * Solo War Rooms a player of `role` at `level` may play, hardest first, for a replay picker. When
 * the level unlocks none of them (a ladder still empty, or one whose easiest rung is out of reach),
 * the cross-team incident stands in at any level, so solo play always has an incident.
 */
export function unlockedWarRooms(role: Role, level: Level): readonly Scenario[] {
  const unlocked = warRoomsFor(role).filter((scenario) => isUnlocked(scenario, level)).toReversed();
  return unlocked.length > 0 ? unlocked : [checkoutMeltdown];
}

/**
 * The incident that pages a solo player of `role` at career `level`. `rotation` (e.g. War Rooms
 * played so far) cycles through everything unlocked, hardest first, so new incidents arrive with a
 * promotion and the easier ones keep coming back as practice.
 */
export function soloScenarioFor(role: Role, rotation = 0, level: Level = 0): Scenario {
  const pool = unlockedWarRooms(role, level);
  const turn = ((Math.trunc(rotation) % pool.length) + pool.length) % pool.length;
  return pool[turn];
}

/**
 * The incident for a random match: one of the role's own War Rooms at the hardest tier the player
 * has unlocked, never the cross-team one. Null when the role's ladder has nothing open yet.
 */
export function randomMatchScenario(role: Role, level: Level, random: Random): Scenario | null {
  const open = LADDERS[role].filter((scenario) => isUnlocked(scenario, level));
  const hardest = Math.max(...open.map((scenario) => scenario.tier));
  const pool = open.filter((scenario) => scenario.tier === hardest);
  return pool[Math.floor(random() * pool.length)] ?? null;
}

/** The cross-team incident: every room may play it, and a new room starts on it. */
export const TEAM_SCENARIO = checkoutMeltdown;

/** War Rooms a host may open a room on: the cross-team incident first, whatever their level, then what they've unlocked. */
export function roomWarRooms(role: Role, level: Level): readonly Scenario[] {
  return [TEAM_SCENARIO, ...unlockedWarRooms(role, level).filter((scenario) => scenario !== TEAM_SCENARIO)];
}

/**
 * War Rooms a player may pick to practice (no pay, no experience): whatever their level unlocked,
 * and with Pro every released War Room for their role, hardest first.
 */
export function practiceWarRooms(role: Role, level: Level, entitlements: Entitlements | null, now: number): readonly Scenario[] {
  const pool = isPro(entitlements, now) ? warRoomsFor(role).toReversed() : unlockedWarRooms(role, level);
  return pool.filter((scenario) => isReleasedFor(scenario.releasedAt, entitlements, now));
}
