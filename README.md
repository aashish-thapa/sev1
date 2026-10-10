# sev1

A game for on-call engineers, in two modes:

- **Quick shift** — twelve incident cards a day, easiest first. Read the alert, the graph and the logs, make the call.
- **War Room** — one live, simulated outage. Inspect the system on a 2D service map or **walk the server hall in 3D**, fight it from a bastion shell (`kubectl`, `psql`, `curl`), declare it resolved, survive ten minutes of monitoring, then write the postmortem.

Players pick a **role** — Infra/SRE, Frontend, Mobile, Security or Data & ML. The whole game is one office: each role has a room with a wall screen where its daily problems are talked through (voiced by the colleague at the screen), the library mixes everyone's, and the pager can go off at any time. Solo infra players get the pure infra outage; everyone else — and every shared room — gets **Checkout meltdown**, a cross-team incident nobody can fix alone. In solo play, named colleagues cover the other roles from the scenario's playbook; in a shared room (4-letter code, up to 5 people) real teammates do.

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
| `src/warroom/scenarios/` | One file per live incident: starting cluster, what "fixed" means, comms timeline, postmortem. |
| `src/warroom/floor/` | The walkable 3D hall (three.js + React Three Fiber), lazy-loaded. `layout.ts` maps the live cluster to racks and `player.ts` handles walking/collision — both pure and unit-tested. Colours come from the CSS design tokens. |
| `src/audio/` | Synthesized SFX, ambience/alarm/heartbeat loops, a voice director over `speechSynthesis`, and `soundscapeFor(panic, zone…)`. |
| `src/multiplayer/`, `server/` | Room protocol (Zod), delta-encoded incident frames, `RoomClient` + `useRoom`, and the authoritative Node `ws` room server that runs the same simulation. |
| `src/warroom/teamwork.ts` | Solo play: colleagues run the scenario's `teamPlaybook` for every role except yours. |
| `src/warroom/ui/` | War Room screens: isometric service map, inspect panel, terminal, HUD, debrief. |
| `src/main.tsx` | Composition root: builds the library, store and clock and hands them to `App`. |

Nothing runs an LLM at play time. Content is static JSON, so hosting costs stay near zero.

## Adding a War Room scenario

Write a `Scenario` in `src/warroom/scenarios/`: build the starting cluster, give the bad revision a trait the engine understands (add a new trait kind to `sim/model.ts` and its physics to `sim/engine.ts` if needed), define `isRootCauseFixed`, a comms timeline and the postmortem. Then add strategy tests like `src/warroom/warroom.test.ts`: doing nothing must get worse, the right fix must close, plausible wrong fixes must backfire.

## Writing incident cards

Every card must pass `pnpm validate:content`. Beyond the schema, the rules that keep it credible:

- **Error strings must be verbatim** from the real software (checked against its source or docs). App-specific log lines for fictional services may use their own wording.
- **Exactly one answer** must follow from the evidence, and the explanation names the *tell*.
- **Distractors must be plausible first suspects**, and the correct option may not be more than 4 characters longer than the longest distractor (enforced).
- **Sources**: link a real public postmortem or doc only after confirming the URL resolves.

## Design notes

Built with the Hallmark anti-slop rules (bespoke route). Tokens live in `src/styles/tokens.css`; every colour and font in `app.css` references a token. The sparkline series colour was validated with the dataviz palette validator against the card surface. Checked at 320/375/414/768 px with no horizontal scroll.
