import type { Role } from "../../domain/incident.ts";
import type { CommsMessage, ExternalService, Postmortem, Scenario, SolutionStep } from "../scenario.ts";
import { percent } from "../shell/commerce-command.ts";
import { table } from "../shell/types.ts";
import { customerLossRate } from "../sim/commerce-step.ts";
import { findFlag, findPlatform, isFlagOn, type ClientDefect, type FeatureFlag } from "../sim/commerce.ts";
import type { ClusterState } from "../sim/model.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";
import { checkoutCommerce, NO_RETRY, SHOP_FLAGS, WEB_USER_AGENT } from "./checkout-commerce.ts";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;
const ROLE: Role = "frontend";
const SITE = "https://www.marlow.example/";

/** A flag with one recorded change; `to` is where it stands when the page fires. */
type FlagSpec = {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly by: string;
  /** Seconds before the page the change was made. */
  readonly ago: number;
  readonly to: boolean;
  readonly note: string;
};

/**
 * What the precached build does wrong. A storm: it retries every timeout instantly while the gateway
 * is degraded, and the retry flag only steers the new build. A defect: it breaks a share of its own
 * checkouts, on checkout-api ("server") or in the browser ("client"), and the flag teammates reach for
 * only exists in the new build.
 */
type Trouble =
  | {
      readonly kind: "storm";
      readonly chargesPerSecond: number;
      readonly surgeRps: number;
      readonly surgeSeconds: number;
      readonly gatewayStatus: string;
    }
  | { readonly kind: "defect"; readonly where: ClientDefect["where"]; readonly failShare: number; readonly message: string };

/**
 * A tier-4 frontend incident: a service worker keeps a share of tabs on an older precached build, so the
 * flag everyone reaches for (the decoy) changes only the deployed build and does nothing. The old worker's
 * kill switch moves those tabs onto the deployed build.
 */
type Row = {
  readonly slug: string;
  readonly title: string;
  readonly severity: Scenario["severity"];
  readonly opensAt: readonly [hour: number, minute: number];
  readonly staleBuild: string;
  readonly freshBuild: string;
  /** Share of web tabs already on the deployed build when the page fires. */
  readonly adoption: number;
  readonly adoptionPerSecond: number;
  readonly workers: readonly [stale: number, fresh: number];
  readonly cacheName: string;
  readonly killSwitch: FlagSpec;
  /** The usual fix: flipping it changes only the deployed build. */
  readonly decoy: FlagSpec;
  readonly trouble: Trouble;
  readonly view: { readonly name: string; readonly description: string };
  readonly briefing: string;
  readonly roleBriefing: string;
  readonly page: string;
  readonly comms: readonly CommsMessage[];
  readonly hints: readonly string[];
  /** What to look at before the kill switch. */
  readonly look: readonly SolutionStep[];
  readonly killNote: string;
  readonly killWhy: string;
  readonly verify: SolutionStep;
  readonly postmortem: Postmortem;
  readonly lostCheckoutsPerPoint: number;
};

function asFlag(spec: FlagSpec): FeatureFlag {
  return { key: spec.key, description: spec.description, owner: spec.owner, history: [{ at: -spec.ago, by: spec.by, from: !spec.to, to: spec.to, note: spec.note }] };
}

/** The registration as Chrome's Application panel would show it across our users' browsers. */
function workerPanel(row: Row) {
  const [staleWorker, freshWorker] = row.workers;
  return (state: ClusterState): readonly string[] => {
    const commerce = state.commerce;
    const web = commerce && findPlatform(commerce, "web");
    if (!commerce || !web) return [];
    const killSwitch = findFlag(commerce, row.killSwitch.key);
    const stale = 1 - web.adoption;
    return [
      `Service worker · scope ${SITE} · checkout-web sessions, last 5 min`,
      ...table([
        ["STATUS", "BUILD", "CONTROLS"],
        stale > 0 ? [`#${staleWorker} activated and is running`, row.staleBuild, `${percent(stale, 0)} of tabs`] : [`#${staleWorker} is redundant`, row.staleBuild, "—"],
        stale > 0
          ? [`#${freshWorker} waiting to activate`, row.freshBuild, `— (until every tab #${staleWorker} controls has closed)`]
          : [`#${freshWorker} activated and is running`, row.freshBuild, "100% of tabs"],
      ]),
      `Precache ${row.cacheName} holds the ${stale > 0 ? row.staleBuild : row.freshBuild} app shell and bundles, served cache-first.`,
      killSwitch && isFlagOn(killSwitch)
        ? `${row.killSwitch.key} is on: #${staleWorker} unregisters and reloads each tab it controls from the network.`
        : `${row.killSwitch.key} is off.`,
    ];
  };
}

function incident(row: Row): Scenario {
  const id = `fe-t4-${row.slug}`;
  const { trouble, decoy } = row;
  const isStorm = trouble.kind === "storm";
  const staleDefects: readonly ClientDefect[] = trouble.kind === "defect" ? [{ trigger: "always", failShare: trouble.failShare, where: trouble.where, message: trouble.message }] : [];
  const gateway: ExternalService = isStorm
    ? {
        id: "payment-gateway",
        status: "degraded",
        facts: [
          { key: "Status page", value: trouble.gatewayStatus },
          { key: "Throughput for us", value: `≈${trouble.chargesPerSecond} charges/s while degraded; excess queues FIFO` },
          { key: "checkout-api timeout", value: "3000 ms per call" },
        ],
      }
    : {
        id: "payment-gateway",
        status: "ok",
        facts: [
          { key: "Status page", value: "All systems operational" },
          { key: "checkout-api timeout", value: "3000 ms per call" },
        ],
      };
  return {
    id,
    tier: 4,
    title: row.title,
    severity: row.severity,
    service: CHECKOUT,
    briefing: row.briefing,
    roles: [ROLE],
    roleBriefings: { [ROLE]: row.roleBriefing },
    suggestions: {
      [ROLE]: ["rum overview", "rum errors", "rum session", `rum ${row.view.name}`, "flags list", `flags history ${decoy.key}`, `flags set ${decoy.key} ${decoy.to ? "off" : "on"}`],
    },
    evidence: [{ tool: "rum", name: row.view.name, description: row.view.description, run: workerPanel(row) }],
    opensAtSecondOfDay: row.opensAt[0] * HOUR + row.opensAt[1] * MINUTE,
    seed: id,
    initialState: () =>
      checkoutCluster({
        seed: id,
        revisions: [{ number: 6, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] }],
        revision: 6,
        replicas: isStorm ? 4 : 3,
        commerce: checkoutCommerce({
          platforms: {
            web: {
              current: {
                version: row.freshBuild,
                userAgent: WEB_USER_AGENT,
                timeoutMs: 8000,
                retry: isStorm ? { kind: "flag", key: decoy.key, whenOn: "backoff", whenOff: "none" } : NO_RETRY,
              },
              previous: {
                version: row.staleBuild,
                userAgent: WEB_USER_AGENT,
                timeoutMs: 8000,
                retry: isStorm ? { kind: "fixed", policy: "immediate" } : NO_RETRY,
                defects: staleDefects,
              },
              adoption: row.adoption,
              rollout: { kind: "service-worker", killSwitchFlag: row.killSwitch.key, adoptionPerSecond: row.adoptionPerSecond },
            },
          },
          flags: [asFlag(decoy), asFlag(row.killSwitch), ...SHOP_FLAGS],
          ...(isStorm ? { gateway: { chargesPerSecond: trouble.chargesPerSecond, maxQueueSeconds: 10 } } : {}),
        }),
        ...(isStorm
          ? { warmUp: { seconds: 180, requestsPerSecond: (second: number) => (second < trouble.surgeSeconds ? trouble.surgeRps : 300) } }
          : {}),
      }),
    isRootCauseFixed: (state) => {
      const web = state.commerce && findPlatform(state.commerce, "web");
      return !!web && web.adoption >= 0.99;
    },
    ...(trouble.kind === "defect" && trouble.where === "client"
      ? { alertMetric: { label: "checkout loss", rate: (state: ClusterState) => (state.commerce ? customerLossRate(state.commerce, state.t) : 0) } }
      : {}),
    lostCheckoutsPerPoint: row.lostCheckoutsPerPoint,
    externals: [gateway],
    comms: [{ at: 0, from: "PagerDuty", text: row.page }, ...row.comms],
    hints: row.hints,
    solution: {
      [ROLE]: [...row.look, { command: `flags set ${row.killSwitch.key} on --note "${row.killNote}"`, why: row.killWhy }, row.verify],
    },
    postmortem: row.postmortem,
  };
}

