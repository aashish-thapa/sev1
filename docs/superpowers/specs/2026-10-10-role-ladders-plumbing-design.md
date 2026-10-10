# Role ladders, part 1: plumbing (tier pay, per-role ladders, rooms on solo rules)

Status: approved design, 2026-10-10. Branch: `feat/role-problem-ladders`.

Part of a three-part change. Part 2 adds incident cards for the four non-infra roles. Part 3 gives each of those roles its own War Room ladder. This part changes no content; it makes the game ready for both.

## Goal

- War Room pay rises with the incident's difficulty (its tier), not just its score.
- Each role has its own War Room ladder, unlocked by career level, and solo play, practice and rooms all draw from it by the same rule.
- A room plays an incident the host picks from that ladder, and colleagues cover any paged role no player in the room holds, exactly as they do in solo play.

## Current behaviour (for reference)

- Incident pay is `points × 600` cents for any tier (`amountOf` in `src/domain/economy.ts`).
- The server caps each sync's incident earnings at `paidIncidents × 100 × 600` (`MAX_INCIDENT_CENTS` in `src/domain/audit.ts`).
- `Tier` (1–5) is defined in `src/warroom/scenario.ts`, and an identical `SolutionTier` in `src/domain/purchases.ts`.
- `unlockedWarRooms` and `practiceWarRooms` in `src/warroom/scenarios/index.ts` branch on `role !== "infrastructure"`: infra gets its five-incident ladder, every other role only `checkoutMeltdown` (tier 5), at every level.
- `App.tsx` creates every room with `TEAM_SCENARIO.id`. The protocol's `create` message already carries any `scenarioId`, and joining clients already resolve the room's scenario by id.
- Solo colleagues run in `useIncident`'s reducer through `applyTeamwork(incident, scenario, playerRole, done)`. The room server (`server/room.ts`) never runs them, so in a room a paged role nobody holds stays unfixed.

## Design

### 1. One home for `Tier`

