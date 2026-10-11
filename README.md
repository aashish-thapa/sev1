# sev1

A game for on-call engineers, in two modes:

- **Quick shift** — twelve incident cards a day, easiest first. Read the alert, the graph and the logs, make the call.
- **War Room** — one live, simulated outage. Inspect the system on a 2D service map or **walk the server hall in 3D**, fight it from a bastion shell (`kubectl`, `psql`, `curl`), declare it resolved, survive ten minutes of monitoring, then write the postmortem.

Players pick a **role** — Infra/SRE, Frontend, Mobile, Security or Data & ML. The whole game is one office: each role has a room with a wall screen where its daily problems are talked through (voiced by the colleague at the screen), the library mixes everyone's, and the pager can go off at any time. Every role has its own **ladder** of War Rooms, tier 1 (guided, one cause, one fix) to tier 4 (the usual fix does nothing); a tier opens at the career level one below it, and **Checkout meltdown** — tier 5, cross-team, nobody can fix it alone — opens at Staff. A shared room (4-letter code, up to 5 people) plays whatever its host picks from their own unlocked ladder, or the meltdown, which every room may pick. Solo or shared, named colleagues cover any paged role no player holds, from the scenario's playbook. War Room pay scales with the tier, capped at the tier the player's level unlocks.

Sound is synthesized in the browser (Web Audio) and colleagues speak through the Web Speech API — no audio files, no accounts.

## Run it

```sh
pnpm install
pnpm dev                 # http://localhost:5173 (proxies /rooms to the room server)
pnpm server              # multiplayer room server on :8787 (PORT, HOST, ALLOWED_ORIGINS, MAX_ROOMS)
pnpm test                # domain + storage tests
pnpm validate:content    # schema + answer-length checks on every incident pack
pnpm build               # validate content, type-check, bundle, generate the PWA service worker
```

## How it's put together

| Path | Job |
|---|---|
| `src/domain/` | Pure game rules: incident schema (Zod), shift planning, Elo rating, progress/streaks, local calendar day. No React, no storage. |
| `src/content/packs/*.json` | Incident cards. Parsed against `IncidentCardSchema` at load; the app refuses to start on an invalid pack. |
| `src/storage/` | `ProgressStore` interface + browser (localStorage, fails soft) and in-memory implementations. |
| `src/app/` | `useShiftGame` wires domain to storage; `App` routes briefing → shift → report. |
| `src/ui/` | Screens and components. Evidence renderers are a typed map keyed by evidence `type` — a new evidence kind is a new renderer, not an edited switch. |
| `src/warroom/sim/` | Pure, deterministic cluster simulator: pods, rolling updates, connection pools, Postgres limits, build *traits* (defects) the engine applies. Operator actions are pure functions. |
| `src/warroom/shell/` | Bastion shell: tokenizer, command registry (`kubectl`, `psql`, `curl`, …). Commands read and act on the cluster only through the sim's state and actions. |
| `src/warroom/scenarios/` | One file per live incident: starting cluster, what "fixed" means, comms timeline, postmortem. `index.ts` holds each role's ladder (`LADDERS`); `checkout-commerce.ts` builds the shop around the cluster that non-infra incidents play in. |
| `src/warroom/floor/` | The walkable 3D hall (three.js + React Three Fiber), lazy-loaded. `layout.ts` maps the live cluster to racks and `player.ts` handles walking/collision — both pure and unit-tested. Colours come from the CSS design tokens. |
| `src/audio/` | Synthesized SFX, ambience/alarm/heartbeat loops, a voice director over `speechSynthesis`, and `soundscapeFor(panic, zone…)`. |
| `src/multiplayer/`, `server/` | Room protocol (Zod), delta-encoded incident frames, `RoomClient` + `useRoom`, and the authoritative Node `ws` room server that runs the same simulation. |
| `src/warroom/teamwork.ts` | Colleagues run the scenario's `teamPlaybook` for every paged role no player holds, in solo play and in rooms alike. |
| `src/warroom/ui/` | War Room screens: isometric service map, inspect panel, terminal, HUD, debrief. |
| `src/main.tsx` | Composition root: builds the library, store and clock and hands them to `App`. |

Nothing runs an LLM at play time. Content is static JSON, so hosting costs stay near zero.

## Adding a War Room scenario

Write a `Scenario` in `src/warroom/scenarios/`: build the starting cluster, give the bad revision a trait the engine understands (add a new trait kind to `sim/model.ts` and its physics to `sim/engine.ts` if needed), define `isRootCauseFixed`, a comms timeline and the postmortem. If fixing it doesn't move checkout 5xx (a WAF blocking customers, refunds, fraud declines), give it an `alertMetric`: the rate the pager watches, which also gates "resolved". Non-infra incidents build their shop with `checkoutCommerce()` and put role-specific tool output in `evidence`. Add it to `SCENARIOS` and to its role's `LADDERS` entry at the right tier. Then add strategy tests like `src/warroom/warroom.test.ts`: doing nothing must get worse, the right fix must close, plausible wrong fixes must backfire.

