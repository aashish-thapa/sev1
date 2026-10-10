import {
  configValue,
  findConfig,
  findFlag,
  isFlagOn,
  isRetryPolicyName,
  latestChange,
  type ClientBuild,
  type ClientDefect,
  type Commerce,
  type ConfigChange,
  type DefectTrigger,
  type PlatformId,
  type PolicySource,
  type RetryPolicyName,
} from "./commerce.ts";

export type RetryPolicy = {
  readonly maxRetries: number;
  readonly sendsIdempotencyKey: boolean;
  /** Client-wide cap on retries per first attempt (a token-bucket retry budget); null is unbounded. */
  readonly retryBudget: number | null;
  readonly summary: string;
};

export const RETRY_POLICIES: Record<RetryPolicyName, RetryPolicy> = {
  none: { maxRetries: 0, sendsIdempotencyKey: true, retryBudget: 0, summary: "no automatic retry; the customer sees the error" },
  immediate: { maxRetries: 3, sendsIdempotencyKey: false, retryBudget: null, summary: "up to 3 retries, no delay, no Idempotency-Key" },
  backoff: { maxRetries: 2, sendsIdempotencyKey: true, retryBudget: 0.1, summary: "2 retries, exponential backoff with full jitter, 10% retry budget, Idempotency-Key" },
};

/** Streaming flag SDKs in open tabs pick a change up within seconds. */
export const FLAG_PROPAGATION_SECONDS = 20;
/** Apps apply remote config on their next fetch: realtime listeners first, backgrounded apps on resume. */
export const REMOTE_CONFIG_PROPAGATION_SECONDS = 120;

export type PolicyMix = readonly { readonly policy: RetryPolicyName; readonly weight: number }[];

/** A slice of customers on one client build, with the retry behaviour it is running right now. */
export type ClientSegment = {
  readonly id: string;
  readonly platform: PlatformId;
  readonly version: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly share: number;
  readonly mix: PolicyMix;
  /** The bugs shipped in this segment's build. */
  readonly defects: readonly ClientDefect[];
};

function expectedRetries(policy: RetryPolicy, failure: number): number {
  let reach = 1;
  let retries = 0;
  for (let attempt = 0; attempt < policy.maxRetries; attempt += 1) {
    reach *= failure;
    retries += reach;
  }
  return retries;
}

/** Requests a client sends per checkout when every attempt fails independently with probability `failure`. */
export function amplification(policy: RetryPolicy, failure: number): number {
  const retries = expectedRetries(policy, failure);
  return 1 + (policy.retryBudget === null ? retries : Math.min(policy.retryBudget, retries));
}

/** Probability the customer never gets a successful checkout out of this policy. */
export function giveUpProbability(policy: RetryPolicy, failure: number): number {
  const unbounded = expectedRetries(policy, failure);
  if (unbounded === 0) return failure;
  const allowed = policy.retryBudget === null ? unbounded : Math.min(policy.retryBudget, unbounded);
  const retriedShare = allowed / unbounded;
  return failure * (1 - retriedShare * (1 - failure ** policy.maxRetries));
}

export function mixAmplification(mix: PolicyMix, failure: number): number {
  return mix.reduce((sum, part) => sum + part.weight * amplification(RETRY_POLICIES[part.policy], failure), 0);
}

export function mixGiveUp(mix: PolicyMix, failure: number): number {
  return mix.reduce((sum, part) => sum + part.weight * giveUpProbability(RETRY_POLICIES[part.policy], failure), 0);
}

/** Weight of the mix that retries without an idempotency key. */
export function unsafeRetryWeight(mix: PolicyMix): number {
  return mix.reduce((sum, part) => sum + (RETRY_POLICIES[part.policy].sendsIdempotencyKey ? 0 : part.weight), 0);
}

/** How far a change has spread through clients `elapsed` seconds after it was made, 0..1. */
function propagation(elapsed: number, window: number): number {
  return Math.min(1, Math.max(0, elapsed / window));
}

function propagated(previous: RetryPolicyName, current: RetryPolicyName, elapsed: number, window: number): PolicyMix {
  const progress = propagation(elapsed, window);
  if (previous === current || progress >= 1) return [{ policy: current, weight: 1 }];
  return [
    { policy: previous, weight: 1 - progress },
    { policy: current, weight: progress },
  ];
}

