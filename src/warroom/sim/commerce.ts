/**
 * The world around the cluster that other roles operate: the clients that decide how hard
 * they retry, the edge WAF and SIEM, the payment gateway, and the ledger of captured charges.
 * Scenarios without it run the plain cluster physics.
 */

export const RETRY_POLICY_NAMES = ["none", "immediate", "backoff"] as const;
export type RetryPolicyName = (typeof RETRY_POLICY_NAMES)[number];

export function isRetryPolicyName(value: string): value is RetryPolicyName {
  return (RETRY_POLICY_NAMES as readonly string[]).includes(value);
}

/** One recorded change to a flag or remote-config value. `at` is incident time; negative is before the page. */
export type ConfigChange<Value> = {
  readonly at: number;
  readonly by: string;
  readonly from: Value;
  readonly to: Value;
  readonly note: string;
};

type History<Value> = readonly [ConfigChange<Value>, ...ConfigChange<Value>[]];

export type FeatureFlag = {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly history: History<boolean>;
};

export type RemoteConfigEntry = {
  readonly key: string;
  readonly description: string;
  /** Which app builds fetch and apply this key. */
  readonly readBy: string;
  readonly allowed: readonly string[] | null;
  /** Published versions before the first entry in `history`. */
  readonly baseVersion: number;
  readonly history: History<string>;
};

/** Where a client build gets its checkout retry behaviour from. */
export type PolicySource =
  | { readonly kind: "fixed"; readonly policy: RetryPolicyName }
  | { readonly kind: "flag"; readonly key: string; readonly whenOn: RetryPolicyName; readonly whenOff: RetryPolicyName }
  | { readonly kind: "remote-config"; readonly key: string };

export type PlatformId = "web" | "ios" | "android";

/** When a build's defect fires: always, while a flag is on (or off), or while a remote-config key holds one value. */
export type DefectTrigger =
  | "always"
  | { readonly flag: string; readonly failsWhenOn: boolean }
  | { readonly remoteConfig: string; readonly failsWhen: string };

/** A bug shipped in a client build that fails some of its checkouts. */
export type ClientDefect = {
  readonly trigger: DefectTrigger;
  /** Share of this build's checkouts that fail while the defect fires. */
  readonly failShare: number;
  /** "server": checkout-api answers the bad request with a 5xx. "client": the checkout dies in the app or browser, before any request. */
  readonly where: "server" | "client";
  /** What the failure says where it surfaces (console, crash report, checkout-api log). */
  readonly message: string;
};

export type ClientBuild = {
  readonly version: string;
  readonly userAgent: string;
  /** How long the client waits for POST /checkout before it gives up (and, if it retries, retries). */
  readonly timeoutMs: number;
  readonly retry: PolicySource;
  readonly defects?: readonly ClientDefect[];
};

export type Rollout =
  | { readonly kind: "instant" }
  | { readonly kind: "phased"; readonly day: number; readonly isPaused: boolean; readonly adoptionPerSecond: number }
  /** A web build a service worker keeps serving from its precache; tabs move to `current` only while the kill-switch flag is on. */
  | { readonly kind: "service-worker"; readonly killSwitchFlag: string; readonly adoptionPerSecond: number };

export type Platform = {
  readonly id: PlatformId;
  /** Share of organic checkout customers on this platform. */
  readonly customerShare: number;
  readonly current: ClientBuild;
  readonly previous: ClientBuild | null;
  /** Share of this platform's sessions already on `current`. */
  readonly adoption: number;
  readonly rollout: Rollout;
  /** A build submitted to the store but not yet live; display only. */
  readonly inReview: string | null;
};

export type PaymentGateway = {
  readonly name: string;
  /** Charges per second the gateway completes for us while degraded; above it calls queue. */
  readonly chargesPerSecond: number;
  /** Queue depth, in seconds of capacity, past which the gateway sheds calls outright. */
  readonly maxQueueSeconds: number;
  /** Share of calls that exceed checkout-api's 3 s client timeout on latency alone. */
  readonly baselineTimeoutShare: number;
  readonly backlog: number;
  /** Share of calls that waited past checkout-api's timeout in the last second. */
  readonly timeoutShare: number;
};

export type WafRule = {
  readonly id: string;
  readonly action: "block" | "rate_limit";
  readonly expression: string;
  readonly createdAt: number;
  readonly createdBy: string;
  /** Share of legitimate checkout customers whose requests this rule stops. */
  readonly customerShare: number;
  /** Share of attack traffic this rule stops; absent stops none. */
  readonly attackShare?: number;
};

/** A block of attacker addresses inside one network. */
export type AttackRange = {
  readonly cidr: string;
  readonly asn: number;
  readonly network: string;
  readonly ips: number;
};

export type AttackSources =
  | { readonly kind: "ranges"; readonly ranges: readonly AttackRange[] }
  /** Spread across residential ISPs' customer addresses, so no range or ASN singles them out. */
  | { readonly kind: "residential-proxies"; readonly ips: number };

/** Hostile traffic at the edge. Individual addresses derive from the sources and a rank, never stored one by one. */
export type Attack = {
  readonly label: string;
  /** The path it hits, such as "/checkout" or "/session". */
  readonly path: string;
  readonly requestsPerSecond: number;
  readonly growthPerSecond: number;
  readonly sources: AttackSources;
  /** The TLS client fingerprint every attacking connection shares. */
  readonly ja4: string;
  readonly userAgent: string;
};

