# Role ladders, part 3: a War Room ladder for every role

Status: approved for implementation, 2026-10-10. Branch: `feat/role-problem-ladders`. Depends on Part 1 (`LADDERS`, tier pay, rooms on solo rules), which lands first.

## Goal

Frontend, Mobile, Security and Data & ML each get four War Rooms of their own, one per tier 1–4, so every role climbs a ladder matched to career level (tier ≤ level + 1) instead of facing the tier-5 cross-team meltdown at every level. Each new scenario goes into `SCENARIOS` and its role's `LADDERS` entry in `src/warroom/scenarios/index.ts`. Once a role's ladder has a tier-1 rung, Part 1's interim rule stops applying to it.

Tier meanings (from `Tier`): 1 guided, one cause, one fix · 2 diagnose · 3 a plausible fix backfires · 4 the usual fix does nothing.

## Why this needs groundwork

A feasibility probe ran each role's fix against the simulator (no files changed; inline Node runs).

| Role | Does the role's own fix move cluster `errorRate`? |
|---|---|
| Frontend | Yes. A web retry storm sat at 46% 5xx and fell under 1% within ~160 s of `flags set checkout.auto_retry off`. |
| Mobile | Yes for retry storms and server-side 5xx (an iOS storm at 34% cleared ~190 s after `remote-config set … backoff`). No for client-side failures: fewer requests reach the cluster, so errorRate *falls* while customers are lost. |
| Security | No. WAF blocks are counted before the cluster (`commerce-step.ts:59`), so blocking customers shows 0% 5xx and `declareResolved` accepts at t=0. |
| Data & ML | No, at any tier. `reconcile` only touches the ledger and `warehouse` is read-only. |

So "resolved" needs a per-scenario signal, and Security and Data need new simulator physics.

## Foundation (one implementer, before any role)

### F-A. A resolve signal that isn't always 5xx

- `Scenario` gains `readonly alertMetric?: { readonly label: string; readonly rate: (state: ClusterState) => number }`: the number the incident pages on when that isn't checkout 5xx.
- `src/warroom/incident.ts`: `alertRate(scenario, cluster) = scenario.alertMetric?.rate(cluster) ?? cluster.errorRate`, used by `advance`'s reopen check and by `declareResolved(incident, scenario)` (signature change). Notices carry `rate` and `label` instead of `errorRate`.
- Update every caller and every hard-coded "5xx" wording: `server/room.ts`, `src/warroom/ui/useIncident.ts`, `server/notices.ts`, `IncidentHud.tsx` (HUD label), `WarRoomView.tsx` ("The faulty build was still running" becomes scenario-neutral), and the seven test files that call `declareResolved(incident)`.
- New pure helper `customerLossRate(commerce, t)` in `commerce-step.ts`: the share of organic checkout customers who ended the last second without an order (blocked, gave up, failed client-side, declined). It reads existing state only.
- Per scenario, not global: a global `max(errorRate, customer loss)` gate would make the meltdown's blunt `waf block --top 500` path undeclarable, which today is allowed and penalised in the debrief (`meltdown.test.ts:121-137`). Existing scenarios keep their behaviour.

### F-B. Rejections and declines on `Load`

`Load` (`commerce-step.ts`) gains `rejectedCheckoutShare` (client defects checkout-api answers with 5xx) and `declinedCheckoutShare` (fraud declines, a 402 before the gateway; not failed requests). `plainLoad` sets both to 0. `engine.ts` changes in exactly two places: thrown checkouts use `throwsOnCheckout(...) ? 1 : load.rejectedCheckoutShare`, and gateway calls are scaled by `1 - declinedCheckoutShare`. After this, no role edits `routeTraffic`.

### F-C. A commerce scenario builder

Make the meltdown's private `commerce()` (`checkout-meltdown.ts:45`) a reusable builder, and let `checkoutCluster` (`checkout-cluster.ts`) accept a `commerce` and a warm-up traffic profile. Defaults: no SIEM `alerts` (a cloned auto-contain alert silently blocked 39% of customers in the probe), every platform's retry `fixed none` unless the scenario is about retries, `podCapacityRps` 130 where overload matters, and a warm-up surge when a scenario needs a metastable retry storm (gateway capacity between organic and amplified demand).

