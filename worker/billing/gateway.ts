/** What billing needs from Stripe, behind an interface so tests use a fake and the service never sees HTTP. */

export type CheckoutRequest = {
  readonly customerId: string;
  readonly priceId: string;
  readonly userId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
};

export interface PaymentGateway {
  /** A Stripe customer for this account; `userId` makes retries return the same customer. */
  createCustomer(userId: string, username: string): Promise<string>;
  /** A hosted Checkout page for a Pro subscription; returns where to send the browser. */
  createCheckout(request: CheckoutRequest): Promise<string>;
  /** The hosted Customer Portal (cancel, update card, invoices); returns where to send the browser. */
  createPortal(customerId: string, returnUrl: string): Promise<string>;
}

/** Stripe answered with an error; the message is Stripe's, safe to log, not shown to players. */
export class PaymentProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PaymentProviderError";
    this.status = status;
  }
}

const STRIPE_API = "https://api.stripe.com/v1";

/** Stripe's REST API over fetch, form-encoded as Stripe expects. */
export class StripeGateway implements PaymentGateway {
  private readonly secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  async createCustomer(userId: string, username: string): Promise<string> {
    const customer = await this.post<{ id: string }>("/customers", { "metadata[user_id]": userId, "metadata[username]": username, description: `sev1 player ${username}` }, `customer-${userId}`);
    return customer.id;
  }

  async createCheckout(request: CheckoutRequest): Promise<string> {
    const session = await this.post<{ url: string | null }>("/checkout/sessions", {
      mode: "subscription",
      customer: request.customerId,
      client_reference_id: request.userId,
      "line_items[0][price]": request.priceId,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][user_id]": request.userId,
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
    });
    if (!session.url) throw new PaymentProviderError(502, "Checkout session has no URL");
    return session.url;
  }

  async createPortal(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.post<{ url: string }>("/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
    return session.url;
  }

  private async post<T>(path: string, fields: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(`${STRIPE_API}${path}`, { method: "POST", headers, body: new URLSearchParams(fields) });
    const body = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) throw new PaymentProviderError(response.status, body.error?.message ?? `Stripe ${path} failed`);
    return body;
  }
}