const WEB_PLATFORM = "team-web-platform";
const CHECKOUT_WEB = "team-checkout-web";

const ROWS: readonly Row[] = [
  {
    slug: "purged-payment-chunk",
    title: "The chunk the CDN let go",
    severity: "SEV2",
    opensAt: [8, 52],
    staleBuild: "2026.10.07-4",
    freshBuild: "2026.10.10-1",
    adoption: 0.35,
    adoptionPerSecond: 0.009,
    workers: [388, 391],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_purge_legacy_shells",
      description: "Old service workers delete their precache, unregister and reload their tabs from the network",
      owner: WEB_PLATFORM,
      by: "jorge.alvarez",
      ago: 64 * DAY,
      to: false,
      note: "quarterly drill done",
    },
    decoy: {
      key: "checkout.payment_chunk_eager",
      description: "Bundle the payment step into the main checkout chunk instead of lazy-loading it",
      owner: CHECKOUT_WEB,
      by: "kofi.mensah",
      ago: 21 * DAY,
      to: false,
      note: "eager payment bundle cost 400 ms LCP; lazy again (FE-2190)",
    },
    trouble: {
      kind: "defect",
      where: "client",
      failShare: 0.92,
      message: "ChunkLoadError: Loading chunk 7312 failed. (error: https://static.marlow.example/assets/7312.4be1c0a9.js)",
    },
    view: { name: "service-worker", description: "Service worker versions and the tabs they control" },
    briefing:
      "Since about 06:00, a third of web customers reach the payment step and get a blank panel where the card form should be. checkout-api is quiet: the requests never arrive. The CDN only serves 2026.10.10-1 and its assets.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. The runbook entry for ChunkLoadError says to load the payment step eagerly. Check which build is failing before you follow it.",
    page: "SEV2 triggered — checkout loss > 20% for 5m on web; checkout-api 5xx 0.0%. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Customers say the card form never appears. Some say it works on their phone but not on the laptop they left open since the weekend." },
      { at: 55, from: "Kofi Mensah · Web engineer", text: "ChunkLoadError is in the runbook: flip checkout.payment_chunk_eager on and the payment step ships inside the main bundle. That’s what we did in August." },
      { at: 100, from: "Tomás Ibarra · SRE", text: "The static-assets bucket lifecycle rule ran at 06:00 and deleted hashed files older than 72 hours. Nothing we serve today references them." },
      { at: 150, from: "Jorge Alvarez · Web platform", text: "Workbox precaches the shell and the main bundles, not the lazy chunks. An old shell asks the network for chunks by its own hashes." },
      { at: 220, from: "Elena Ruiz · VP Engineering", text: "Is this the CDN or us? I need one sentence for the exec channel." },
    ],
    hints: [
      "The failing customers never reach checkout-api. Find out which build their tabs are running.",
      "Some customers say a different device works. What does a tab left open for days still have that a fresh page load doesn’t?",
      "A flag only changes code that reads it.",
    ],
    look: [
      { command: "rum errors", why: "The failures are ChunkLoadError for a payment chunk the CDN no longer has." },
      { command: "rum overview", why: "65% of web sessions run 2026.10.07-4, three days older than the only build the CDN serves." },
      { command: "rum service-worker", why: "The 2026.10.07-4 worker still controls 65% of tabs; the 2026.10.10-1 worker is waiting." },
    ],
    killNote: "old shells request purged chunks",
    killWhy: "The old worker drops its precache and reloads its tabs onto 2026.10.10-1, whose chunks exist.",
    verify: { command: "rum service-worker", why: "The old worker goes redundant as its tabs reload, and checkout loss falls with it." },
    postmortem: {
      question: "Why didn’t loading the payment step eagerly stop the ChunkLoadErrors?",
      options: [
        "The CDN cached the 404s for the deleted chunks",
        "The failing tabs run an old build that never reads that flag",
        "Eager loading needs a deploy before the flag can take effect anywhere",
        "The flag SDK was blocked by an ad blocker in most customers’ browsers",
      ],
      answerIndex: 1,
      explanation: {
        cause:
          "A Workbox service worker kept 65% of web tabs on 2026.10.07-4. At 06:00 the bucket lifecycle rule deleted that build’s lazy payment chunk, so those tabs failed to load the card form.",
        why: "checkout.payment_chunk_eager only exists in newer builds; 2026.10.07-4 hard-codes the lazy import. The kill switch made the old worker drop its precache and reload its tabs onto 2026.10.10-1, whose chunks are on the CDN.",
        tell: "RUM put every ChunkLoadError on 2026.10.07-4, and the service-worker view showed the old worker controlling 65% of tabs with the new one waiting.",
      },
    },
    lostCheckoutsPerPoint: 260,
  },
  {
    slug: "precached-csp-frame",
    title: "The challenge frame the old page refused",
    severity: "SEV2",
    opensAt: [7, 24],
    staleBuild: "2026.10.08-1",
    freshBuild: "2026.10.09-3",
    adoption: 0.4,
    adoptionPerSecond: 0.01,
    workers: [402, 405],
    cacheName: `marlow-shell-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_kill_legacy",
      description: "Old service workers unregister and reload their tabs from the network",
      owner: WEB_PLATFORM,
      by: "jorge.alvarez",
      ago: 97 * DAY,
      to: false,
      note: "drill finished",
    },
    decoy: {
      key: "checkout.threeds_redirect_fallback",
      description: "Send 3-D Secure challenges to a full-page redirect instead of the in-page iframe",
      owner: CHECKOUT_WEB,
      by: "ana.costa",
      ago: 30 * DAY,
      to: false,
      note: "iframe challenge is GA; redirect kept as fallback (FE-2205)",
    },
    trouble: {
      kind: "defect",
      where: "client",
      failShare: 0.38,
      message: `Refused to frame 'https://challenge.payrail.example/' because it violates the following Content Security Policy directive: "frame-src 'self' https://acs.payrail.example".`,
    },
    view: { name: "sw-status", description: "Which service worker build controls checkout tabs" },
    briefing:
      "Since 07:00, card payments that need a 3-D Secure challenge hang on an empty box on web. Payrail moved its challenge pages to a new host at 07:00, announced weeks ago, and 2026.10.09-3 added that host to the page’s Content Security Policy yesterday.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. The 3-D Secure runbook says to switch challenges to the redirect fallback. Check which page is refusing the frame first.",
    page: "SEV2 triggered — checkout loss > 10% on web since 07:00; checkout-api 5xx 0.0%. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Customers whose bank asks for a code see an empty box and then nothing. Others pay fine." },
      { at: 50, from: "Ana Costa · Web engineer", text: "The runbook for broken challenges is checkout.threeds_redirect_fallback on. The redirect doesn’t need an iframe at all." },
      { at: 95, from: "Ravi Menon · Payments platform", text: "Payrail moved challenges from acs.payrail.example to challenge.payrail.example at 07:00 sharp. Their side is healthy." },
      { at: 140, from: "Jorge Alvarez · Web platform", text: "Our CSP is a meta tag in index.html, and index.html is in the precache. An old shell keeps its old policy." },
      { at: 210, from: "Sam Tan · Eng manager", text: "We shipped the CSP change yesterday. How are customers still on the old one?" },
    ],
    hints: [
      "Only challenged payments fail. Read the exact message the browser prints for them.",
      "The policy that blocks the frame was fixed yesterday. Find out which page the failing customers loaded.",
      "A fallback that lives in new code can’t help a page that predates it.",
    ],
    look: [
      { command: "rum errors", why: "The browser refuses to frame challenge.payrail.example because the page’s frame-src only allows the old host." },
      { command: "rum session", why: "The sampled session runs 2026.10.08-1 and loaded its page from the service worker." },
      { command: "rum sw-status", why: "The 2026.10.08-1 worker controls 60% of tabs; the 2026.10.09-3 worker, with the new policy, waits." },
    ],
    killNote: "precached index.html carries the old CSP",
    killWhy: "The old worker unregisters and reloads its tabs, which fetch index.html, and its new policy, from the network.",
    verify: { command: "rum errors", why: "The CSP refusals drain as tabs reload onto 2026.10.09-3." },
    postmortem: {
      question: "Why were customers still blocked by a policy fixed the day before?",
      options: [
        "Payrail’s new host sent an X-Frame-Options header",
        "Their pages came from a precache holding the old policy",
        "The CDN stripped the updated Content-Security-Policy header from responses",
        "Banks only accept 3-D Secure challenges served from the redirect flow",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The CSP is a meta tag in index.html. The service worker for 2026.10.08-1 kept serving its precached index.html, whose frame-src predates Payrail’s 07:00 host move, to 60% of tabs.",
        why: "checkout.threeds_redirect_fallback only exists in 2026.10.09-3, which already allowed the new host. The kill switch made the old worker unregister and reload its tabs, so they fetched the current index.html and policy.",
        tell: "RUM showed the CSP refusal on 2026.10.08-1 only, its page served (ServiceWorker), and the new worker waiting to activate.",
      },
    },
    lostCheckoutsPerPoint: 110,
  },
  {
    slug: "retired-totals-endpoint",
    title: "Totals from an endpoint that’s gone",
    severity: "SEV1",
    opensAt: [9, 41],
    staleBuild: "2026.10.06-2",
    freshBuild: "2026.10.09-1",
    adoption: 0.42,
    adoptionPerSecond: 0.008,
    workers: [377, 384],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_reload_stale_tabs",
      description: "Old service workers unregister and reload the tabs they control",
      owner: WEB_PLATFORM,
      by: "nadia.haddad",
      ago: 45 * DAY,
      to: false,
      note: "game day over",
    },
    decoy: {
      key: "checkout.totals_client_fallback",
      description: "When the order totals call fails, compute totals in the browser from the cart",
      owner: CHECKOUT_WEB,
      by: "hana.sato",
      ago: 12 * DAY,
      to: false,
      note: "fallback built, left off (FE-2270)",
    },
    trouble: {
      kind: "defect",
      where: "client",
      failShare: 0.95,
      message: `[checkout] totals failed: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    },
    view: { name: "precache", description: "Precached app shells and the tabs still on them" },
    briefing:
      "Since 09:30, more than half of web customers see “We couldn’t calculate your total” and a disabled Pay button. The cart team retired GET /api/v1/cart/totals at 09:30, four days after the web app moved to v2.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. There’s a client-side totals fallback behind a flag. Find out which build still calls the old endpoint before you lean on it.",
    page: "SEV1 triggered — checkout loss > 30% on web for 5m; checkout-api 5xx 0.0%. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Maya Okonkwo · Support", text: "Pay is greyed out for a lot of web customers: “We couldn’t calculate your total”." },
      { at: 50, from: "Bruno Lima · Cart team", text: "We retired /api/v1/cart/totals at 09:30 (CART-880). Web moved to v2 in 2026.10.06-3, and v1 traffic had dropped a lot." },
      { at: 90, from: "Hana Sato · Web engineer", text: "checkout.totals_client_fallback computes totals in the browser if the call fails. Flip it on and Pay comes back." },
      { at: 140, from: "Jorge Alvarez · Web platform", text: "Dropped a lot is not zero: tabs open since before Tuesday still run whatever shell the service worker precached." },
      { at: 220, from: "Elena Ruiz · VP Engineering", text: "This is SEV1 money. Do we bring v1 back or fix the web side?" },
    ],
    hints: [
      "The endpoint was retired after the web app stopped calling it. Find out which build is still calling it.",
      "The error says the response wasn’t JSON. What does a retired route send back instead?",
      "Ask whether the code behind the flag you’re about to flip is running in the failing tabs at all.",
    ],
    look: [
      { command: "rum errors", why: "The totals call gets an HTML 404 page back and fails JSON parsing." },
      { command: "rum overview", why: "58% of web sessions run 2026.10.06-2, the last build that called v1." },
      { command: "rum precache", why: "The 2026.10.06-2 worker still controls 58% of tabs; 2026.10.09-1’s worker waits." },
    ],
    killNote: "precached 2026.10.06-2 calls retired v1 totals",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.09-1, which calls v2 totals.",
    verify: { command: "rum overview", why: "2026.10.06-2’s share falls toward 0% and orders recover." },
    postmortem: {
      question: "Why was it safe-looking but wrong to retire the v1 totals endpoint at 09:30?",
      options: [
        "Cart-service still needed v1 to warm its cache",
        "Precached tabs still ran a build that called it",
        "The 2026.10.09-1 build silently fell back to v1 whenever v2 answered slowly under load",
        "The CDN routed a share of v2 requests to the v1 handler",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A Workbox service worker kept 58% of web tabs on 2026.10.06-2, which called GET /api/v1/cart/totals. When the route was retired, those tabs got an HTML 404 page and couldn’t compute a total.",
        why: "checkout.totals_client_fallback only exists in newer builds, which already call v2. The kill switch made the old worker unregister and reload its tabs onto 2026.10.09-1.",
        tell: "RUM put the JSON parse error on 2026.10.06-2 only, and the precache view showed its worker controlling most tabs.",
      },
    },
    lostCheckoutsPerPoint: 280,
  },
  {
    slug: "payday-precached-resubmits",
    title: "Payday at midnight, last week’s resubmits",
    severity: "SEV1",
    opensAt: [0, 6],
    staleBuild: "2026.10.03-2",
    freshBuild: "2026.10.09-6",
    adoption: 0.25,
    adoptionPerSecond: 0.009,
    workers: [366, 421],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "pwa.legacy_worker_eject",
      description: "Old service workers unregister themselves and reload their tabs from the network",
      owner: WEB_PLATFORM,
      by: "jorge.alvarez",
      ago: 150 * DAY,
      to: false,
      note: "eject drill done",
    },
    decoy: {
      key: "checkout.resubmit_on_timeout",
      description: "Resubmit POST /checkout automatically when it times out or returns 5xx",
      owner: CHECKOUT_WEB,
      by: "web-release-bot",
      ago: 5 * HOUR,
      to: true,
      note: "web 2026.10.09-6 (FE-2350): resubmits with backoff and an Idempotency-Key",
    },
    trouble: {
      kind: "storm",
      chargesPerSecond: 165,
      surgeRps: 500,
      surgeSeconds: 40,
      gatewayStatus: "Elevated latency in eu-west — merchants should retry with backoff (since 23:40)",
    },
    view: { name: "worker-versions", description: "Service worker builds and the tabs each controls" },
    briefing:
      "Payday traffic hit at midnight while payment-gateway was already slow. Checkout is failing in a storm. Last week’s web build resubmitted instantly on timeout; 2026.10.09-6, the only build the CDN serves, backs off behind checkout.resubmit_on_timeout.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. Turning resubmits off is the textbook storm fix. Check which build is sending the storm before you count on it.",
    page: "SEV1 triggered — checkout-api 5xx > 30% since 00:00. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Sam Tan · Eng manager", text: "Payday surge plus a slow gateway. Turn checkout.resubmit_on_timeout off and let it drain?" },
      { at: 50, from: "Maya Okonkwo · Support", text: "Customers report Pay spinning for ages, and a few were charged twice." },
      { at: 95, from: "Priya Shah · Frontend lead", text: "2026.10.09-6 already backs off with idempotency keys. Whatever sends four requests a tap isn’t that build." },
      { at: 140, from: "Jorge Alvarez · Web platform", text: "Payday customers leave the shop open in a tab for days, waiting. Those tabs keep the shell the worker precached." },
      { at: 220, from: "Elena Ruiz · VP Engineering", text: "Payday is our biggest hour of the month. What’s the ETA?" },
    ],
    hints: [
      "The build the CDN serves backs off. Find out which build the retrying sessions run.",
      "The customers in the storm opened the shop days ago and never closed the tab.",
      "Turning retries off in code that isn’t running changes nothing.",
    ],
    look: [
      { command: "rum overview", why: "75% of web sessions run 2026.10.03-2 at four requests per Pay tap." },
      { command: "rum session", why: "The sampled session loaded 2026.10.03-2 from the service worker and resubmits with no Idempotency-Key." },
      { command: "rum worker-versions", why: "The 2026.10.03-2 worker still controls 75% of tabs; 2026.10.09-6’s waits." },
    ],
    killNote: "old worker pins payday tabs to 2026.10.03-2",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.09-6, which backs off.",
    verify: { command: "rum overview", why: "2026.10.03-2 drains toward 0% and REQ/TAP falls; checkout recovers once the gateway queue clears." },
    postmortem: {
      question: "Why didn’t turning checkout.resubmit_on_timeout off stop the storm?",
      options: [
        "The flag took more than ten minutes to stream to tabs",
        "The storming tabs ran a build that hard-codes its resubmits",
        "payment-gateway kept retrying our calls internally and amplified them",
        "checkout-api retried each gateway call three times before it answered",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 75% of web tabs on 2026.10.03-2, which resubmits every timeout instantly without an Idempotency-Key. The payday surge met a slow gateway and those tabs turned it into a storm.",
        why: "checkout.resubmit_on_timeout only switches 2026.10.09-6 between backoff and no retry. The kill switch made the old worker unregister and reload its tabs onto 2026.10.09-6, and the gateway queue drained.",
        tell: "RUM showed 75% of sessions on 2026.10.03-2 at 4.00 requests per tap, served (ServiceWorker), with the new worker waiting.",
      },
    },
    lostCheckoutsPerPoint: 1000,
  },
  {
    slug: "revoked-vault-key",
    title: "Card tokens from a revoked key",
    severity: "SEV2",
    opensAt: [6, 18],
    staleBuild: "2026.10.08-2",
    freshBuild: "2026.10.10-2",
    adoption: 0.3,
    adoptionPerSecond: 0.011,
    workers: [398, 407],
    cacheName: `marlow-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_emergency_unregister",
      description: "Old service workers unregister and reload their tabs; new page loads are unaffected",
      owner: WEB_PLATFORM,
      by: "nadia.haddad",
      ago: 88 * DAY,
      to: false,
      note: "post-drill reset",
    },
    decoy: {
      key: "checkout.vault_token_refresh",
      description: "Re-mint the card token once when checkout-api reports it can’t use it",
      owner: CHECKOUT_WEB,
      by: "ana.costa",
      ago: 9 * DAY,
      to: false,
      note: "shipped dark for key rotations (FE-2288)",
    },
    trouble: {
      kind: "defect",
      where: "server",
      failShare: 0.85,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"vault: token minted with publishable key pk_live_2025q3 (revoked 2026-10-10T06:00Z)"}',
    },
    view: { name: "registrations", description: "Service worker registrations for checkout-web" },
    briefing:
      "At 06:00 payments revoked last quarter’s vault publishable key on schedule. Since then, most card checkouts on web fail with a 500. 2026.10.10-2, the only build the CDN serves, embeds the new key.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. The rotation runbook says to turn on token refresh if checkouts fail after a key change. Find which build mints the bad tokens first.",
    page: "SEV2 triggered — checkout-api 5xx > 5% on POST /checkout since 06:00, web only. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Ravi Menon · Payments platform", text: "pk_live_2025q3 was revoked at 06:00 as planned. The web build with the new key went out yesterday evening." },
      { at: 55, from: "Ana Costa · Web engineer", text: "checkout.vault_token_refresh is exactly for this: it re-mints the token with the current key. Rotation runbook, step 3." },
      { at: 100, from: "Maya Okonkwo · Support", text: "Card payments fail on the laptop, then work on the phone. Apple Pay works everywhere." },
      { at: 150, from: "Jorge Alvarez · Web platform", text: "The key is compiled into app.js, and app.js is precached. Anyone who hasn’t closed the tab since Wednesday has the old one." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "We planned this rotation for a month. Why are we down?" },
    ],
    hints: [
      "The new key shipped before the old one was revoked. Find out which build the failing checkouts come from.",
      "Wallet payments don’t mint a card token, and they work.",
      "Code that re-mints tokens only helps where it’s running.",
    ],
    look: [
      { command: "rum errors", why: "checkout-api rejects tokens minted with the revoked publishable key." },
      { command: "rum overview", why: "70% of web sessions still run 2026.10.08-2, and that release carries all the 500s." },
      { command: "rum registrations", why: "The 2026.10.08-2 worker controls 70% of tabs; 2026.10.10-2’s worker, with the new key, waits." },
    ],
    killNote: "precached app.js still embeds revoked pk_live_2025q3",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.10-2, which mints tokens with the new key.",
    verify: { command: "rum overview", why: "2026.10.08-2’s share and its 500s fall toward zero." },
    postmortem: {
      question: "Why did checkouts fail after a rotation planned for a month?",
      options: [
        "The vault cached the revoked key for an hour after 06:00",
        "Precached tabs kept a build that embeds the revoked key",
        "The new publishable key was never added to checkout-api’s allow-list before the switch",
        "Token refresh was off, so every token expired at 06:00",
      ],
      answerIndex: 1,
      explanation: {
        cause: "The publishable key is compiled into app.js. A service worker kept 70% of web tabs on 2026.10.08-2, so when pk_live_2025q3 was revoked their card tokens stopped working.",
        why: "checkout.vault_token_refresh only exists in newer builds, which already use the new key. The kill switch made the old worker unregister and reload its tabs onto 2026.10.10-2.",
        tell: "RUM put every 500 on 2026.10.08-2, and the registrations view showed its worker controlling 70% of tabs.",
      },
    },
    lostCheckoutsPerPoint: 200,
  },
  {
    slug: "decimal-amount-field",
    title: "Amounts the API stopped reading",
    severity: "SEV1",
    opensAt: [11, 7],
    staleBuild: "2026.10.04-1",
    freshBuild: "2026.10.08-5",
    adoption: 0.38,
    adoptionPerSecond: 0.01,
    workers: [359, 399],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_hard_reload",
      description: "Old service workers unregister and hard-reload the tabs they control",
      owner: WEB_PLATFORM,
      by: "jorge.alvarez",
      ago: 120 * DAY,
      to: false,
      note: "drill done",
    },
    decoy: {
      key: "checkout.send_legacy_amount",
      description: "Also send the deprecated decimal amount field beside amount_minor",
      owner: CHECKOUT_WEB,
      by: "kofi.mensah",
      ago: 2 * DAY,
      to: false,
      note: "amount_minor only from 2026.10.08-5 (FE-2318)",
    },
    trouble: {
      kind: "defect",
      where: "server",
      failShare: 1,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"order.total: amount_minor is required (got amount=58.4)"}',
    },
    view: { name: "app-shell", description: "App shell builds served by service workers" },
    briefing:
      "checkout-api finished removing the decimal amount field at 11:00, a week after web moved to amount_minor. Since then a large share of web checkouts fail with a 500. The apps are fine.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. The API team suggests turning the legacy amount back on from the web side. Check which build is sending what before you do.",
    page: "SEV1 triggered — checkout-api 5xx > 10% on POST /checkout since 11:00, web only. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Grace Oduya · Checkout API", text: "We dropped `amount` at 11:00 as announced. Web has sent amount_minor since 2026.10.08-5." },
      { at: 55, from: "Kofi Mensah · Web engineer", text: "checkout.send_legacy_amount puts `amount` back in the request. Flip it on and the API is happy again." },
      { at: 100, from: "Maya Okonkwo · Support", text: "Lots of “Something went wrong” on web. Customers who refresh the page say it works." },
      { at: 150, from: "Jorge Alvarez · Web platform", text: "A refresh only helps once the old worker lets go. Normal navigations inside the app stay on the precached shell." },
      { at: 220, from: "Elena Ruiz · VP Engineering", text: "Do we roll the API back or not? I need a call in five minutes." },
    ],
    hints: [
      "The new web build stopped sending the old field days ago. Find out which build sends the failing requests.",
      "The flag adds a field in code that already sends the new one.",
      "Ask why a week-old build would still be running.",
    ],
    look: [
      { command: "rum errors", why: "checkout-api answers 500 because the request has `amount` and no amount_minor." },
      { command: "rum overview", why: "62% of web sessions run 2026.10.04-1, which predates amount_minor; all the 500s are there." },
      { command: "rum app-shell", why: "The 2026.10.04-1 worker controls 62% of tabs; the 2026.10.08-5 worker waits." },
    ],
    killNote: "old shell sends decimal amount only",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.08-5, which sends amount_minor.",
    verify: { command: "rum overview", why: "2026.10.04-1 drains and its 500s go with it." },
    postmortem: {
      question: "Which tabs were still sending the removed amount field?",
      options: [
        "Tabs whose flag SDK hadn’t streamed the new flag value",
        "Tabs a service worker kept on the pre-amount_minor build",
        "Tabs behind corporate proxies that rewrote the JSON request body before it reached us",
        "Tabs in Safari, whose number parsing drops integer types",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 62% of web tabs on 2026.10.04-1, which only sends the decimal `amount`. When checkout-api removed that field at 11:00, every checkout from those tabs failed.",
        why: "checkout.send_legacy_amount only exists in 2026.10.08-5, which already sends amount_minor. The kill switch made the old worker unregister and reload its tabs onto 2026.10.08-5.",
        tell: "RUM put every 500 on 2026.10.04-1, with the app-shell view showing its worker controlling 62% of tabs.",
      },
    },
    lostCheckoutsPerPoint: 260,
  },
  {
    slug: "renamed-next-day-method",
    title: "Next-day delivery from a stale list",
    severity: "SEV2",
    opensAt: [13, 33],
    staleBuild: "2026.10.07-1",
    freshBuild: "2026.10.10-3",
    adoption: 0.33,
    adoptionPerSecond: 0.012,
    workers: [385, 410],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_force_update",
      description: "Old service workers unregister and reload their tabs so they pick up the deployed build",
      owner: WEB_PLATFORM,
      by: "nadia.haddad",
      ago: 70 * DAY,
      to: false,
      note: "drill complete",
    },
    decoy: {
      key: "checkout.next_day_delivery",
      description: "Offer next-day delivery on the shipping step",
      owner: "team-fulfilment-web",
      by: "lena.ortiz",
      ago: 60 * DAY,
      to: true,
      note: "next-day back for autumn (FUL-120)",
    },
    trouble: {
      kind: "defect",
      where: "server",
      failShare: 0.3,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"shipping-rates: unknown method id \\"next_day\\""}',
    },
    view: { name: "sw-builds", description: "Service worker builds across checkout tabs" },
    briefing:
      "Fulfilment renamed its shipping method ids at 13:00 when the new carrier went live. Since then, web customers who pick next-day delivery get a 500 at Pay. 2026.10.10-3 loads the method list from shipping-rates; older builds bundled it.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. Turning off the failing option is the usual move. Find out which build still offers the old id first.",
    page: "SEV2 triggered — checkout-api 5xx > 2% on POST /checkout since 13:00, web only. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Lena Ortiz · Fulfilment web", text: "Next-day is the only option failing. I can turn checkout.next_day_delivery off and nobody can pick it." },
      { at: 60, from: "Dmitri Volkov · Fulfilment", text: "Carrier switch at 13:00: next_day is now nd-dpd-1200. shipping-rates rejects the old id." },
      { at: 110, from: "Maya Okonkwo · Support", text: "Next-day customers get an error at Pay. Some say switching to standard works." },
      { at: 160, from: "Jorge Alvarez · Web platform", text: "Builds before Thursday hard-code the shipping options in the bundle. If tabs still run one, it’s the service worker." },
      { at: 230, from: "Sam Tan · Eng manager", text: "Did turning off next-day help? The graph looks the same." },
    ],
    hints: [
      "Only one delivery option fails. Find out which build is sending its old id.",
      "The current build asks shipping-rates for its options; an older one may carry its own list.",
      "Hiding an option only works in code that reads the switch.",
    ],
    look: [
      { command: "rum errors", why: "shipping-rates rejects the retired id next_day." },
      { command: "rum overview", why: "67% of web sessions run 2026.10.07-1, which bundles the old method list; the 500s sit there." },
      { command: "rum sw-builds", why: "The 2026.10.07-1 worker controls 67% of tabs; 2026.10.10-3’s worker waits." },
    ],
    killNote: "old shell bundles retired shipping ids",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.10-3, which fetches current method ids.",
    verify: { command: "rum errors", why: "The unknown-method 500s drain as tabs reload." },
    postmortem: {
      question: "Why did turning off next-day delivery leave the errors in place?",
      options: [
        "shipping-rates cached the old method list for an hour",
        "The failing tabs ran a build with its own hard-coded options",
        "Customers had already chosen next-day earlier and their saved carts kept the old method id",
        "The flag only applies to logged-in customers",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 67% of web tabs on 2026.10.07-1, which bundles shipping options with the old next_day id. After the 13:00 carrier switch, shipping-rates rejected it.",
        why: "checkout.next_day_delivery is read by newer builds, which already fetch current ids. The kill switch made the old worker unregister and reload its tabs onto 2026.10.10-3.",
        tell: "RUM put the unknown-method 500s on 2026.10.07-1, and its worker controlled two thirds of tabs.",
      },
    },
    lostCheckoutsPerPoint: 70,
  },
  {
    slug: "promo-codes-array",
    title: "Promo codes from a cached form",
    severity: "SEV2",
    opensAt: [10, 2],
    staleBuild: "2026.10.05-3",
    freshBuild: "2026.10.09-2",
    adoption: 0.36,
    adoptionPerSecond: 0.009,
    workers: [371, 403],
    cacheName: `marlow-web-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_unregister_previous",
      description: "Workers older than the deployed build unregister and reload their tabs",
      owner: WEB_PLATFORM,
      by: "jorge.alvarez",
      ago: 55 * DAY,
      to: false,
      note: "drill finished",
    },
    decoy: {
      key: "checkout.promo_code_box",
      description: "Show the promo code box on the review step",
      owner: "team-growth",
      by: "lena.ortiz",
      ago: 4 * HOUR,
      to: true,
      note: "Autumn Sale codes live",
    },
    trouble: {
      kind: "defect",
      where: "server",
      failShare: 0.45,
      message: '[checkout] POST /checkout 500 {"error":"internal","trace":"promotions: promo_codes must be an array (got string \\"AUTUMN25\\")"}',
    },
    view: { name: "worker-status", description: "Service worker status per build" },
    briefing:
      "promotions-service switched to stacked codes at 09:50 and now only accepts promo_codes as a list. Since then, web checkouts with a promo code fail with a 500. 2026.10.09-2 sends the list; the Autumn Sale codes went live this morning.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. Growth wants to hide the promo box until it’s sorted. Find which build sends the old shape first.",
    page: "SEV2 triggered — checkout-api 5xx > 3% on POST /checkout since 09:50, web only. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Lena Ortiz · Growth", text: "Every failure has a promo code. I can hide the box with checkout.promo_code_box off while you look." },
      { at: 60, from: "Omar Farouk · Promotions", text: "Stacked codes went live at 09:50: promo_codes is an array now. Web was updated on Thursday." },
      { at: 110, from: "Maya Okonkwo · Support", text: "Sale customers can’t pay with AUTUMN25. Without the code it goes through." },
      { at: 160, from: "Jorge Alvarez · Web platform", text: "Thursday’s build only reaches a tab once the worker from before it lets go." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "Hiding the promo box during the sale is going to cost us too. Is there a better option?" },
    ],
    hints: [
      "Only checkouts with a code fail. Find out which build sends them.",
      "The current build already sends codes the new way.",
      "Hiding the box changes the page that reads the switch, not the one that failed.",
    ],
    look: [
      { command: "rum errors", why: "promotions rejects promo_codes sent as a string." },
      { command: "rum overview", why: "64% of web sessions run 2026.10.05-3; all the 500s come from that release." },
      { command: "rum worker-status", why: "The 2026.10.05-3 worker controls 64% of tabs; 2026.10.09-2’s worker waits." },
    ],
    killNote: "old shell sends promo_codes as a string",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.09-2, which sends a list.",
    verify: { command: "rum overview", why: "2026.10.05-3 drains, and promo checkouts succeed again." },
    postmortem: {
      question: "Why did promo checkouts keep failing after promotions’ change was announced and web had shipped for it?",
      options: [
        "promotions-service rejected AUTUMN25 as expired",
        "A service worker kept most tabs on the pre-change build",
        "The web build that sends a list never made it to the CDN, which still served Tuesday’s files",
        "Growth’s flag sent the code twice",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 64% of web tabs on 2026.10.05-3, which sends promo_codes as a string. After promotions switched to lists at 09:50, every promo checkout from those tabs failed.",
        why: "checkout.promo_code_box is read by newer builds, which already send a list. The kill switch made the old worker unregister and reload its tabs onto 2026.10.09-2.",
        tell: "RUM put every 500 on 2026.10.05-3, and the worker view showed it controlling most tabs.",
      },
    },
    lostCheckoutsPerPoint: 110,
  },
  {
    slug: "tv-ad-instant-retries",
    title: "The TV ad and the tabs that never closed",
    severity: "SEV1",
    opensAt: [20, 48],
    staleBuild: "2026.10.06-5",
    freshBuild: "2026.10.10-4",
    adoption: 0.28,
    adoptionPerSecond: 0.01,
    workers: [380, 412],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_self_destruct",
      description: "Old service workers unregister, clear their caches and reload their tabs",
      owner: WEB_PLATFORM,
      by: "nadia.haddad",
      ago: 33 * DAY,
      to: false,
      note: "self-destruct test done",
    },
    decoy: {
      key: "web.pay_autoretry",
      description: "Retry the Pay request automatically when it times out or returns 5xx",
      owner: CHECKOUT_WEB,
      by: "priya.shah",
      ago: 3 * DAY,
      to: true,
      note: "autoretry rebuilt with backoff and Idempotency-Key (FE-2302)",
    },
    trouble: {
      kind: "storm",
      chargesPerSecond: 175,
      surgeRps: 520,
      surgeSeconds: 40,
      gatewayStatus: "Partial outage, card authorisations slow — retry with exponential backoff (since 20:30)",
    },
    view: { name: "sw-controllers", description: "Which service worker controls checkout tabs" },
    briefing:
      "The autumn TV ad aired at 20:45 while payment-gateway was having a partial outage. Checkout is in a retry storm. The old instant autoretry was rebuilt with backoff three days ago in 2026.10.10-4, behind web.pay_autoretry.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. Turning autoretry off is the obvious storm fix. Find out which build is doing the retrying first.",
    page: "SEV1 triggered — checkout-api 5xx > 30% since the 20:45 TV spot. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Priya Shah · Frontend lead", text: "web.pay_autoretry off should stop the storm. That build backs off anyway, but off is off." },
      { at: 50, from: "Maya Okonkwo · Support", text: "Viewers coming from the ad say Pay spins forever. A couple were charged twice." },
      { at: 100, from: "Sam Tan · Eng manager", text: "Gateway is asking merchants to back off. We are hammering them." },
      { at: 150, from: "Jorge Alvarez · Web platform", text: "People who browsed during the week left tabs open and came back for the ad offer. Those tabs keep their precached shell." },
      { at: 220, from: "Elena Ruiz · VP Engineering", text: "We paid for prime time. Every minute counts." },
    ],
    hints: [
      "Count requests per Pay tap for each build that’s running.",
      "Customers who came back to an old tab after the ad are running something older than the deployed build.",
      "A retry switch can only stop retries in code that reads it.",
    ],
    look: [
      { command: "rum overview", why: "72% of web sessions run 2026.10.06-5 at four requests per Pay tap." },
      { command: "rum session", why: "The sampled 2026.10.06-5 session loaded from the service worker and retries with no Idempotency-Key." },
      { command: "rum sw-controllers", why: "The 2026.10.06-5 worker controls 72% of tabs; 2026.10.10-4’s worker waits." },
    ],
    killNote: "old worker keeps ad traffic on instant retries",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.10-4, which backs off.",
    verify: { command: "rum overview", why: "2026.10.06-5’s share and REQ/TAP fall; the gateway queue drains." },
    postmortem: {
      question: "What kept the retry storm going after web.pay_autoretry went off?",
      options: [
        "The TV ad kept sending new customers for an hour",
        "Old tabs ran a precached build with hard-coded instant retries",
        "checkout-api’s own retries to the gateway doubled every failed call it received from the web",
        "The flag change was stuck in the SDK’s offline queue",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 72% of web tabs on 2026.10.06-5, whose autoretry fires instantly with no Idempotency-Key. The ad surge met a slow gateway and those tabs held the storm.",
        why: "web.pay_autoretry only switches 2026.10.10-4 between backoff and no retry. The kill switch made the old worker unregister and reload its tabs onto 2026.10.10-4, and the gateway queue drained.",
        tell: "RUM showed 72% of sessions on 2026.10.06-5 at 4.00 requests per tap, served (ServiceWorker).",
      },
    },
    lostCheckoutsPerPoint: 1000,
  },
  {
    slug: "cart-storage-schema",
    title: "The cart a newer tab rewrote",
    severity: "SEV2",
    opensAt: [15, 12],
    staleBuild: "2026.10.07-3",
    freshBuild: "2026.10.10-5",
    adoption: 0.4,
    adoptionPerSecond: 0.011,
    workers: [390, 414],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_retire_old_workers",
      description: "Retire workers older than the deployed build: unregister and reload their tabs",
      owner: WEB_PLATFORM,
      by: "jorge.alvarez",
      ago: 41 * DAY,
      to: false,
      note: "retire drill done",
    },
    decoy: {
      key: "checkout.cart_from_server",
      description: "Load the cart from cart-service at checkout instead of from local storage",
      owner: CHECKOUT_WEB,
      by: "hana.sato",
      ago: 6 * DAY,
      to: false,
      note: "server cart ready, off pending load test (FE-2296)",
    },
    trouble: {
      kind: "defect",
      where: "client",
      failShare: 0.7,
      message: "TypeError: Cannot read properties of undefined (reading 'lineItems')",
    },
    view: { name: "tab-builds", description: "Service worker builds controlling open checkout tabs" },
    briefing:
      "Since 15:00, a large share of web customers tap Pay and nothing happens. 2026.10.10-5 went out at 14:55 and migrates the cart in local storage to a new shape. Its own checkout works in every test.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. Checkout can read the cart from the server instead of local storage, behind a flag. Find which build is crashing before you use it.",
    page: "SEV2 triggered — checkout loss > 15% on web since 15:00; checkout-api 5xx 0.0%. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Hana Sato · Web engineer", text: "If local storage is the problem, checkout.cart_from_server skips it entirely. It’s ready, just not load tested." },
      { at: 60, from: "Maya Okonkwo · Support", text: "Pay does nothing for some customers. Those who open the shop in a new tab say it works there." },
      { at: 110, from: "Kofi Mensah · Web engineer", text: "2026.10.10-5 writes marlow:cart as {version: 5, cart: {...}}. Old code expected lineItems at the top level." },
      { at: 160, from: "Jorge Alvarez · Web platform", text: "Local storage is shared by every tab on the origin. A new tab migrates it, and an old tab on the precached shell reads the new shape." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "The release passed QA. What changed at 15:00?" },
    ],
    hints: [
      "The new build works in tests. Find which build the crashing sessions run.",
      "Two tabs on one site share their storage, even when they run different code.",
      "A setting only changes code that reads it.",
    ],
    look: [
      { command: "rum errors", why: "Pay crashes reading lineItems from a cart that has no such field." },
      { command: "rum overview", why: "60% of web sessions still run 2026.10.07-3, which expects the old cart shape." },
      { command: "rum tab-builds", why: "The 2026.10.07-3 worker controls 60% of tabs; 2026.10.10-5’s worker waits." },
    ],
    killNote: "old tabs crash on the migrated cart shape",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.10-5, which reads the new cart shape.",
    verify: { command: "rum errors", why: "The lineItems TypeError drains as tabs reload." },
    postmortem: {
      question: "Why did old tabs start crashing when 2026.10.10-5 went out?",
      options: [
        "The release deleted every saved cart",
        "New tabs migrated the shared cart storage old code reads",
        "Chrome cleared local storage for the site when the new service worker was installed in the background",
        "cart-service returned carts with a missing field",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 60% of web tabs on 2026.10.07-3. Fresh tabs on 2026.10.10-5 rewrote the shared marlow:cart entry in the new shape, and the old tabs crashed reading lineItems.",
        why: "checkout.cart_from_server only exists in newer builds, which already read the new shape. The kill switch made the old worker unregister and reload its tabs onto 2026.10.10-5.",
        tell: "RUM put the lineItems TypeError on 2026.10.07-3 only, and the tab-builds view showed its worker controlling most tabs.",
      },
    },
    lostCheckoutsPerPoint: 190,
  },
  {
    slug: "sdk-integrity-mismatch",
    title: "A pinned hash for a file that changed",
    severity: "SEV1",
    opensAt: [12, 19],
    staleBuild: "2026.10.08-4",
    freshBuild: "2026.10.10-6",
    adoption: 0.32,
    adoptionPerSecond: 0.01,
    workers: [400, 416],
    cacheName: `marlow-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_flush_and_reload",
      description: "Old service workers flush their precache, unregister and reload their tabs",
      owner: WEB_PLATFORM,
      by: "nadia.haddad",
      ago: 77 * DAY,
      to: false,
      note: "flush drill done",
    },
    decoy: {
      key: "checkout.payrail_sri",
      description: "Add a Subresource Integrity hash to the payrail.js script tag",
      owner: CHECKOUT_WEB,
      by: "ana.costa",
      ago: 26 * DAY,
      to: true,
      note: "SRI on payrail.js (SEC-210)",
    },
    trouble: {
      kind: "defect",
      where: "client",
      failShare: 0.88,
      message:
        "Failed to find a valid digest in the 'integrity' attribute for resource 'https://js.payrail.example/v3/payrail.js' with computed SHA-384 integrity 'q9D0aQ3tRk1nW7c2pYbLm4ZsXv8eHfJgUo5iNr6TyKdA0lCbE3MxGwPzSuVhIjQn'. The resource has been blocked.",
    },
    view: { name: "worker-builds", description: "Builds served by each service worker" },
    briefing:
      "Payrail updated payrail.js in place at 12:00. Since then, card payments on web fail to load the card field for most customers. 2026.10.10-6 loads the script by versioned URL and hash; the security team wants SRI kept on.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. Turning the integrity check off is everyone’s first idea. Find which page carries the stale hash before you do.",
    page: "SEV1 triggered — checkout loss > 25% on web since 12:00; checkout-api 5xx 0.0%. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Ana Costa · Web engineer", text: "Payrail changed the file and the hash no longer matches. checkout.payrail_sri off drops the integrity attribute." },
      { at: 60, from: "Leah Brandt · Security", text: "Please don’t turn off SRI on a payments script unless there’s no other way." },
      { at: 110, from: "Ravi Menon · Payments platform", text: "Payrail confirms a 12:00 hotfix to v3/payrail.js. The versioned URL with its own hash didn’t change." },
      { at: 160, from: "Jorge Alvarez · Web platform", text: "The script tag and its hash are in index.html, which the old worker precached." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "Most card payments are down at lunchtime. What are we doing?" },
    ],
    hints: [
      "The current build loads the script in a way the vendor’s change didn’t break. Find what the failing sessions load.",
      "The integrity hash lives in the page itself. Ask where those customers got their page.",
      "Removing a check helps only where the switch is read.",
    ],
    look: [
      { command: "rum errors", why: "Chrome blocks payrail.js because its hash no longer matches the page’s integrity attribute." },
      { command: "rum session", why: "The sampled session runs 2026.10.08-4 and loaded its page from the service worker." },
      { command: "rum worker-builds", why: "The 2026.10.08-4 worker controls 68% of tabs; 2026.10.10-6’s worker waits." },
    ],
    killNote: "precached page pins the old payrail.js hash",
    killWhy: "The old worker flushes and reloads its tabs onto 2026.10.10-6, which loads the versioned script with a matching hash.",
    verify: { command: "rum errors", why: "The integrity errors drain while SRI stays on." },
    postmortem: {
      question: "Why didn’t turning off the integrity check help the failing customers?",
      options: [
        "Chrome caches SRI failures for the whole session",
        "Their precached page has the hash baked in and never reads the flag",
        "Payrail’s CDN served a different file to each region, so no single hash could match them all",
        "The flag only applies to new card forms",
      ],
      answerIndex: 1,
      explanation: {
        cause: "Payrail changed v3/payrail.js in place at 12:00. A service worker kept 68% of web tabs on 2026.10.08-4, whose precached index.html pins the old SHA-384 hash, so Chrome blocked the script.",
        why: "checkout.payrail_sri is read by newer builds, which load a versioned URL whose hash still matches. The kill switch moved the old tabs onto 2026.10.10-6, keeping SRI on.",
        tell: "RUM put the integrity error on 2026.10.08-4 only, its page served (ServiceWorker), with the new worker waiting.",
      },
    },
    lostCheckoutsPerPoint: 260,
  },
  {
    slug: "removed-graph-field",
    title: "Shipping quotes the schema forgot",
    severity: "SEV1",
    opensAt: [10, 21],
    staleBuild: "2026.10.03-6",
    freshBuild: "2026.10.09-4",
    adoption: 0.45,
    adoptionPerSecond: 0.009,
    workers: [362, 404],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_evict_stale",
      description: "Evict stale service workers: unregister and reload the tabs they control",
      owner: WEB_PLATFORM,
      by: "jorge.alvarez",
      ago: 110 * DAY,
      to: false,
      note: "evict drill done",
    },
    decoy: {
      key: "checkout.static_shipping_rates",
      description: "Skip the shipping quote query and charge flat-rate shipping",
      owner: CHECKOUT_WEB,
      by: "kofi.mensah",
      ago: 50 * DAY,
      to: false,
      note: "flat-rate fallback for carrier outages (FE-2150)",
    },
    trouble: {
      kind: "defect",
      where: "client",
      failShare: 0.9,
      message: '[checkout] GraphQL error: Cannot query field "shippingQuote" on type "Cart". Did you mean "shippingQuotes"?',
    },
    view: { name: "sw-tabs", description: "Service workers and the checkout tabs they hold" },
    briefing:
      "storefront-graph removed the deprecated Cart.shippingQuote field at 10:15 after six weeks of deprecation. Since then, most web customers can’t get past the shipping step. 2026.10.09-4 queries shippingQuotes.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. The carrier runbook has a flat-rate shipping fallback. Find which build still asks for the old field first.",
    page: "SEV1 triggered — checkout loss > 25% on web since 10:15; checkout-api 5xx 0.0%. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Kofi Mensah · Web engineer", text: "checkout.static_shipping_rates skips the quote query and charges flat rate. Not pretty, but customers can pay." },
      { at: 60, from: "Yuki Tanaka · Storefront graph", text: "shippingQuote was deprecated on 29 Aug and removed at 10:15. Our usage dashboard showed web traffic on it falling for weeks." },
      { at: 110, from: "Maya Okonkwo · Support", text: "Customers are stuck on shipping with “Couldn’t load delivery options”. A new browser window fixes it." },
      { at: 160, from: "Jorge Alvarez · Web platform", text: "Falling isn’t gone. Tabs on a precached shell from early October still send that query." },
      { at: 230, from: "Elena Ruiz · VP Engineering", text: "Do we put the field back or fix it on web? Pick one." },
    ],
    hints: [
      "The deployed build stopped asking for that field weeks ago. Find who is still asking.",
      "A new window fixes it for customers. What does a new window skip?",
      "A fallback in new code can’t rescue a page that doesn’t have it.",
    ],
    look: [
      { command: "rum errors", why: "The shipping query asks for Cart.shippingQuote, which the schema no longer has." },
      { command: "rum overview", why: "55% of web sessions run 2026.10.03-6, the last build that queried the old field." },
      { command: "rum sw-tabs", why: "The 2026.10.03-6 worker controls 55% of tabs; 2026.10.09-4’s worker waits." },
    ],
    killNote: "old shell queries removed Cart.shippingQuote",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.09-4, which queries shippingQuotes.",
    verify: { command: "rum overview", why: "2026.10.03-6 drains, and customers get past shipping." },
    postmortem: {
      question: "Why did removing a field that web no longer used break web checkout?",
      options: [
        "storefront-graph removed shippingQuotes by mistake",
        "Precached tabs still ran a build that queried the old field",
        "The persisted-query cache kept serving the deprecated query text to the newest build",
        "Mobile apps proxied their queries through the web app",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 55% of web tabs on 2026.10.03-6, which queries Cart.shippingQuote. When the field was removed at 10:15, those tabs couldn’t load delivery options.",
        why: "checkout.static_shipping_rates only exists in newer builds, which already query shippingQuotes. The kill switch made the old worker unregister and reload its tabs onto 2026.10.09-4.",
        tell: "RUM put the GraphQL error on 2026.10.03-6 only, and the sw-tabs view showed its worker holding most tabs.",
      },
    },
    lostCheckoutsPerPoint: 300,
  },
  {
    slug: "presale-precached-retries",
    title: "Presale rush on a shell from last week",
    severity: "SEV1",
    opensAt: [9, 3],
    staleBuild: "2026.10.02-1",
    freshBuild: "2026.10.08-3",
    adoption: 0.3,
    adoptionPerSecond: 0.008,
    workers: [355, 396],
    cacheName: `marlow-precache-v2-${SITE}`,
    killSwitch: {
      key: "pwa.unregister_outdated",
      description: "Outdated service workers unregister and reload their tabs from the network",
      owner: WEB_PLATFORM,
      by: "nadia.haddad",
      ago: 60 * DAY,
      to: false,
      note: "drill complete",
    },
    decoy: {
      key: "checkout.retry_slow_pay",
      description: "Retry the Pay request when it is slow or fails",
      owner: CHECKOUT_WEB,
      by: "web-release-bot",
      ago: 2 * DAY,
      to: true,
      note: "web 2026.10.08-3 (FE-2311): Pay retries with backoff and an Idempotency-Key",
    },
    trouble: {
      kind: "storm",
      chargesPerSecond: 170,
      surgeRps: 470,
      surgeSeconds: 50,
      gatewayStatus: "Degraded performance — high authorisation latency; retry with backoff (since 08:50)",
    },
    view: { name: "sw-versions", description: "Service worker versions and their share of tabs" },
    briefing:
      "The limited-edition presale opened at 09:00 with payment-gateway already degraded. Checkout is in a retry storm. 2026.10.08-3 replaced last week’s instant Pay retries with backoff, behind checkout.retry_slow_pay.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. Retries off is the standard storm play. Check which build is retrying before you rely on it.",
    page: "SEV1 triggered — checkout-api 5xx > 30% since the 09:00 presale. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Sam Tan · Eng manager", text: "Presale plus a degraded gateway. checkout.retry_slow_pay off and wait for it to drain?" },
      { at: 50, from: "Maya Okonkwo · Support", text: "Presale buyers say Pay spins and spins. Two were charged twice for one pair." },
      { at: 100, from: "Priya Shah · Frontend lead", text: "2026.10.08-3 can’t send four requests a tap. Its retries are budgeted and keyed." },
      { at: 150, from: "Jorge Alvarez · Web platform", text: "Presale fans opened the product page days ago and kept it open to be first in. Those tabs are on whatever the worker precached then." },
      { at: 220, from: "Elena Ruiz · VP Engineering", text: "The presale sells out in minutes either way. I need it working now." },
    ],
    hints: [
      "Compare requests per Pay tap across the builds customers run.",
      "The fans who waited longest for the presale opened their tabs before the fixed build existed.",
      "Switching off retries in one build leaves another build’s retries alone.",
    ],
    look: [
      { command: "rum overview", why: "70% of web sessions run 2026.10.02-1 at four requests per Pay tap." },
      { command: "rum session", why: "The sampled 2026.10.02-1 session loaded from the service worker and retries with no Idempotency-Key." },
      { command: "rum sw-versions", why: "The 2026.10.02-1 worker controls 70% of tabs; 2026.10.08-3’s worker waits." },
    ],
    killNote: "presale tabs pinned to instant-retry build",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.08-3, which backs off.",
    verify: { command: "rum overview", why: "2026.10.02-1 drains and REQ/TAP falls; checkout recovers once the gateway queue clears." },
    postmortem: {
      question: "Why did the storm hold after checkout.retry_slow_pay went off?",
      options: [
        "Presale bots were retrying through the API directly",
        "Tabs on last week’s precached build retry no matter the flag",
        "payment-gateway queued and replayed our timed-out calls as fresh authorisations for every merchant",
        "The flag only reaches logged-in customers",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 70% of web tabs on 2026.10.02-1, whose Pay retries fire instantly with no Idempotency-Key. The presale rush met a degraded gateway and those tabs held the storm.",
        why: "checkout.retry_slow_pay only switches 2026.10.08-3 between backoff and no retry. The kill switch made the old worker unregister and reload its tabs onto 2026.10.08-3, and the gateway queue drained.",
        tell: "RUM showed 70% of sessions on 2026.10.02-1 at 4.00 requests per tap, served (ServiceWorker), with the new worker waiting.",
      },
    },
    lostCheckoutsPerPoint: 1000,
  },
  {
    slug: "preflight-header-trim",
    title: "A header the API no longer allows",
    severity: "SEV2",
    opensAt: [8, 14],
    staleBuild: "2026.10.05-1",
    freshBuild: "2026.10.09-5",
    adoption: 0.37,
    adoptionPerSecond: 0.01,
    workers: [369, 409],
    cacheName: `workbox-precache-v2-${SITE}`,
    killSwitch: {
      key: "web.sw_drop_legacy",
      description: "Legacy service workers unregister and reload the tabs they control",
      owner: WEB_PLATFORM,
      by: "jorge.alvarez",
      ago: 80 * DAY,
      to: false,
      note: "legacy drop drill done",
    },
    decoy: {
      key: "checkout.same_origin_api",
      description: "Send checkout calls through www.marlow.example/api instead of api.marlow.example",
      owner: CHECKOUT_WEB,
      by: "hana.sato",
      ago: 15 * DAY,
      to: false,
      note: "same-origin proxy built for CORS incidents (FE-2260)",
    },
    trouble: {
      kind: "defect",
      where: "client",
      failShare: 1,
      message:
        "Access to fetch at 'https://api.marlow.example/checkout' from origin 'https://www.marlow.example' has been blocked by CORS policy: Request header field x-cart-signature is not allowed by Access-Control-Allow-Headers in preflight response.",
    },
    view: { name: "controllers", description: "Service worker controllers across checkout tabs" },
    briefing:
      "The API gateway team trimmed the CORS allowed-headers list at 08:00 to headers current builds send. Since then, a third of web checkouts never leave the browser. 2026.10.09-5 stopped sending X-Cart-Signature last week.",
    roleBriefing: "You own checkout-web: the flags CLI and RUM. There’s a same-origin route that sidesteps CORS behind a flag. Find which build sends the dropped header first.",
    page: "SEV2 triggered — checkout loss > 20% on web since 08:00; checkout-api 5xx 0.0%. Assigned to frontend on-call.",
    comms: [
      { at: 20, from: "Hana Sato · Web engineer", text: "CORS errors? checkout.same_origin_api routes checkout through our own origin, so no preflight at all." },
      { at: 60, from: "Femi Adeyemi · API gateway", text: "We trimmed Access-Control-Allow-Headers at 08:00 to what 2026.10.09-5 sends. X-Cart-Signature hasn’t been used since then." },
      { at: 110, from: "Maya Okonkwo · Support", text: "About a third of web customers say Pay does nothing. A different browser works." },
      { at: 160, from: "Jorge Alvarez · Web platform", text: "“Since then” only counts tabs that have reloaded. The worker from 5 Oct still controls plenty of them." },
      { at: 230, from: "Sam Tan · Eng manager", text: "Do we revert the gateway config? It was a security cleanup." },
    ],
    hints: [
      "The header that’s refused isn’t sent by the build the CDN serves. Find which build sends it.",
      "A different browser works for customers. What does a fresh browser not have?",
      "A route change in new code can’t move requests made by old code.",
    ],
    look: [
      { command: "rum errors", why: "Chrome blocks the checkout call: the preflight no longer allows x-cart-signature." },
      { command: "rum overview", why: "63% of web sessions run 2026.10.05-1, the last build that sends the header." },
      { command: "rum controllers", why: "The 2026.10.05-1 worker controls 63% of tabs; 2026.10.09-5’s worker waits." },
    ],
    killNote: "old shell sends dropped x-cart-signature header",
    killWhy: "The old worker unregisters and reloads its tabs onto 2026.10.09-5, which doesn’t send the header.",
    verify: { command: "rum errors", why: "The CORS errors drain as tabs reload, with the trimmed header list kept." },
    postmortem: {
      question: "Why did the CORS cleanup break checkout for a third of web customers?",
      options: [
        "The API gateway dropped Access-Control-Allow-Origin",
        "Precached tabs still sent a header the new list left out",
        "Chrome began enforcing a stricter preflight cache on all cross-origin POST requests that morning",
        "The same-origin route was already on and conflicted with CORS",
      ],
      answerIndex: 1,
      explanation: {
        cause: "A service worker kept 63% of web tabs on 2026.10.05-1, which sends X-Cart-Signature. When the API gateway trimmed its allowed headers at 08:00, every preflight from those tabs failed.",
        why: "checkout.same_origin_api only exists in newer builds, which no longer send the header. The kill switch made the old worker unregister and reload its tabs onto 2026.10.09-5.",
        tell: "RUM put every CORS error on 2026.10.05-1, and the controllers view showed its worker controlling 63% of tabs.",
      },
    },
    lostCheckoutsPerPoint: 250,
  },
];

/** Frontend tier-4 incidents: the usual flag fix does nothing because a service worker pins tabs to an older build. */
export const FRONTEND_TIER4_INCIDENTS: readonly Scenario[] = ROWS.map(incident);