### F-D. Scenario-supplied evidence and suggestions

- `Scenario.evidence?: readonly { tool: "siem" | "rum" | "warehouse" | "releases" | "models"; name: string; description: string; run: (state: ClusterState) => readonly string[] }[]`. Tools read it through `ShellContext.scenario` and list it beside their built-ins (`siem search`, `rum <name>`, `warehouse run`, …). It lives on the scenario, not in state, so it costs nothing on the wire. The tools' meltdown-specific branches (`siem show` detail, `SEARCHES`, `rum errors`, `warehouse` saved queries) move into the meltdown's `evidence`.
- `Scenario.suggestions?: Partial<Record<Role, readonly string[]>>`. `suggestionsFor` (`laptop-identity.ts`) returns `scenario.suggestions?.[role]` with today's chips as the meltdown's entry, and a neutral default for other scenarios; update `LiveIncident.tsx` and its test.

### F-E. Test harness

`solutions.test.ts`: the t=420 wait for `data` applies only to cross-team scenarios; the hint regex also accepts `rum`, `warehouse`, `curl`, `models`, `pipelines`.

### F-F. Scoring calibration (every new scenario)

A storm loses every organic checkout while the HUD shows only partial 5xx, so a correct run still loses thousands of checkouts. Each scenario sets `lostCheckoutsPerPoint` so that its worked solution closes at grade S or A (storms land near the meltdown's 1000).

### F-G. "Doing nothing gets worse"

Each scenario's no-action run must get worse over ten simulated minutes: its alert metric rises, or its debrief points fall as lost checkouts, orphans or fraud accumulate. Levers: attack growth (Security), phased-rollout adoption (Mobile), feature staleness and fraud captures (Data), lost checkouts (all).

### Wire format

All new state lives inside `Commerce` (`frame.ts` sends it whole as `z.custom<Commerce>`), so `frame.ts` needs no change. No new `Trait` kinds and no new `ClusterState`/`Database` fields: those are strict or field-listed in `frame.ts` and would be dropped or rejected in rooms. Every new scenario gets a frame round-trip test (pattern: `orders-index.test.ts:104-117`).

## Frontend ladder

New physics:
- **P1, flag- or config-triggered client defects:** `ClientBuild.defects?: { trigger: "always" | { flag; failsWhenOn } | { remoteConfig; failsWhen }; failShare; where: "server" | "client"; message }[]`. `clients.ts` blends the trigger with the existing flag/remote-config propagation; `commerceDemand` feeds `rejectedCheckoutShare` (server) or customer loss (client).
- **P2, service-worker rollout:** `Rollout | { kind: "service-worker"; killSwitchFlag; adoptionPerSecond }`; `stepRollout` grows adoption only while the kill-switch flag is on; `releases.ts`'s rollout label and `rum` overview/session handle it.

| Tier | id | Title | Cause and fix | Backfire / trap | Physics |
|---|---|---|---|---|---|
| 1 | `web-auto-retry-storm` | The Pay button won't stop | `checkout.auto_retry` on during a gateway slowdown; `flags set checkout.auto_retry off`. Root cause: `unsafeRetryShare < 0.001`. | Flipping `home.sale_banner` does nothing. | none |
| 2 | `address-autocomplete-500s` | Checkout broke after lunch | Three flags changed in the hour; `checkout.address_autocomplete` makes 60% of web checkouts 500. `rum errors` + `flags list` timing; turn it off. | Turning off the other flags changes nothing. | P1 |
| 3 | `dead-kill-switch` | The kill switch nobody tested | `checkout.v2_wallet_autofill` 500s 25% of web checkouts; turn it off. | `flags set checkout.payment_element_v2 off` puts everyone on the decommissioned v1 tokenizer: every web checkout 500s. | P1 |
| 4 | `stale-service-worker` | The rollback that didn't reach the browser | 70% of sessions still run the precached old build with `fixed immediate` retry; `flags set web.sw_kill_switch on`. Root cause: web adoption ≥ 0.99. | `flags set checkout.auto_retry off` does nothing: a fixed policy ignores flags. | P2 |

## Mobile ladder

New physics: P1 with a remote-config trigger; an **update wall** (segments below remote-config `min_supported_version` can't check out and count as lost); client-side defects; a per-build checkout-failure column in `releases status`. M3 and M4 use F-A with `customerLossRate`.

| Tier | id | Title | Cause and fix | Backfire / trap | Physics |
|---|---|---|---|---|---|
| 1 | `ios-retry-config` | The app keeps retrying | iOS 7.3.0 retry policy `immediate`; `remote-config set checkout_retry_policy backoff`. Keep the `set` at step ≤ 3 of the solution: the storm drains ~190 s after the change and the solutions test has a 5 s margin. | `releases halt ios 7.3.0` leaves it flat. | none |
| 2 | `android-staged-rollout-500s` | Android 7.3.0 breaks checkout | Growing Android staged rollout; `android_checkout_v2_enabled=true` 500s 80% of its checkouts. Set it false, then halt the release (objective). | Halting alone leaves errors flat above 0. A healthy iOS phased rollout is a distractor. | P1 (remote-config) |
| 3 | `forced-update-wall` | Force-update to a build that isn't out | iOS 7.3.0 500s half its checkouts while `checkout_address_v2_enabled`; turn it off. The fix build 7.3.1 is still in review. | `remote-config set min_supported_version 7.3.1` walls off 36% of customers: 5xx falls, customer loss rises, resolve refused. | update wall, F-A |
| 4 | `pinned-cert-rotation` | The apps can't reach the API | Infra rotated the API intermediate; all app builds pin the old key, so every mobile checkout fails client-side (~0% 5xx). `remote-config set api_pin_set <old>,<new>`. | Halting, feature flips and rollback do nothing. `api_pinning_mode report-only` restores checkout but fails the "pinning enforced" objective. | client defects, F-A |

## Security ladder

New physics **P3, attack traffic** (all tiers): `Commerce.attack?: { label; path; requestsPerSecond; growthPerSecond; sources: ranges (cidr, asn, network, ips) | residential proxies; ja4; userAgent }`; `WafRule.attackShare` (default 0, so the meltdown is unchanged); `edge.ts` computes attack load, attack share blocked per rule target (CIDR, top-N over the merged talker ranking, per-IP rate limit, JA4) and folds attacker IPs into `waf top`; `commerceDemand` adds unblocked attack rps, so the existing pod shedding raises errorRate and the existing gate works. New commands: `waf top --by asn`, `waf block --ja4 <fp>` (customer share from a small table of real browser/app fingerprints), and `siem resolve <id> --disposition true-positive --contained-by <rule>` (skips the blunt playbook).

| Tier | id | Title | Cause and fix | Backfire / trap |
|---|---|---|---|---|
| 1 | `bot-flood-single-ip` | One client is eating checkout | One hosting IP at ~9,000 req/min, growing; `waf block <ip>`. Objective: no customers blocked. | `waf block --top 500` also blocks 39% of customers. |
| 2 | `credential-stuffing-hosting` | Login storm from the cloud | ~120 hosting IPs across two ASNs; `waf ratelimit 20/1m` (0% of customers) or block the ranges, then resolve the alert true-positive. | A false-positive disposition closes the alert while the attack continues; resolve stays refused. |
| 3 | `card-testing-soar` | SOAR wants to block 500 IPs | ~4,000 IPs in one hosting /16 at ~3/min each; `waf top --by asn`, block the /16, resolve true-positive `--contained-by`. | Top-500 block, a plain true-positive, or waiting past the auto-contain timer blocks 35–39% of customers and barely touches the bots. |
| 4 | `residential-proxy-stuffing` | Bots that look like customers | ~40,000 residential IPs at ~0.5/min sharing one JA4; `waf block --ja4 <fp>`. | Rate limits miss the bots or hit customers; CIDR and top-N blocks mostly hit customers. |

Search content (auth summary, card velocity, TLS fingerprints) comes through F-D evidence.

## Data & ML ladder

D1 uses existing physics plus F-A. D2–D4 add **P4, fraud scoring** inside `Commerce`: `Commerce.fraud?: { model; versions (deployedAt, note, falseDeclineShare, catchShare); active; threshold; tunedThreshold; mode: "enforce" | "fail-open"; features (name, pipeline, lastSuccessAt, refresh); staleFeatureDeclineShare; fraudAttemptsPerSecond }` and `Ledger.fraudulentCaptures?`. Declines feed `declinedCheckoutShare` (lost, no retry, no gateway call); fraud that gets through joins the gateway queue in `settleCommerce`, so the existing queue turns a flood into timeouts and 5xx. New data-role commands, registered in `shell.ts` with an SSO group in `identity.ts`: `models list | show | rollback [--to] | threshold | mode | features` and `pipelines list | logs | run`. `alertMetric` is `customerLossRate` for D2–D4.

| Tier | id | Title | Cause and fix | Backfire / trap |
|---|---|---|---|---|
| 1 | `refund-double-charges` | Refund last night's double charges | A storm before the page left orphaned captures (ended more than 45 s before the page so the warehouse sees them). `alertMetric` is pending refunds / visible orphans. `warehouse run`, `reconcile preview`, `reconcile submit`. Objective: submitted before the settlement cut-off. | Declaring before submitting is refused. |
| 2 | `fraud-model-regression` | Good customers declined | fraud-scorer v13 declines 14% of good customers (v12: 0.4%); `models rollback fraud-scorer`. | A small real rise in fraud in comms is a distractor. |
| 3 | `fraud-threshold-fail-open` | Fail open, let the fraud in | Threshold moved 0.85 → 0.35 during an active card-testing ring; `models threshold fraud-scorer 0.85`. Objective: fraudulent captures below a bound. | `models mode … fail-open` floods the gateway (5xx for everyone) and fraud captures pile up; rollback does nothing. |
| 4 | `stale-fraud-features` | Every model declines them | `customer_orders_90d` is 30 h stale after a DAG failed on a renamed column; `pipelines logs`, `pipelines run features_customer_daily` (~60 s refresh). | Rollback does nothing (every version uses the feature); fail-open backfires as in tier 3. |

## Content rules

Every scenario has a briefing, role briefing, comms timeline, 2–4 hints (vaguest first, never the command), a worked `solution` for its role, a postmortem question with one defensible answer, and `releasedAt` left unset. Log lines from real software (TrustKit, Chrome, Postgres, Airflow, …) are verbatim and checked against source or docs; fictional services may use their own wording. Each scenario has a `teamPlaybook` only if it pages more than one role (none of these do).

## Testing (per scenario, in a `<role>-ladder.test.ts` per role)

- Doing nothing gets worse (F-G).
- The worked solution, run through the shell, closes at grade S or A (also covered by `solutions.test.ts`).
- Each listed backfire or trap is asserted: the wrong fix leaves the alert metric up, refuses resolve, or scores lower.
- Deterministic: two runs with the same seed match.
- Frame round-trip: the scenario's state survives `encodeFrame`/`applyFrame`.
- `ladder.test.ts`: each role's ladder unlocks tier by tier; Part 1's interim-rule test moves to a role with an empty ladder, or is replaced once all ladders are filled.

## Order and parallelism

1. Foundation (F-A … F-F) on top of Part 1.
2. Frontend and Security in parallel: P1/P2 and P3 add their own types and touch `commerceDemand` in separate helpers.
3. Mobile after Frontend (it extends P1 and shares `releases.ts`).
4. Data after Foundation; merges into `commerce-step.ts` last.

The orchestrator merges in that order and resolves textual conflicts in `commerce.ts` and `commerce-step.ts`.