`Tier = 1 | 2 | 3 | 4 | 5` moves to the domain layer (new `src/domain/tier.ts`, with the tier ladder's one-line meaning from `scenario.ts`). `src/warroom/scenario.ts` imports and re-exports it; `purchases.ts` drops `SolutionTier` and uses `Tier`. `audit.ts`'s `TierOf` returns `Tier | undefined`.

### 2. Pay by tier

In `src/domain/economy.ts`, replace `INCIDENT_CENTS_PER_POINT` with one integer table:

```ts
/** Each debrief point is worth this much, by tier: a perfect tier-1 run pays $600, a perfect tier-5 run $3,600. */
export const INCIDENT_CENTS_PER_POINT_BY_TIER: Readonly<Record<Tier, number>> = { 1: 600, 2: 900, 3: 1_500, 4: 2_400, 5: 3_600 };
```

- The incident `Payment` gains `readonly tier: Tier`: the tier it is **paid at**, not necessarily the incident's. `amountOf` pays `round(points) × INCIDENT_CENTS_PER_POINT_BY_TIER[tier]` when `points >= INCIDENT_MIN_POINTS`, else 0.
- **Pay is capped at the tier the player's level unlocks** (user decision): a domain function `paidTier(tier, level)` returns `min(tier, level + 1)`. Without it, an Intern could host a meltdown room alone, let colleagues cover the other roles, and draw tier-5 pay. It also means non-infra roles still on the interim meltdown earn at their level's rate.
- `useShiftGame.ts` builds the payment with `tier: paidTier(scenario.tier, careerLevel(progress).level)`, using the level before the run is recorded. Solo and room runs both go through this one call site, so both pay the same way. `recordWarRoom`'s `scenario` parameter gains `tier`.
- Money stays integer cents throughout. No multiplier is stored as a float.
- Ledger lines already record the amount, so saved wallets need no migration.
- Card pay is unchanged: it already scales with card difficulty (`CARD_BONUS_CENTS`).

### 3. Server check, per line

`isPlausibleWallet` in `src/domain/audit.ts` keeps an aggregate backstop and adds a per-line check:

- **Backstop (kept):** `MAX_INCIDENT_CENTS` becomes `100 × max(INCIDENT_CENTS_PER_POINT_BY_TIER)`, and a sync's incident earnings stay within `paidIncidents × MAX_INCIDENT_CENTS`. Removing it would let a forged save mint money: a fresh line labelled with another reason, or an evicted ledger, leaves no incident line for the per-line check to see while `earnedCents.incident` grows.
- **Per-reason consistency:** when no lines were evicted, the fresh lines of each reason must sum to that reason's `earnedCents` delta, which closes the mislabelled-reason path outright.
- **Per line:** each fresh `incident` line has its scenario id parsed from its ref (`incident:<scenarioId>:<runStartedAt>`, built by `payRef.incident`; the parser lives next to `payRef`). It is refused when the catalogue (`tierOf`) does not know the scenario, and when its amount exceeds `100 × INCIDENT_CENTS_PER_POINT_BY_TIER[paidTier(tier, topLevel)]`, where `topLevel` is the level the save reaches (generous by one promotion, as the salary check already is).
- `isPlausibleWallet` has no `tierOf` today, so `isPlausibleProgress` builds an incident-pricing predicate next to `isFairPrice` and passes it down. Direct wallet tests pass a stub catalogue.

The count check (`incidents > seconds / MIN_SECONDS_PER_INCIDENT + EVENT_ALLOWANCE`) stays. When the ledger cap evicted lines, the per-line check runs on the lines still present and the backstop covers the rest. The Worker already passes `(id) => findScenario(id)?.tier`, so no Worker change is needed beyond types. The ref itself is client-written, so any run could be labelled with a harder scenario's id; the level cap bounds what that buys, consistent with the client-held-wallet trust model.

Solution prices stay as they are (user decision). With tier pay, a perfect run of tiers 2–4 now pays more than that tier's solution costs at its unlock level; a run with a bought solution still pays nothing (`useShiftGame.ts`), so nothing is exploitable. The `purchases.ts` header and its test are reworded to what remains true: price climbs with tier and seniority, and buying forfeits the run's bonus and experience.

### 4. Per-role ladders

In `src/warroom/scenarios/index.ts`:

```ts
/** Each role's own War Rooms, easiest first. A role's ladder grows as its incidents are written. */
const LADDERS: Readonly<Record<Role, readonly Scenario[]>> = {
  infrastructure: [scaledToZero, crashOnCheckout, oomAfterDeploy, checkoutPoolLeak, ordersIndexInvalid],
  frontend: [], mobile: [], security: [], data: [],
};
```

- `unlockedWarRooms(role, level)`: the role's ladder plus `checkoutMeltdown`, filtered by `isUnlocked` (tier ≤ level + 1), hardest first. The meltdown is tier 5, so in solo it arrives at Staff.
- **Interim rule:** a role whose own ladder is still empty keeps the meltdown at every level, as today. It stops applying once the ladder has a scenario.
- **Empty pool guard:** if a role's *unlocked pool* is empty (e.g. a ladder whose easiest rung is tier 2, played by an Intern), solo play falls back to the meltdown. `soloScenarioFor` must never index an empty pool.
- `soloScenarioFor` and `practiceWarRooms` use the same pool. Pro's "every released War Room for their role" is the role's ladder plus the meltdown, regardless of level.
- Side effect, intended: Infra Staff now also get the meltdown in their solo rotation.
- No more `role !== "infrastructure"` branches. `INFRA_SOLO` is replaced by `LADDERS.infrastructure`.

### 5. Rooms on solo rules

- New `roomWarRooms(role, level)` in `scenarios/index.ts`: the host's `unlockedWarRooms` plus the meltdown, which is always offered in rooms whatever the level (it is the team incident). Hardest first, no duplicates.
- The create-room form (`src/ui/Briefing.tsx`, wired in `App.tsx`) gets an incident picker listing `roomWarRooms(role, careerLevel(progress).level)` by title and tier, defaulting to the meltdown. `rooms.onCreate` gains a `scenarioId` argument and passes the chosen id instead of `TEAM_SCENARIO.id`. The form's copy ("Nobody can fix it alone") describes the chosen incident instead of assuming the meltdown.
- The server accepts any scenario id its catalogue knows (it already rejects unknown ones). It does **not** verify that the host's level unlocks the incident: like the client-held wallet, the unlock is trusted to the client. PLAN.md's "Anti-cheat" item covers making this server-side later.
- Anyone can join, whatever their role. A player whose role the incident doesn't page can use the shell and chat and gets the team payout, the same as today's meltdown rooms where every role is paged.

### 6. Colleagues in rooms

- `applyTeamwork(incident, scenario, coveredRoles: ReadonlySet<Role>, done)` replaces the `playerRole` parameter: a playbook step runs only for a role not in `coveredRoles`. Solo passes `new Set([role])`.
- `Room` (`server/room.ts`) keeps a `teamworkDone` set. In `tick()`, it runs `applyTeamwork` on `advance`'s result with the roles of every seat in `this.seats`, makes **one** commit (one frame per tick), then posts each colleague's message to comms. Held seats stay in `this.seats` until they expire, so a disconnected player inside the 60 s grace counts as covered and a colleague doesn't take a reconnecting player's job.
- Because `RoomObject` runs the same `Room`, one change covers the Node server and the Durable Object.
- A player who joins after a colleague already did their role's step finds it done. That's the same outcome as a colleague arriving first in solo.

## Out of scope

- New incident cards (Part 2) and new War Room scenarios (Part 3).
- Server-verified unlocks and server-decided payouts (PLAN.md "Later: Anti-cheat").
- Changes to card pay, salary or solution prices.

## Testing

- `economy.test.ts`: pay per tier for the same points; zero below `INCIDENT_MIN_POINTS` at every tier; `paidTier` caps an Intern's tier-5 run at tier 1 and leaves Staff's at tier 5.
- New `audit.test.ts`: a tier-5 line at the tier-5 cap passes for a Staff save; the same amount on a tier-1 scenario, or from an Intern save, is refused; an incident line for an unknown scenario is refused; a forged save that credits `earnedCents.incident` through a line of another reason is refused; the per-sync count limit still holds.
- `ladder.test.ts`: infra's pool by level is unchanged below Staff; a role with an empty ladder gets the meltdown at Intern; an empty unlocked pool falls back to the meltdown; the meltdown joins solo pools at Staff; `roomWarRooms` always includes the meltdown.
- `teamwork.test.ts`: covered roles are never automated; an uncovered role's step runs.
- `multiplayer.test.ts` (on `checkoutMeltdown`, whose early playbook steps fit the test's wait): a room with only an infra seat runs the other roles' colleague steps and posts their messages; a seated role's step never runs; a held (disconnected) seat still counts as covered.
- Existing suites stay green: `pnpm test`, `pnpm lint`, `tsc -b` (via `pnpm build`).
