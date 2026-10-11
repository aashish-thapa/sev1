import type {
  Attack,
  Commerce,
  FeatureFlag,
  FraudScoring,
  PaymentGateway,
  Platform,
  PlatformId,
  PolicySource,
  RemoteConfigEntry,
  SiemAlert,
  UpdateWall,
  WafRule,
} from "../sim/commerce.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;

export const WEB_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const iosUserAgent = (version: string, build: number) => `Marlow/${version} (com.marlow.shop; build:${build}; iOS 18.6.2) Alamofire/5.10.2`;
export const androidUserAgent = (version: string) => `Marlow/${version} (Android 15; Pixel 8) okhttp/4.12.0`;

/** A client that never retries checkout on its own: the customer sees the error. */
export const NO_RETRY: PolicySource = { kind: "fixed", policy: "none" };

const PLATFORMS: Readonly<Record<PlatformId, Platform>> = {
  web: {
    id: "web",
    customerShare: 0.52,
    current: { version: "2026.10.09-2", userAgent: WEB_USER_AGENT, timeoutMs: 8000, retry: NO_RETRY },
    previous: null,
    adoption: 1,
    rollout: { kind: "instant" },
    inReview: null,
  },
  ios: {
    id: "ios",
    customerShare: 0.36,
    current: { version: "7.3.0", userAgent: iosUserAgent("7.3.0", 7301), timeoutMs: 10_000, retry: NO_RETRY },
    previous: null,
    adoption: 1,
    rollout: { kind: "instant" },
    inReview: null,
  },
  android: {
    id: "android",
    customerShare: 0.12,
    current: { version: "7.2.4", userAgent: androidUserAgent("7.2.4"), timeoutMs: 30_000, retry: NO_RETRY },
    previous: null,
    adoption: 1,
    rollout: { kind: "instant" },
    inReview: null,
  },
};

/** Flags every Marlow incident has lying around; none of them touches checkout retries. */
export const SHOP_FLAGS: readonly FeatureFlag[] = [
  {
    key: "checkout.payment_element_v2",
    description: "New card form with inline validation",
    owner: "team-checkout-web",
    history: [{ at: -19 * HOUR, by: "web-release-bot", from: false, to: true, note: "web 2026.10.09-2 (FE-2240)" }],
  },
  {
    key: "checkout.express_pay",
    description: "Apple Pay / Google Pay buttons above the card form",
    owner: "team-checkout-web",
    history: [{ at: -9 * DAY, by: "priya.shah", from: false, to: true, note: "GA after 2-week ramp" }],
  },
  {
    key: "home.sale_banner",
    description: "Autumn Sale hero banner on the home page",
    owner: "team-growth",
    history: [{ at: -6 * 60 - 40, by: "lena.ortiz", from: false, to: true, note: "Autumn Sale go-live" }],
  },
  {
    key: "search.typo_tolerance",
    description: "Fuzzy matching in product search",
    owner: "team-search",
    history: [{ at: -3 * DAY, by: "dev.raman", from: true, to: false, note: "p95 regression, off until SRCH-311" }],
  },
];

/** Remote-config keys every Marlow incident has; none of them touches checkout retries. */
export const SHOP_REMOTE_CONFIG: readonly RemoteConfigEntry[] = [
  {
    key: "home_banner_campaign",
    description: "Campaign id for the home screen hero",
    readBy: "ios >= 7.0.0, android >= 7.0.0",
    allowed: null,
    baseVersion: 31,
    history: [{ at: -6 * 60 - 40, by: "lena.ortiz", from: "none", to: "autumn-sale-2026", note: "Autumn Sale go-live" }],
  },
  {
    key: "checkout_express_pay_enabled",
    description: "Show Apple Pay / Google Pay on the checkout sheet",
    readBy: "ios >= 7.1.0, android >= 7.1.0",
    allowed: ["true", "false"],
    baseVersion: 12,
    history: [{ at: -40 * DAY, by: "jonah.reyes", from: "false", to: "true", note: "GA" }],
  },
  {
    key: "min_supported_version",
    description: "Builds below this get a blocking update screen",
    readBy: "ios >= 6.0.0, android >= 6.0.0",
    allowed: null,
    baseVersion: 9,
    history: [{ at: -90 * DAY, by: "jonah.reyes", from: "6.8.0", to: "7.0.0", note: "drop iOS 15" }],
  },
];

/** A healthy gateway with room above checkoutCluster's 120 organic checkouts per second. */
const GATEWAY: PaymentGateway = { name: "payment-gateway", chargesPerSecond: 180, maxQueueSeconds: 20, baselineTimeoutShare: 0.03, backlog: 0, timeoutShare: 0 };

const WAF_RULES: readonly WafRule[] = [
  { id: "r-0001", action: "block", expression: 'ip.src in $tor_exit_nodes and http.request.uri.path eq "/login"', createdAt: -120 * DAY, createdBy: "a.kowalski", customerShare: 0 },
  { id: "r-0002", action: "rate_limit", expression: 'http.request.uri.path eq "/login" (10/1m per ip.src)', createdAt: -120 * DAY, createdBy: "a.kowalski", customerShare: 0 },
];

export type CommerceSetup = {
  /** Per platform, what differs from a calm shop where every build is fully released and never retries. */
  readonly platforms?: { readonly [Id in PlatformId]?: Partial<Omit<Platform, "id">> };
  readonly flags?: readonly FeatureFlag[];
  readonly remoteConfig?: readonly RemoteConfigEntry[];
  readonly gateway?: Partial<PaymentGateway>;
  readonly wafRules?: readonly WafRule[];
  /** None unless a scenario needs one: an untriaged alert's auto-containment blocks real customers. */
  readonly alerts?: readonly SiemAlert[];
  readonly attack?: Attack;
  readonly fraud?: FraudScoring;
  readonly updateWall?: UpdateWall;
};

/**
 * The world around checkout-api: web, iOS and Android clients, flags, remote config, the payment
 * gateway, the WAF and SIEM, and an empty ledger. Defaults are calm; a scenario sets only what its incident is about.
 */
export function checkoutCommerce(setup: CommerceSetup = {}): Commerce {
  const platform = (id: PlatformId): Platform => ({ ...PLATFORMS[id], ...setup.platforms?.[id] });
  const wafRules = setup.wafRules ?? WAF_RULES;
  return {
    platforms: [platform("web"), platform("ios"), platform("android")],
    flags: setup.flags ?? SHOP_FLAGS,
    remoteConfig: setup.remoteConfig ?? SHOP_REMOTE_CONFIG,
    gateway: { ...GATEWAY, ...setup.gateway },
    wafRules,
    nextWafRuleNumber: wafRules.length + 1,
    alerts: setup.alerts ?? [],
    ledger: {
      averageOrderCents: 5840,
      paidOrders: 0,
      orphanedCaptures: 0,
      orphanedBySegment: {},
      orphanHistory: [],
      minutes: [],
      refundedCaptures: 0,
      refundBatches: [],
    },
    pulse: { organicCheckoutsPerSecond: 0, checkoutAttemptsPerSecond: 0, blockedPerSecond: 0, gatewayCallsPerSecond: 0, checkoutFailureRate: 0 },
    ...(setup.attack ? { attack: setup.attack } : {}),
    ...(setup.fraud ? { fraud: setup.fraud } : {}),
    ...(setup.updateWall ? { updateWall: setup.updateWall } : {}),
  };
}
