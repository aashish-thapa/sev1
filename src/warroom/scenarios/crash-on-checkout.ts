import type { Scenario } from "../scenario.ts";
import { CHECKOUT, checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";

export const crashOnCheckout: Scenario = {
  id: "crash-on-checkout",
  tier: 1,
  title: "Checkout keeps restarting",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "checkout-api went out ten minutes ago and now its pods keep dying. Most payments fail; a few get through between restarts. You have kubectl on the prod bastion, and your mentor Priya is on the call.",
  roles: ["infrastructure"],
  opensAtSecondOfDay: 11 * 3600 + 41 * 60,
  seed: "crash-on-checkout",
  initialState: () =>
    checkoutCluster({
      seed: "crash-on-checkout",
      revisions: [
        { number: 7, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] },
        {
          number: 8,
          tag: "v4.14.0",
          changeCause: "v4.14.0 multi-currency checkout",
          traits: [
            {
              kind: "crashes-while-serving",
              termination: { reason: "Error", exitCode: 1 },
              afterSeconds: 3,
              jitterSeconds: 5,
              lastWords:
                "Exception in thread \"http-nio-8080-exec-4\" java.lang.IllegalStateException: required property 'payments.default-currency' is not set (CurrencyConfig.java:41)",
              failsCheckouts: true,
            },
          ],
        },
      ],
      revision: 8,
      podsStartedAgo: 40,
    }),
  isRootCauseFixed: isOnCleanBuild,
  // A full outage drains ~120 checkouts a second, faster than anyone types; interns are graded on finding the fix.
  lostCheckoutsPerPoint: 400,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 50% for 5m. Assigned to you." },
    { at: 15, from: "Priya Nair · Senior SRE (your mentor)", text: "Start with kubectl get pods. Look at the STATUS and RESTARTS columns." },
    { at: 55, from: "Priya Nair · Senior SRE (your mentor)", text: "CrashLoopBackOff means the app starts, dies, and Kubernetes keeps retrying. kubectl logs on one of them shows its last words." },
    { at: 90, from: "Sam Tan · Eng manager", text: "v4.14.0 (multi-currency) shipped at 11:30. Could that be it?" },
    { at: 130, from: "Priya Nair · Senior SRE (your mentor)", text: "When a fresh deploy breaks and the old one worked, roll back first and debug after: kubectl rollout undo deployment/checkout-api." },
    { at: 220, from: "Elena Ruiz · VP Engineering", text: "Support says carts are failing at payment. ETA?" },
  ],
  postmortem: {
    question: "Why were the pods crashing?",
    options: [
      "They ran out of memory under load",
      "v4.14.0 needed a config property that prod didn't have, and threw on the first checkout",
      "orders-db had too many connections",
      "Kubernetes evicted them from a full node",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v4.14.0 read a new required property, payments.default-currency, that was set in staging but never added to prod.",
      why: "The health check doesn't touch checkout, so the pods looked ready and the rollout finished. The first real checkout hit the missing property, threw, and killed the process; Kubernetes restarted it, and it died again. Rolling back to v4.12.1 removes the code that needs the property.",
      tell: "STATUS CrashLoopBackOff with climbing restarts right after a deploy, and every pod's last log line was the same IllegalStateException naming the missing property.",
    },
  },
};
