# sev1: game plan

sev1 is a startup simulator for engineers. You start with a job and earn money by fixing real-looking production problems. Later you spend that money to found, staff and run your own startup.

## Mode 1: Job mode (default, playable now)

You're an employee on call at a tech company. You don't need to sign up to play.

- **You pick a role.** Infra/SRE, Frontend, Mobile, Security or Data & ML. Your role decides which problems page you and which room is yours.
- **Every useful minute earns money.**

  | Source | What you earn |
  |---|---|
  | Salary | Paid per minute of active play. Idle time, hidden tabs and AFK earn nothing. |
  | Discussions at the wall screens | A per-card bonus for each correct call |
  | Incidents | A resolution bonus scaled by your grade, with nothing for a botched fix |
  | Team incidents | Every player in the room gets paid |

- **Money shows everywhere it matters.** The lobby shows your wallet, the HUD shows live earnings, and each debrief shows a payslip. A ledger records why every cent arrived.
- **Persistence.**
  - Anonymous players keep their money in this browser only.
  - Signing up (username and password) saves money and progress to your account so it follows you to any device.
  - When you sign up, your anonymous wallet carries over.
- **Multiplayer.** Anyone can create a room and share the 4-letter code. Each person plays their own role in the same outage.

Done when all of these hold:
- A new visitor can play solo or in a team with no account.
- They earn money from time played and from solving problems, and can see it.
- They can sign up and keep it.
- It all runs on a public URL that costs nothing to host.

## Mode 2: Startup mode (next)

Your job-mode money funds a company of your own.

- **Founding.** Whoever creates the lobby is the founder. Before your company can operate you must buy an office, and you can't do that without enough money.
- **Hiring.** Inviting a player into your lobby means hiring them, and hiring costs money. Hired players are paid from company funds.
- **Assets.** Servers, tooling, monitoring and office space cost money. Better assets mean fewer and smaller incidents.
- **Outages cost money.** When your system pages and nobody on staff can fix it, you can pay a third-party contractor (us) to resolve it. Every minute your system is down loses revenue.
- **Decision tree.** You choose what to build, how much reliability to buy, when to hire and when to raise money. Each choice changes revenue, burn rate and incident odds. The company rises or falls on those decisions.
- **Investors.** Raise money by giving up equity. Players can also invest their own job-mode money in other players' startups.
- **Trackers.** Live views of investments, inventory (assets), expenses (salaries, assets, contractors, office upkeep) and earnings.
- **Office upkeep.** In job mode the pantry is free: the employer pays for coffee and snacks. Every coffee and snack is still counted, with a unit cost in cents (`src/domain/pantry.ts`). In startup mode these counts become part of the company's operating costs.

Startup mode needs money that the server holds and decides on (see the anti-cheat item under Hosting). Job-mode wallets are kept on the device and only sanity-checked by the server.

### Startup mode: build plan (decided 2026-10-10)

Decisions:

- **Seed money comes from the founder's earned job-mode money.** Founding needs a minimum: the first room plus a week of payroll for the founder.
- **Time passes in work days, only while members play.** Nobody goes broke while everyone is offline. A work day closes when a member finishes a shift; that settles payroll, revenue and costs.
- **Revenue = category base × uptime × shipped work.** Each category has a base daily revenue. Outages and missing roles cut it; finished tasks (bugs fixed, PRs reviewed, features shipped) raise it.
- **Categories at launch:** E-commerce, Fintech, Social / consumer app, B2B SaaS. The category picks which incidents and daily tasks the company gets.
- **No random staff.** Only invited players work there. A role nobody holds is covered by paying a contractor per issue.
- **Every member is paid at least their role's minimum** per work day, from company funds.
- **Accounts only, and every company balance is held on the server.** Money moves between players (salaries, investments), so nothing here is trusted from the client.

Phases, each one playable on its own:

1. **Found and staff.** Create a company (name, category, seed from your wallet). Buy the first room. Invite players by username with a role and pay (≥ the role minimum); they accept or decline. A company HQ page shows funds, rooms, staff, payroll and a ledger.
2. **Daily work.** Each role gets a task board: fix a bug (a failing test with the code, pick the fix or the line), review a PR (a diff, approve or flag the line that breaks it), routine ops, plus pages from the category's incidents. Buy servers (more capacity, fewer and smaller incidents). Hire a contractor for a missing role. Revenue settles per work day.
3. **The office.** The company's 3D office shows only the rooms it bought. Expand by buying more; only members are on the floor. Pantry and office upkeep become operating costs.
4. **Investors.** Invite investors who put money into company funds for a share. Profit share at the end of a work week. Trackers for investments, inventory (assets), expenses and earnings.

Ownership:

