# Role ladders, part 2: incident cards for every role

Status: approved design, 2026-10-10. Branch: `feat/role-problem-ladders`.

## Goal

Frontend, Mobile, Security and Data & ML each have 10 Quick-shift cards (3 easy, 4 medium, 3 hard); Infra has 50. A Senior or Staff shift asks for 6–8 hard cards a day, so these roles repeat their three hard cards at once. Add 10 cards to each of the four roles, 40 in all, weighted to the hard end.

The shift planner already matches card difficulty to career level (`RAMP_BY_LEVEL` in `src/domain/shift.ts`: difficulty 1 is Intern work, 2 Engineer, 3 Senior and Staff), and card pay already scales with difficulty (`CARD_BONUS_CENTS`: $15 / $25 / $40). No code changes; this part is content only.

## What to add, per role

| Role | Pack file | Topics | Add (d1 / d2 / d3) | Total after |
|---|---|---|---|---|
| Frontend | `src/content/packs/frontend.json` | `frontend`, `web-performance` (about half each) | 2 / 3 / 5 | 20 (5 / 7 / 8) |
| Mobile | `src/content/packs/mobile.json` | `mobile` | 2 / 3 / 5 | 20 (5 / 7 / 8) |
| Security | `src/content/packs/security.json` | `security` | 2 / 3 / 5 | 20 (5 / 7 / 8) |
| Data & ML | `src/content/packs/data-ml.json` | `data-pipelines`, `machine-learning` (about half each) | 2 / 3 / 5 | 20 (5 / 7 / 8) |

Mix both kinds in each role: about half `diagnose` (four options) and half `find-line` (tap the guilty log or code line), as the existing packs do.

## What each difficulty means

- **1 (Intern/Junior):** one clear signal points at one cause. The evidence is short and the tell is on the page.
- **2 (Engineer):** two or three pieces of evidence must be read together, and one distractor is the obvious first suspect.
- **3 (Senior/Staff):** the obvious reading is wrong, the cause is second-order (a retry, a cache, a version skew, a race, a config default), or the guilty line looks innocent.

## Rules every card must follow

These come from the README ("Writing incident cards") and `scripts/validate-packs.ts`.

- It must parse against `IncidentCardSchema` (`src/domain/incident.ts`); mind the field limits (alert title ≤ 72, question ≤ 80, options ≤ 64, explanation cause ≤ 90, why ≤ 340, tell ≤ 200, log text ≤ 220, code line ≤ 100, 2–14 log lines, 2–24 code lines, 8–60 metric points, `firedAt` as `HH:MM`).
- Ids are unique across all packs, kebab-case, prefixed by role as the pack already does.
- **Error strings must be verbatim** from the real software, checked against its source or official docs. Log lines for fictional services may use their own wording.
- **Exactly one answer** follows from the evidence, and `explanation.tell` names the evidence that proves it.
- **Distractors are plausible first suspects.** The correct option may be at most 4 characters longer than the longest distractor (enforced).
- **Sources** are optional. Link a real public postmortem, advisory or doc only after confirming the URL resolves.
- No two cards teach the same lesson, within the new set or against the role's existing ten.

## Verification

- `pnpm validate:content` passes and reports 130 cards.
- `pnpm test` stays green.
- For each new card, the author records where each verbatim error string was checked (in the agent report, not in the repo).
