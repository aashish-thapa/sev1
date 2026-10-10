import { clientSegments, mixAmplification, mixGiveUp, RETRY_POLICIES, type ClientSegment } from "./clients.ts";
import { isAlertOpen, type Commerce, type Ledger, type MinuteBucket, type PaymentGateway, type Platform } from "./commerce.ts";
import { blockedShare, containmentRule, topTalker } from "./edge.ts";
import { appendCapped, SERIES_LENGTH, type ClusterState, type LogLevel, type Traffic } from "./model.ts";

/** What reaches the cluster this second and how the dependency behind it is doing. */
export type Load = {
  readonly requestsPerSecond: number;
  readonly checkoutShare: number;
  /** Share of checkout calls the payment gateway will not answer before checkout-api gives up. */
  readonly gatewayFailShare: number;
  /** Multiplier on dependency-timeout traits relative to the traffic they were measured at. */
  readonly leakPressure: number;
  /** Share of checkouts a client defect makes checkout-api answer with a 5xx before it calls the gateway. */
  readonly rejectedCheckoutShare: number;
  /** Share of checkouts declined as fraud: a 402 before the gateway, so a lost order but not a failed request. */
  readonly declinedCheckoutShare: number;
};

export type CommerceDemand = Load & {
  readonly segments: readonly ClientSegment[];
  /** The checkout failure rate clients reacted to when deciding how hard to retry. */
  readonly clientFailureRate: number;
  readonly organicCheckoutsPerSecond: number;
  readonly checkoutAttemptsPerSecond: number;
  readonly blockedShare: number;
  readonly blockedPerSecond: number;
};

export type RoutingOutcome = {
  readonly t: number;
  readonly gatewayCallsPerSecond: number;
  readonly checkoutFailureRate: number;
};

type Log = (source: string, level: LogLevel, text: string) => void;

const MINUTES_KEPT = 15;
/** Gateway queue wait (s) where calls start, and finish, overrunning checkout-api's 3 s timeout. */
const TIMEOUT_ONSET_SECONDS = 2.2;
const TIMEOUT_SPREAD_SECONDS = 1.6;

export function plainLoad(traffic: Traffic): Load {
  return {
    requestsPerSecond: traffic.requestsPerSecond,
    checkoutShare: traffic.checkoutShare,
    gatewayFailShare: 0,
    leakPressure: 1,
    rejectedCheckoutShare: 0,
    declinedCheckoutShare: 0,
  };
}

function gatewayTimeoutTotal(gateway: PaymentGateway): number {
  return gateway.baselineTimeoutShare + (1 - gateway.baselineTimeoutShare) * gateway.timeoutShare;
}

/** Organic customers, multiplied by whatever retry policy their client runs, minus what the WAF drops. */
export function commerceDemand(state: ClusterState, commerce: Commerce): CommerceDemand {
  const { requestsPerSecond: organic, checkoutShare } = state.traffic;
  const segments = clientSegments(commerce, state.t);
  const failure = commerce.pulse.checkoutFailureRate;
  const organicCheckouts = organic * checkoutShare;
  const checkoutAttempts = organicCheckouts * segments.reduce((sum, segment) => sum + segment.share * mixAmplification(segment.mix, failure), 0);
  const attempts = organic * (1 - checkoutShare) + checkoutAttempts;
  const blocked = blockedShare(commerce.wafRules);
  const share = attempts > 0 ? checkoutAttempts / attempts : 0;
  const { gateway } = commerce;
  return {
    requestsPerSecond: attempts * (1 - blocked),
    checkoutShare: share,
    gatewayFailShare: gateway.timeoutShare,
    leakPressure: (share / checkoutShare) * (gatewayTimeoutTotal(gateway) / gateway.baselineTimeoutShare),
    rejectedCheckoutShare: 0,
    declinedCheckoutShare: 0,
    segments,
    clientFailureRate: failure,
    organicCheckoutsPerSecond: organicCheckouts,
    checkoutAttemptsPerSecond: checkoutAttempts,
    blockedShare: blocked,
    blockedPerSecond: attempts * blocked,
  };
}

/** Customers who end this second without an order: blocked at the edge, or out of retries. */
export function lostCheckouts(demand: CommerceDemand, checkoutFailureRate: number): number {
  return demand.segments.reduce((sum, segment) => {
    const customers = demand.organicCheckoutsPerSecond * segment.share;
    const gaveUp = mixGiveUp(segment.mix, checkoutFailureRate);
    return sum + customers * (demand.blockedShare + (1 - demand.blockedShare) * gaveUp);
  }, 0);
}

/**
 * A FIFO queue in front of a degraded gateway. A call that waits past checkout-api's timeout
 * still gets processed — the card is captured for an order checkout-api already failed.
 */
function stepGateway(gateway: PaymentGateway, calls: number): { gateway: PaymentGateway; processed: number } {
  const capacity = gateway.chargesPerSecond;
  const queued = gateway.backlog + calls;
  const processed = Math.min(capacity, queued);
  const backlog = Math.min(queued - processed, capacity * gateway.maxQueueSeconds);
  const wait = backlog / capacity;
  const timeoutShare = Math.min(1, Math.max(0, (wait - TIMEOUT_ONSET_SECONDS) / TIMEOUT_SPREAD_SECONDS));
  return { gateway: { ...gateway, backlog, timeoutShare }, processed };
}