export type FraudModelVersion = {
  readonly version: string;
  readonly deployedAt: number;
  readonly note: string;
  /** Share of good customers this version declines. */
  readonly falseDeclineShare: number;
  /** Share of fraudulent checkouts this version declines. */
  readonly catchShare: number;
};

/** One model input, refreshed by a pipeline. */
export type FraudFeature = {
  readonly name: string;
  readonly pipeline: string;
  readonly lastSuccessAt: number;
  /** A refresh in flight; null when none is running. */
  readonly refresh: { readonly startedAt: number; readonly secondsLeft: number } | null;
};

/** The fraud scorer in front of the gateway: a decline is a 402 before any charge. */
export type FraudScoring = {
  readonly model: string;
  readonly versions: readonly FraudModelVersion[];
  /** `version` of the model serving now. */
  readonly active: string;
  /** Scores at or above it are declined. */
  readonly threshold: number;
  /** Where the threshold was tuned to sit. */
  readonly tunedThreshold: number;
  readonly mode: "enforce" | "fail-open";
  readonly features: readonly FraudFeature[];
  /** Extra share of good customers declined while a feature is stale. */
  readonly staleFeatureDeclineShare: number;
  readonly fraudAttemptsPerSecond: number;
};

/** App builds below the remote-config minimum get a blocking update screen and can't check out. */
export type UpdateWall = {
  /** The remote-config key naming the minimum supported version. */
  readonly configKey: string;
};

export type AlertDisposition = "benign" | "false-positive" | "true-positive";

export type SiemAlert = {
  readonly id: string;
  readonly title: string;
  readonly rule: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly openedAt: number;
  /** When the SOAR playbook blocks the top talkers unless an analyst closes the alert first. */
  readonly autoContainAt: number | null;
  readonly containTopIps: number;
  readonly resolution: { readonly disposition: AlertDisposition; readonly at: number; readonly by: string; readonly note: string } | null;
};

export type RefundBatch = {
  readonly id: string;
  readonly at: number;
  readonly by: string;
  readonly captures: number;
  readonly amountCents: number;
};

export type MinuteBucket = {
  /** `floor(t / 60)`; scenarios open on a whole minute so this lines up with the wall clock. */
  readonly minute: number;
  readonly paidOrders: number;
  readonly orphanedCaptures: number;
};

export type OrphanSplit = { readonly withKey: number; readonly withoutKey: number };

/** Counts are fluid (fractional customers per tick); round at the edge. Money stays in integer cents. */
export type Ledger = {
  readonly averageOrderCents: number;
  readonly paidOrders: number;
  /** Charges the gateway captured for a checkout that had already failed: double charges or charged-without-order. */
  readonly orphanedCaptures: number;
  /** Per client segment, split by whether the request that created the order carried an Idempotency-Key. */
  readonly orphanedBySegment: Readonly<Record<string, OrphanSplit>>;
  /** Cumulative `orphanedCaptures` per second, newest last; the warehouse reads it through CDC lag. */
  readonly orphanHistory: readonly number[];
  readonly minutes: readonly MinuteBucket[];
  readonly refundedCaptures: number;
  readonly refundBatches: readonly RefundBatch[];
  /** Charges captured for fraudsters; absent where no fraud is modelled. */
  readonly fraudulentCaptures?: number;
};

/** What the last second looked like from outside the cluster. */
export type Pulse = {
  readonly organicCheckoutsPerSecond: number;
  readonly checkoutAttemptsPerSecond: number;
  readonly blockedPerSecond: number;
  readonly gatewayCallsPerSecond: number;
  /** Share of checkout attempts that failed or timed out as the client saw it. */
  readonly checkoutFailureRate: number;
};

export type Commerce = {
  readonly platforms: readonly Platform[];
  readonly flags: readonly FeatureFlag[];
  readonly remoteConfig: readonly RemoteConfigEntry[];
  readonly gateway: PaymentGateway;
  readonly wafRules: readonly WafRule[];
  readonly nextWafRuleNumber: number;
  readonly alerts: readonly SiemAlert[];
  readonly ledger: Ledger;
  readonly pulse: Pulse;
  readonly attack?: Attack;
  readonly fraud?: FraudScoring;
  readonly updateWall?: UpdateWall;
};

export function latestChange<Value>(history: History<Value>): ConfigChange<Value> {
  return history.at(-1) ?? history[0];
}

export function isFlagOn(flag: FeatureFlag): boolean {
  return latestChange(flag.history).to;
}

export function configValue(entry: RemoteConfigEntry): string {
  return latestChange(entry.history).to;
}

export function configVersion(entry: RemoteConfigEntry): number {
  return entry.baseVersion + entry.history.length;
}

export function findFlag(commerce: Commerce, key: string): FeatureFlag | undefined {
  return commerce.flags.find((flag) => flag.key === key);
}

export function findConfig(commerce: Commerce, key: string): RemoteConfigEntry | undefined {
  return commerce.remoteConfig.find((entry) => entry.key === key);
}

export function findPlatform(commerce: Commerce, id: string): Platform | undefined {
  return commerce.platforms.find((platform) => platform.id === id);
}

export function isAlertOpen(alert: SiemAlert): boolean {
  return alert.resolution === null;
}
