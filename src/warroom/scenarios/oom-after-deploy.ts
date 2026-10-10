import type { Scenario } from "../scenario.ts";
import { CHECKOUT, checkoutCluster, isOnCleanBuild } from "./checkout-cluster.ts";

export const oomAfterDeploy: Scenario = {
  id: "oom-after-deploy",
  tier: 2,
  title: "Checkout drops payments every few minutes",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Since lunch, checkout fails in bursts: fine for a minute, then a wave of 5xx, then fine again. You have kubectl on the prod bastion. Work out why the pods keep going away.",
  roles: ["infrastructure"],
  opensAtSecondOfDay: 13 * 3600 + 22 * 60,
  seed: "oom-after-deploy",
  initialState: () =>
    checkoutCluster({
      seed: "oom-after-deploy",
      revisions: [
        { number: 8, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] },
        {
          number: 9,
          tag: "v4.15.0",
          changeCause: "v4.15.0 cache exchange rates in memory",
          traits: [
            {
              kind: "crashes-while-serving",
              termination: { reason: "OOMKilled", exitCode: 137 },
              afterSeconds: 55,
              jitterSeconds: 50,
              lastWords: "GC (Allocation Failure) heap after full GC: 1012M->1009M(1024M), 1.84 secs; ExchangeRateCache entries=4,180,233",
              failsCheckouts: false,
            },
          ],
        },
      ],
      revision: 9,
      podsStartedAgo: 30,
    }),
  isRootCauseFixed: isOnCleanBuild,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx > 5% (flapping). Assigned to you." },
    { at: 60, from: "Maya Okonkwo · Support", text: "Customers say paying works on the second or third try." },
    { at: 120, from: "Sam Tan · Eng manager", text: "Is it the payment gateway again? Their status page is green." },
    { at: 240, from: "Elena Ruiz · VP Engineering", text: "Flapping all afternoon isn't acceptable. What's the plan?" },
  ],
  hints: [
    "It fails in waves, not all at once. What happens to the pods between waves?",
    "A pod’s description remembers how its last container died.",
    "Restarting only resets the clock on whatever keeps growing inside the pods.",
  ],
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "Restarts climb pod by pod, never all at once, which is why checkout fails in waves." },
      { command: "kubectl describe pods", why: "Pods that restarted show Last State: Terminated, Reason: OOMKilled, Exit Code 137. They hit their 1Gi memory limit." },
      { command: "kubectl logs deployment/checkout-api", why: "Full garbage collections with the heap at its ceiling and the exchange-rate cache still growing." },
      { command: "kubectl rollout history deployment/checkout-api", why: "v4.15.0 added the in-memory cache; v4.12.1 didn’t have it." },
      { command: "kubectl rollout undo deployment/checkout-api", why: "Rolling back removes the leak. Restarting would only start the clock again." },
      { command: "kubectl rollout status deployment/checkout-api", why: "Wait for the rollout to finish, then declare resolved and watch it stay quiet." },
    ],
  },
  postmortem: {
    question: "Why did the pods keep restarting?",
    options: [
      "The payment gateway timed out and the pods gave up",
      "v4.15.0's in-memory exchange-rate cache never evicted, so each pod hit its 1Gi memory limit and was OOMKilled",
      "The liveness probe was too strict",
      "orders-db restarted repeatedly",
    ],
    answerIndex: 1,
    explanation: {
      cause: "v4.15.0 added an exchange-rate cache with no size limit; it grew until each container reached its 1Gi memory limit.",
      why: "When a container passes its memory limit the kernel kills it (exit code 137) and Kubernetes restarts it. Each pod lasted a minute or two, so they died one after another and checkout failed in waves. A restart only resets the clock; rolling back removes the leak.",
      tell: "kubectl describe pod showed Last State: Terminated, Reason: OOMKilled, Exit Code 137, and the last log lines were full garbage collections with the heap at its ceiling.",
    },
  },
};