- **Pure rules in src/domain/company/** (catalogs, minimum pay, costs, settlement, pure functions with no clock reads): the War Room session.
- **Task content** (code-fix and PR-review kinds and their packs per category): the War Room session.
- **Lobby and HQ pages:** the War Room session.
- **D1 tables, server-held balances, company APIs and invitations:** the account/economy session.
- **The 3D office per company:** the account/economy session.

### Startup mode: hiring, levels and the company leaderboard (planned 2026-10-10)

- **Company leaderboard.** The top companies by revenue over their last 7 work days, showing category, level, size and founder. A company that's coasting falls off.
- **Find companies.** Search companies by name or category, see their level, size and open roles.
- **Hiring.** A founder (or a member they make a hiring manager) opens a posting with a role, pay (≥ the role minimum), a minimum career level and a minimum interview score. Players apply by taking the interview. The founder or a hiring manager hires or rejects among applicants who meet the bar. Direct invitations still work too.
- **Interviews are graded on the server.** Three tasks for the role, at the posting's difficulty, served without their answers and graded server-side, so the score can't be faked from the browser.
- **Company levels: easy work first, harder as it grows.** Garage, Seed, Series A, Growth, Scale, by lifetime revenue and work days. A level sets the daily task difficulty (easy for a garage, hard at Scale), the pay a posting can ask for, and later which incidents page the company.

Ownership follows phase 1: pure rules, schemas and screens are the War Room session's; D1, endpoints and server-side grading are the account/economy session's.

## Hosting: free, always on (no Render)

Everything runs on the **Cloudflare Workers Free** plan, with no idle sleep or cold-start parking.

| Piece | Runs on | Free-tier limit (Oct 2026) |
|---|---|---|
| The game (static files, `public/office` 3D assets) | Workers static assets | Asset requests are free |
| Multiplayer rooms (`/rooms`) | One Durable Object per room, SQLite-backed (free plan) | 100k requests/day, 13,000 GB-s/day |
| Accounts, sessions, saved wallets (`/api`) | Worker plus D1 | 5M rows read and 100k rows written per day, 5 GB |

**Budget.** These are the limits we design against.
- **Room time.** A ticking room keeps its Durable Object awake, so it uses ~0.125 GB-s per second. The daily allowance covers about 29 room-hours.
- **Requests.** Inbound WebSocket messages count 20:1 against the request limit. At 4 position updates per second, that's roughly 140 player-hours a day.
- **What happens at the limit.** New rooms fail cleanly, and solo play keeps working.

**Deploying.** The command is `pnpm deploy`: build, then `wrangler deploy`. A GitHub Action can take over once a Cloudflare API token is added as a repo secret.

## Later

- **Anti-cheat.** Earnings become server-authoritative: the server decides payouts for incidents and card answers before any money can be spent in startup mode.
- **Leaderboards.** Weekly, per role.
- **More scenarios per role.** Content quality is the moat. Every role now has a War Room ladder, tiers 1–4, and 20 or more incident cards; next is a second incident per tier and more hard cards.
- **Privacy-friendly analytics.**

## Pending: Pro subscription (real money, Stripe)

The code is built and pushed, but it isn't switched on. We'll finish this later.

**Rules that are settled**
- Pro never buys rank, experience, pay or leaderboard position.
- Worked solutions always cost earned in-game money, for everyone.

**Pro perks**

| Perk | Status |
|---|---|
| 3 free hints a day at any tier | Done |
| Practice every War Room, with no experience or pay | |
| Unlimited practice rounds | |
| Early access to new incidents, one week before everyone else | |
| Supporter look | |

**Already done**
- **Server side:** Stripe Checkout for monthly or yearly, the customer portal, and a signed, idempotent webhook (`worker/billing/`).
- **Database:** the entitlements in D1. Migration 0003 is applied live.
- **Account:** `/api/me` and `AccountSession.entitlements`.
- **Rules and UI:** the perk rules (`src/domain/entitlements.ts`) and the Pro daily hints in the Help tab.

**Still to do**
1. **Stripe setup (the user does this).**
   - In test mode, create a "sev1 Pro" product with a monthly and a yearly price (the panel shows $4.99 per month and $39 per year), and turn on the Customer Portal.
   - Add a webhook pointing to `https://sev1.aashish-thapa.workers.dev/api/billing/webhook` for these events:
     - `checkout.session.completed`
     - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`
   - Enter the secrets with `wrangler secret put`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY` and `STRIPE_PRICE_PRO_YEARLY`.
2. **Open Pro for sale.**
   - The profile already shows Pro as "Coming soon": the perks, the prices, and a disabled button.
   - To open it, set `IS_PRO_ON_SALE = true` in `src/storage/billing-api.ts`, and only after step 1 is done.
   - Add the Terms, Privacy and Refund pages, which Stripe requires.
   - Show an "Activating Pro…" state when the player lands on `/?billing=success`.
3. **Practice War Rooms.** Add the lobby picker and record practice runs with no experience or pay.
4. **Decide the free-player practice cap.** `FREE_PRACTICE_ROUNDS_PER_DAY = 3` hasn't been confirmed, because it takes something away from free players.
5. **Finish the remaining perks.** Early access (`Scenario.releasedAt`), the supporter mark and name colours, and anything that writes cosmetics.
6. **Test with real Stripe calls.** Make a test-mode purchase with the card 4242 4242 4242 4242, then switch to live keys.