function asPolicy(value: string): RetryPolicyName {
  return isRetryPolicyName(value) ? value : "none";
}

/** The retry behaviour a build is running at `t`, blending clients that have not picked up a change yet. */
export function policyMix(source: PolicySource, commerce: Commerce, t: number): PolicyMix {
  switch (source.kind) {
    case "fixed":
      return [{ policy: source.policy, weight: 1 }];
    case "flag": {
      const flag = findFlag(commerce, source.key);
      if (!flag) return [{ policy: source.whenOff, weight: 1 }];
      const change = latestChange(flag.history);
      const policyFor = (on: boolean) => (on ? source.whenOn : source.whenOff);
      return propagated(policyFor(change.from), policyFor(isFlagOn(flag)), t - change.at, FLAG_PROPAGATION_SECONDS);
    }
    case "remote-config": {
      const entry = findConfig(commerce, source.key);
      if (!entry) return [{ policy: "none", weight: 1 }];
      const change = latestChange(entry.history);
      return propagated(asPolicy(change.from), asPolicy(configValue(entry)), t - change.at, REMOTE_CONFIG_PROPAGATION_SECONDS);
    }
  }
}

/** Share of clients holding a value `fires` matches, while the latest change spreads over `window` seconds. */
export function firingShare<Value>(change: ConfigChange<Value>, t: number, window: number, fires: (value: Value) => boolean): number {
  const before = fires(change.from);
  const after = fires(change.to);
  if (before === after) return after ? 1 : 0;
  const progress = propagation(t - change.at, window);
  return after ? progress : 1 - progress;
}

/** Share of a build's clients on which a defect's trigger holds at `t`, counting clients that haven't picked up the last change. */
export function triggerShare(trigger: DefectTrigger, commerce: Commerce, t: number): number {
  if (trigger === "always") return 1;
  if ("flag" in trigger) {
    const flag = findFlag(commerce, trigger.flag);
    // An unknown flag reads as off, as it does for retry policies.
    if (!flag) return trigger.failsWhenOn ? 0 : 1;
    return firingShare(latestChange(flag.history), t, FLAG_PROPAGATION_SECONDS, (on) => on === trigger.failsWhenOn);
  }
  const entry = findConfig(commerce, trigger.remoteConfig);
  if (!entry) return 0;
  return firingShare(latestChange(entry.history), t, REMOTE_CONFIG_PROPAGATION_SECONDS, (value) => value === trigger.failsWhen);
}

export function segmentId(platform: PlatformId, build: ClientBuild): string {
  return `${platform}@${build.version}`;
}

export function clientSegments(commerce: Commerce, t: number): readonly ClientSegment[] {
  return commerce.platforms.flatMap((platform) => {
    const builds: { build: ClientBuild; share: number }[] = [{ build: platform.current, share: platform.customerShare * platform.adoption }];
    if (platform.previous) builds.push({ build: platform.previous, share: platform.customerShare * (1 - platform.adoption) });
    return builds
      .filter(({ share }) => share > 0)
      .map(({ build, share }) => ({
        id: segmentId(platform.id, build),
        platform: platform.id,
        version: build.version,
        userAgent: build.userAgent,
        timeoutMs: build.timeoutMs,
        share,
        mix: policyMix(build.retry, commerce, t),
        defects: build.defects ?? [],
      }));
  });
}

/** Share of checkout customers whose client still retries without backoff or an idempotency key. */
export function unsafeRetryShare(commerce: Commerce, t: number): number {
  return clientSegments(commerce, t).reduce((sum, segment) => sum + segment.share * unsafeRetryWeight(segment.mix), 0);
}

export type SegmentStats = ClientSegment & {
  /** Checkout requests per customer checkout at the current failure rate. */
  readonly amplification: number;
  readonly giveUp: number;
  /** Weight of this segment's clients still retrying without backoff or an idempotency key. */
  readonly unsafeWeight: number;
};

/** Each client segment's retry behaviour at the failure rate customers saw in the last second. */
export function segmentStats(commerce: Commerce, t: number): readonly SegmentStats[] {
  const failure = commerce.pulse.checkoutFailureRate;
  return clientSegments(commerce, t).map((segment) => ({
    ...segment,
    amplification: mixAmplification(segment.mix, failure),
    giveUp: mixGiveUp(segment.mix, failure),
    unsafeWeight: unsafeRetryWeight(segment.mix),
  }));
}
