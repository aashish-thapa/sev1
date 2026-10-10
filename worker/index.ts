import { findScenario } from "../server/scenarios.ts";
import { AccountService } from "./api/accounts.ts";
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

/** Billing exists only once every Stripe value is configured; until then its routes answer 503. */
function billingFor(env: Env, store: D1EntitlementStore): BillingService | null {
  const { STRIPE_SECRET_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_PRICE_PRO_MONTHLY: monthly, STRIPE_PRICE_PRO_YEARLY: yearly } = env;
  if (!secretKey || !webhookSecret || !monthly || !yearly) return null;
  return new BillingService(store, new StripeGateway(secretKey), { prices: { "pro-monthly": monthly, "pro-yearly": yearly }, webhookSecret }, Date.now);
}

export { DirectoryObject } from "./directory-object.ts";
export { RoomObject } from "./room-object.ts";

/** Composition root: rooms, the account API, and everything else from the built site. */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/rooms") return routeRoomSocket(request, env, Math.random);
    if (pathname === PUBLIC_ROOMS_PATH && request.method === "GET") {
      const list: PublicRoomList = { rooms: await env.DIRECTORY.getByName(DIRECTORY_NAME).list() };
      return Response.json(list, { headers: { "cache-control": "no-store" } });
    }
    if (pathname.startsWith("/api/")) {
      const accounts = new AccountService(new D1AccountStore(env.DB), Date.now, (id) => findScenario(id)?.tier);
      const entitlements = new D1EntitlementStore(env.DB);
      if (pathname.startsWith(BILLING_PREFIX)) return handleBilling(request, accounts, billingFor(env, entitlements));
      return handleApi(request, accounts, (userId) => entitlements.entitlementsOf(userId));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
