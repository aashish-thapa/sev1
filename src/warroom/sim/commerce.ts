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

export type ClientBuild = {
  readonly version: string;
  readonly userAgent: string;
  /** How long the client waits for POST /checkout before it gives up (and, if it retries, retries). */
  readonly timeoutMs: number;
  readonly retry: PolicySource;
};

export type Rollout =
  | { readonly kind: "instant" }
  | { readonly kind: "phased"; readonly day: number; readonly isPaused: boolean; readonly adoptionPerSecond: number };

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