function stepLedger(ledger: Ledger, t: number, processed: number, orphanShare: number, demand: CommerceDemand): Ledger {
  const failure = demand.clientFailureRate;
  const orphaned = processed * orphanShare;
  const paid = processed - orphaned;
  // Orphans land on segments in proportion to the gateway calls each one sends.
  const calls = demand.segments.map((segment) => {
    const unsafe = segment.mix.filter((part) => !RETRY_POLICIES[part.policy].sendsIdempotencyKey);
    const safe = segment.mix.filter((part) => RETRY_POLICIES[part.policy].sendsIdempotencyKey);
    return { withoutKey: segment.share * mixAmplification(unsafe, failure), withKey: segment.share * mixAmplification(safe, failure) };
  });
  const totalCalls = calls.reduce((sum, call) => sum + call.withKey + call.withoutKey, 0);
  const scale = totalCalls > 0 ? orphaned / totalCalls : 0;
  const orphanedBySegment = { ...ledger.orphanedBySegment };
  demand.segments.forEach((segment, index) => {
    const previous = orphanedBySegment[segment.id] ?? { withKey: 0, withoutKey: 0 };
    orphanedBySegment[segment.id] = { withKey: previous.withKey + calls[index].withKey * scale, withoutKey: previous.withoutKey + calls[index].withoutKey * scale };
  });
  const minute = Math.floor(t / 60);
  const last = ledger.minutes.at(-1);
  const minutes: MinuteBucket[] =
    last && last.minute === minute
      ? [...ledger.minutes.slice(0, -1), { minute, paidOrders: last.paidOrders + paid, orphanedCaptures: last.orphanedCaptures + orphaned }]
      : [...ledger.minutes, { minute, paidOrders: paid, orphanedCaptures: orphaned }];
  const orphanedCaptures = ledger.orphanedCaptures + orphaned;
  return {
    ...ledger,
    paidOrders: ledger.paidOrders + paid,
    orphanedCaptures,
    orphanedBySegment,
    orphanHistory: appendCapped(ledger.orphanHistory, orphanedCaptures, SERIES_LENGTH),
    minutes: minutes.slice(-MINUTES_KEPT),
  };
}

function stepRollout(platform: Platform): Platform {
  const { rollout } = platform;
  if (rollout.kind !== "phased" || rollout.isPaused || platform.adoption >= 1) return platform;
  return { ...platform, adoption: Math.min(1, platform.adoption + rollout.adoptionPerSecond) };
}

/** The SOAR playbook contains any alert nobody triaged in time by blocking its top talkers. */
function autoContain(commerce: Commerce, t: number, log: Log): Commerce {
  let next = commerce;
  for (const alert of commerce.alerts) {
    if (!isAlertOpen(alert) || alert.autoContainAt === null || t < alert.autoContainAt) continue;
    const rule = containmentRule(next, alert, t);
    next = {
      ...next,
      wafRules: [...next.wafRules, rule],
      nextWafRuleNumber: next.nextWafRuleNumber + 1,
      alerts: next.alerts.map((candidate) => (candidate.id === alert.id ? { ...alert, autoContainAt: null } : candidate)),
    };
    log("waf", "WARN", `rule ${rule.id} created by ${rule.createdBy}: block top ${alert.containTopIps} source IPs on /checkout`);
  }
  return next;
}

function unitHash(seed: number): number {
  return (Math.imul(seed ^ (seed >>> 13), 2654435761) >>> 0) / 4_294_967_296;
}

/** A sampled edge access log line every other second, so infra can see who is calling and how it ends. */
function logEdge(demand: CommerceDemand, outcome: RoutingOutcome, commerce: Commerce, log: Log) {
  const { t } = outcome;
  if (t % 2 !== 0 || demand.segments.length === 0) return;
  const failure = outcome.checkoutFailureRate;
  const weights = demand.segments.map((segment) => segment.share * mixAmplification(segment.mix, demand.clientFailureRate));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let pick = unitHash(t * 7 + 1) * total;
  const segment = demand.segments.find((_, index) => (pick -= weights[index]) <= 0) ?? demand.segments[0];
  const talker = topTalker(1 + Math.floor(unitHash(t * 13 + 5) ** 2 * 900));
  const roll = unitHash(t * 29 + 3);
  const request = `"POST /checkout HTTP/2"`;
  const client = `"${talker.ip}" "${segment.userAgent}"`;
  const rule = commerce.wafRules.at(-1);
  if (rule && roll < demand.blockedShare) {
    log("edge-lb", "WARN", `${request} 403 - 1184 166 0 - ${client} waf_rule=${rule.id}`);
  } else if (roll < failure) {
    log("edge-lb", "WARN", `${request} 0 DC 1184 0 ${segment.timeoutMs + Math.floor(roll * 9)} - ${client} upstream=checkout-api`);
  } else {
    log("edge-lb", "INFO", `${request} 201 - 1184 412 ${70 + Math.floor(roll * 300)} ${60 + Math.floor(roll * 280)} ${client} upstream=checkout-api`);
  }
}

export function settleCommerce(commerce: Commerce, demand: CommerceDemand, outcome: RoutingOutcome, log: Log): Commerce {
  const { gateway, processed } = stepGateway(commerce.gateway, outcome.gatewayCallsPerSecond);
  const ledger = stepLedger(commerce.ledger, outcome.t, processed, gateway.timeoutShare, demand);
  const settled: Commerce = {
    ...commerce,
    gateway,
    ledger,
    platforms: commerce.platforms.map(stepRollout),
    pulse: {
      organicCheckoutsPerSecond: demand.organicCheckoutsPerSecond,
      checkoutAttemptsPerSecond: demand.checkoutAttemptsPerSecond,
      blockedPerSecond: demand.blockedPerSecond,
      gatewayCallsPerSecond: outcome.gatewayCallsPerSecond,
      checkoutFailureRate: outcome.checkoutFailureRate,
    },
  };
  logEdge(demand, outcome, commerce, log);
  return autoContain(settled, outcome.t, log);
}
