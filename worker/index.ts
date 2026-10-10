import { findScenario } from "../server/scenarios.ts";
import { AccountService, ATTEMPT_WINDOW_MS } from "./api/accounts.ts";
import { D1AccountStore } from "./api/d1-store.ts";
import { handleApi } from "./api/routes.ts";
import { D1EntitlementStore } from "./billing/d1-store.ts";
import { StripeGateway } from "./billing/gateway.ts";
import { BILLING_PREFIX, handleBilling } from "./billing/routes.ts";
import { BillingService } from "./billing/service.ts";
import { PUBLIC_ROOMS_PATH, type PublicRoomList } from "../src/multiplayer/protocol.ts";
import { DIRECTORY_NAME } from "./directory-object.ts";
import type { Env } from "./env.ts";
import { routeRoomSocket } from "./rooms.ts";
import { D1CompanyStore } from "./company/d1-store.ts";
import { APPLICATIONS_PATH, APPLY_PATH, handleCompany, handleDirectory, INTERVIEWS_PATH, INVITATIONS_PATH } from "./company/routes.ts";
import { CompanyDirectory } from "./company/directory.ts";
import { HiringService } from "./company/hiring.ts";
import { WorkService } from "./company/work.ts";
import { D1WorkStore } from "./company/work-d1-store.ts";
import { D1CompanyDirectory, D1HiringStore } from "./company/hiring-d1-store.ts";
import { TASKS } from "./company/tasks.ts";
import { CompanyService } from "./company/service.ts";
import { COMPANIES_PATH, COMPANY_PATH, TOP_COMPANIES_PATH } from "../src/storage/company-protocol.ts";
import { careerLevel } from "../src/domain/career.ts";
import { emptyProgress, ProgressSchema, type Progress } from "../src/domain/progress.ts";
import type { AccountStore } from "./api/store.ts";
import { D1AdminStore } from "./admin/d1-store.ts";
import { ADMIN_PREFIX, handleAdmin } from "./admin/routes.ts";
import { AdminService } from "./admin/service.ts";
import { D1GrantStore } from "./grants/d1-store.ts";
import { GrantDesk } from "./grants/service.ts";
import { shownTags } from "../src/domain/tags.ts";
import { sessionTokenOf } from "./api/http.ts";
import { pantryCostOn } from "../src/domain/pantry.ts";
import { CompanyOffice } from "./company/office.ts";
import { D1OfficeRoomStore } from "./company/office-d1-store.ts";
import { TEAM_SCENARIO } from "../src/warroom/scenarios/index.ts";

/** Billing exists only once every Stripe value is configured; until then its routes answer 503. */
function billingFor(env: Env, store: D1EntitlementStore): BillingService | null {
  const { STRIPE_SECRET_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_PRICE_PRO_MONTHLY: monthly, STRIPE_PRICE_PRO_YEARLY: yearly } = env;
  if (!secretKey || !webhookSecret || !monthly || !yearly) return null;
  return new BillingService(store, new StripeGateway(secretKey), { prices: { "pro-monthly": monthly, "pro-yearly": yearly }, webhookSecret }, Date.now);
}

export { DirectoryObject } from "./directory-object.ts";
export { RoomObject } from "./room-object.ts";

/** Company writes (found, buy, invite, pay, settle) one account may make per attempt window. */
const COMPANY_WRITES_PER_WINDOW = 60;
/** Grants one admin may issue per attempt window: plenty for testing, a ceiling on a stuck retry loop. */
const GRANTS_PER_WINDOW = 30;

/** The progress the server last accepted for a player; a player with none (or an unreadable save) starts as an intern. */
async function savedProgressOf(store: Pick<AccountStore, "loadProgress">, userId: string): Promise<Progress> {
  const saved = await store.loadProgress(userId);
  if (!saved) return emptyProgress();
  try {
    const parsed = ProgressSchema.safeParse(JSON.parse(saved.body));
    return parsed.success ? parsed.data : emptyProgress();
  } catch (error) {
    if (error instanceof SyntaxError) return emptyProgress();
    throw error;
  }
}

/** A company's private room: codes live in D1 and are held in the room host when first assigned. */
function officeFor(env: Env): CompanyOffice {
  return new CompanyOffice(new D1OfficeRoomStore(env.DB), (code) => env.ROOMS.getByName(code).claim(code), Math.random);
}

