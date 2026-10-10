import type { DirectoryObject } from "./directory-object.ts";
import type { RoomObject } from "./room-object.ts";

/** Bindings declared in wrangler.jsonc. */
export interface Env {
  readonly ASSETS: Fetcher;
  readonly ROOMS: DurableObjectNamespace<RoomObject>;
  readonly DIRECTORY: DurableObjectNamespace<DirectoryObject>;
  readonly DB: D1Database;
  /** Comma-separated origins allowed to open room sockets; unset means the site's own origin only. */
  readonly ALLOWED_ORIGINS?: string;
  /** Stripe secret API key (a wrangler secret). Billing answers 503 until all four Stripe values are set. */
  readonly STRIPE_SECRET_KEY?: string;
  /** Signing secret of the Stripe webhook endpoint (a wrangler secret, `whsec_…`). */
  readonly STRIPE_WEBHOOK_SECRET?: string;
  /** Price ids of the monthly and yearly Pro plans (`price_…`); not sensitive, but kept as secrets so deploys don't wipe them. */
  readonly STRIPE_PRICE_PRO_MONTHLY?: string;
  readonly STRIPE_PRICE_PRO_YEARLY?: string;
}