## 3D assets

The office's people, furniture, surfaces and lighting are third-party assets built into `public/office/` and committed, so a normal clone needs nothing extra. To change or rebuild them:

```sh
pnpm assets:fetch                                          # sources → .asset-cache/ (~1.2 GB, gitignored)
nix-shell -p blender --run "pnpm assets:build"             # or put Blender 5 on PATH / set BLENDER=
```

- **What exists** is named once in `src/warroom/floor/assets/catalog.ts`. **Where it comes from** is in `scripts/assets/manifest.ts`.
- **People and animations:** Microsoft Rocketbox (MIT). Headless Blender converts FBX to glTF (`scripts/assets/rocketbox.py`) and pins walk root motion in place.
- **Furniture, PBR surfaces and the HDRI:** Poly Haven (CC0).
- **Compression:** everything is resized to 1K WebP and meshopt-compressed. Licence notices are in `public/office/CREDITS.md`.

## Writing incident cards

Every card must pass `pnpm validate:content`. Beyond the schema, the rules that keep it credible:

- **Error strings must be verbatim** from the real software (checked against its source or docs). App-specific log lines for fictional services may use their own wording.
- **Exactly one answer** must follow from the evidence, and the explanation names the *tell*.
- **Distractors must be plausible first suspects**, and the correct option may not be more than 4 characters longer than the longest distractor (enforced).
- **Sources**: link a real public postmortem or doc only after confirming the URL resolves.

## Design notes

Built with the Hallmark anti-slop rules (bespoke route). Tokens live in `src/styles/tokens.css`; every colour and font in `app.css` references a token. The sparkline series colour was validated with the dataviz palette validator against the card surface. Checked at 320/375/414/768 px with no horizontal scroll.

## Deploying

The game runs live at https://sev1.aashish-thapa.workers.dev on Cloudflare's free tier. Cloudflare serves the static site, runs one Durable Object per multiplayer room, and stores accounts and the money ledger in D1. The full plan and free-tier budget are in `docs/PLAN.md`.

```sh
pnpm exec wrangler login --device   # once; the device flow works over SSH
pnpm db:migrate                     # apply new worker/migrations to the live D1
pnpm release                        # test, build and deploy the committed HEAD (never uncommitted work)
```

### Billing (Stripe, Pro subscription)

Pro is sold through Stripe Checkout and managed in Stripe's Customer Portal. What an account has paid for (`entitlements` in D1) changes only when a signed Stripe webhook arrives; the browser never decides it. Paying never buys rank, XP, leaderboard position, hints or worked solutions. Until the four Stripe values below exist, every `/api/billing/*` route answers 503 and the rest of the game works as before.

1. **Stripe dashboard, test mode:** create a product "sev1 Pro" with two recurring prices, one monthly and one yearly, and copy both price ids (`price_…`). Under *Settings → Billing → Customer portal*, activate the portal (cancel and update payment method).
2. **Webhook:** in Workbench → Webhooks, create a destination with the snapshot payload for your account. Point it at `https://sev1.aashish-thapa.workers.dev/api/billing/webhook` with these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`

   Copy its signing secret (`whsec_…`).
3. **Secrets:** you enter these yourself; they never go in the repo. Wrangler secrets survive deploys.
   ```sh
   pnpm exec wrangler secret put STRIPE_SECRET_KEY       # sk_test_… from Developers → API keys
   pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_… from step 2
   pnpm exec wrangler secret put STRIPE_PRICE_PRO_MONTHLY  # monthly price_… from step 1
   pnpm exec wrangler secret put STRIPE_PRICE_PRO_YEARLY   # yearly price_… from step 1
   pnpm db:migrate                                       # creates entitlements + stripe_events
   ```
4. **Test:** in the game, sign in, start checkout, and pay with Stripe's test card `4242 4242 4242 4242`. `/api/me` should then show `entitlements.proUntil`.

Routes:
- `POST /api/billing/checkout` (signed in): send `{ plan: "pro-monthly" | "pro-yearly" }`; returns `{ url }` for Checkout.
- `POST /api/billing/portal` (signed in): returns `{ url }` for the portal.
- `POST /api/billing/webhook` (Stripe only, signature-checked, idempotent by event id).
- `GET /api/me` includes `entitlements: { proUntil, cosmetics }` for accounts.

For local work, put the four values in an env file and run `wrangler dev --env-file <file>`.