/** Composition root: rooms, the account API, and everything else from the built site. */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/rooms") {
      const accounts = new AccountService(new D1AccountStore(env.DB), Date.now);
      const user = await accounts.userFor(sessionTokenOf(request));
      const office = officeFor(env);
      return routeRoomSocket(
        request,
        env,
        Math.random,
        async () => shownTags(user?.tags ?? []),
        (_socket, code) => office.access(code, user?.id ?? null),
        TEAM_SCENARIO.id,
      );
    }
    if (pathname === PUBLIC_ROOMS_PATH && request.method === "GET") {
      const list: PublicRoomList = { rooms: await env.DIRECTORY.getByName(DIRECTORY_NAME).list() };
      return Response.json(list, { headers: { "cache-control": "no-store" } });
    }
    if (pathname.startsWith("/api/")) {
      const companyStore = new D1CompanyStore(env.DB);
      const accountStore = new D1AccountStore(env.DB);
      const grantStore = new D1GrantStore(env.DB);
      const isOverLimit = (limit: number) => async (key: string) => {
        const windowStart = Math.floor(Date.now() / ATTEMPT_WINDOW_MS) * ATTEMPT_WINDOW_MS;
        return (await accountStore.countAttempt(key, windowStart)) > limit;
      };
      const accounts = new AccountService(accountStore, Date.now, (id) => findScenario(id)?.tier, companyStore, grantStore);
      const entitlements = new D1EntitlementStore(env.DB);
      if (pathname === COMPANIES_PATH || pathname === TOP_COMPANIES_PATH) return handleDirectory(request, new CompanyDirectory(new D1CompanyDirectory(env.DB)));
      if (pathname === COMPANY_PATH || [COMPANY_PATH, INVITATIONS_PATH, APPLY_PATH, INTERVIEWS_PATH, APPLICATIONS_PATH].some((prefix) => pathname.startsWith(`${prefix}/`))) {
        const hiringStore = new D1HiringStore(env.DB);
        const workStore = new D1WorkStore(env.DB);
        const companies = new CompanyService({
          store: companyStore,
          now: Date.now,
          newId: () => crypto.randomUUID(),
          isOverLimit: isOverLimit(COMPANY_WRITES_PER_WINDOW),
          hiring: hiringStore,
          work: workStore,
          pantryOf: async (userId, day) => pantryCostOn((await savedProgressOf(accountStore, userId)).pantry, day),
        });
        const hiring = new HiringService({
          store: hiringStore,
          companies: companyStore,
          company: companies,
          tasks: TASKS,
          careerOf: async (userId) => careerLevel(await savedProgressOf(accountStore, userId)),
          now: Date.now,
          newId: () => crypto.randomUUID(),
          isOverLimit: isOverLimit(COMPANY_WRITES_PER_WINDOW),
        });
        const work = new WorkService({
          store: workStore,
          company: companies,
          tasks: TASKS,
          now: Date.now,
          newId: () => crypto.randomUUID(),
          isOverLimit: isOverLimit(COMPANY_WRITES_PER_WINDOW),
        });
        return handleCompany(request, accounts, companies, hiring, officeFor(env), work);
      }
      if (pathname.startsWith(ADMIN_PREFIX)) {
        const store = new D1AccountStore(env.DB);
        const admin = new AdminService({
          store: new D1AdminStore(env.DB),
          topAccounts: (limit) => store.topAccounts(limit),
          publicRooms: async () => (await env.DIRECTORY.getByName(DIRECTORY_NAME).list()).length,
          now: Date.now,
        });
        const grants = new GrantDesk({
          store: grantStore,
          findUser: (username) => accountStore.findUser(username),
          now: Date.now,
          newId: () => crypto.randomUUID(),
          isOverLimit: isOverLimit(GRANTS_PER_WINDOW),
        });
        return handleAdmin(request, accounts, admin, grants);
      }
      if (pathname.startsWith(BILLING_PREFIX)) return handleBilling(request, accounts, billingFor(env, entitlements));
      return handleApi(request, accounts, (userId) => entitlements.entitlementsOf(userId));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
