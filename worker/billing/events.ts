/**
 * The Stripe events billing acts on, parsed at the boundary. Anything else is acknowledged and ignored.
 * Newer Stripe API versions carry the billing period on each subscription item, older ones on the subscription.
 */
import { z } from "zod";

const SUBSCRIPTION_EVENTS = ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"] as const;
/** Statuses that grant Pro; every other one (past_due, unpaid, canceled, incomplete…) does not. */
const GRANTING_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

const SubscriptionSchema = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  current_period_end: z.int().optional(),
  items: z.object({ data: z.array(z.object({ current_period_end: z.int().optional() })) }).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const SubscriptionEventSchema = z.object({
  id: z.string(),
  type: z.enum(SUBSCRIPTION_EVENTS),
  created: z.int(),
  data: z.object({ object: SubscriptionSchema }),
});

const CheckoutCompletedSchema = z.object({
  id: z.string(),
  type: z.literal("checkout.session.completed"),
  data: z.object({ object: z.object({ customer: z.string().nullable(), client_reference_id: z.string().nullable() }) }),
});

export type SubscriptionEvent = {
  readonly kind: "subscription";
  readonly eventId: string;
  readonly eventCreated: number;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly status: string;
  readonly proUntil: number | null;
  /** The user id put on the subscription at checkout, if any. */
  readonly userIdHint: string | null;
};

export type CheckoutEvent = { readonly kind: "checkout"; readonly eventId: string; readonly customerId: string; readonly userId: string };
export type BillingEvent = SubscriptionEvent | CheckoutEvent | { readonly kind: "ignored" };

function periodEndSeconds(subscription: z.output<typeof SubscriptionSchema>): number | null {
  const itemEnds = (subscription.items?.data ?? []).map((item) => item.current_period_end).filter((end): end is number => end !== undefined);
  if (itemEnds.length > 0) return Math.max(...itemEnds);
  return subscription.current_period_end ?? null;
}

export function parseBillingEvent(raw: unknown): BillingEvent {
  const subscription = SubscriptionEventSchema.safeParse(raw);
  if (subscription.success) {
    const { id, type, created, data } = subscription.data;
    const end = periodEndSeconds(data.object);
    const grants = type !== "customer.subscription.deleted" && GRANTING_STATUSES.has(data.object.status) && end !== null;
    return {
      kind: "subscription",
      eventId: id,
      eventCreated: created,
      customerId: data.object.customer,
      subscriptionId: data.object.id,
      status: type === "customer.subscription.deleted" ? "canceled" : data.object.status,
      proUntil: grants && end !== null ? end * 1000 : null,
      userIdHint: data.object.metadata?.user_id ?? null,
    };
  }
  const checkout = CheckoutCompletedSchema.safeParse(raw);
  if (checkout.success) {
    const { customer, client_reference_id } = checkout.data.data.object;
    if (customer && client_reference_id) return { kind: "checkout", eventId: checkout.data.id, customerId: customer, userId: client_reference_id };
  }
  return { kind: "ignored" };
}
