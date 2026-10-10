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
import { handleCompany, INVITATIONS_PATH } from "./company/routes.ts";
import { CompanyService } from "./company/service.ts";
import { COMPANY_PATH } from "../src/storage/company-protocol.ts";
import { D1AdminStore } from "./admin/d1-store.ts";
import { ADMIN_PREFIX, handleAdmin } from "./admin/routes.ts";
import { AdminService } from "./admin/service.ts";
import { D1GrantStore } from "./grants/d1-store.ts";
import { GrantDesk } from "./grants/service.ts";
import { shownTags } from "../src/domain/tags.ts";
import { sessionTokenOf } from "./api/http.ts";

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

/** Composition root: rooms, the account API, and everything else from the built site. */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/rooms") {
      const accounts = new AccountService(new D1AccountStore(env.DB), Date.now);
      return routeRoomSocket(request, env, Math.random, async (socket) => shownTags((await accounts.userFor(sessionTokenOf(socket)))?.tags ?? []));
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
      if (pathname === COMPANY_PATH || pathname.startsWith(`${COMPANY_PATH}/`) || pathname.startsWith(`${INVITATIONS_PATH}/`)) {
        const companies = new CompanyService({
          store: companyStore,
          now: Date.now,
          newId: () => crypto.randomUUID(),
          isOverLimit: isOverLimit(COMPANY_WRITES_PER_WINDOW),
        });
        return handleCompany(request, accounts, companies);
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
