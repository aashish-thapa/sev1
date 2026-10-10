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
- **Trackers.** Live views of investments, inventory (assets), expenses (salaries, assets, contractors) and earnings.

Startup mode needs money that the server holds and decides on (see the anti-cheat item under Hosting). Job-mode wallets are kept on the device and only sanity-checked by the server.

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
- **More scenarios per role.** Content quality is the moat.
- **Privacy-friendly analytics.**
