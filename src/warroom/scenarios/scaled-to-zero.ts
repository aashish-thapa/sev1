import type { Scenario } from "../scenario.ts";
import { templateHash } from "../sim/model.ts";
import { CHECKOUT, checkoutCluster } from "./checkout-cluster.ts";

const REPLICAS = 3;

export const scaledToZero: Scenario = {
  id: "scaled-to-zero",
  tier: 1,
  title: "Checkout is gone",
  severity: "SEV2",
  service: CHECKOUT,
  briefing:
    "Your first page. checkout-api is answering every request with 503. Nobody deployed anything. You have a shell on the prod bastion with kubectl; your mentor Priya is on the call and will point you in the right direction.",
  roles: ["infrastructure"],
  opensAtSecondOfDay: 14 * 3600 + 6 * 60,
  seed: "scaled-to-zero",
  initialState: () =>
    checkoutCluster({
      seed: "scaled-to-zero",
      revisions: [
        { number: 6, tag: "v4.12.0", changeCause: "v4.12.0 retry wrapper for payment-gateway client", traits: [] },
        { number: 7, tag: "v4.12.1", changeCause: "v4.12.1 close pooled connection before gateway retry", traits: [] },
      ],
      revision: 7,
      replicas: 0,
      runningPods: REPLICAS,
      events: [
        {
          t: -30,
          type: "Normal",
          reason: "ScalingReplicaSet",
          object: `deployment/${CHECKOUT}`,
          message: `Scaled down replica set ${CHECKOUT}-${templateHash(CHECKOUT, 7, 0)} to 0 from ${REPLICAS}`,
        },
      ],
    }),
  isRootCauseFixed: (state) => state.deployments.every((deployment) => deployment.replicas >= REPLICAS),
  // A full outage drains ~120 checkouts a second, faster than anyone types; interns are graded on finding the fix.
  lostCheckoutsPerPoint: 400,
  externals: [],
  comms: [
    { at: 0, from: "PagerDuty", text: "SEV2 triggered — checkout-api 5xx at 100%. Assigned to you." },
    { at: 15, from: "Priya Nair · Senior SRE (your mentor)", text: "Deep breath. First question is always: are the pods even running? Try kubectl get pods." },
    { at: 50, from: "Priya Nair · Senior SRE (your mentor)", text: "No pods at all? Then something told Kubernetes to want none. kubectl get events shows what changed recently." },
    { at: 70, from: "Sam Tan · Eng manager", text: "Uh. I was scaling down staging ten minutes ago. Which cluster was my kubectl pointed at…" },
    { at: 110, from: "Priya Nair · Senior SRE (your mentor)", text: "It normally runs 3 replicas. kubectl scale deployment/checkout-api --replicas=3 brings them back." },
    { at: 200, from: "Elena Ruiz · VP Engineering", text: "Checkout still down? Customers are noticing." },
  ],
  hints: [
    "Every request fails and nothing was deployed. Start with what’s actually running.",
    "If there’s nothing running at all, something told Kubernetes to want nothing. The cluster’s recent events say what changed.",
    "Put it back the way it normally runs: it had three of them.",
  ],
  solution: {
    infrastructure: [
      { command: "kubectl get pods", why: "No pods at all: this isn’t a crash, nothing is running." },
      { command: "kubectl get events", why: "A ScalingReplicaSet to 0 with no deploy around it means someone scaled it down by hand." },
      { command: "kubectl scale deployment/checkout-api --replicas=3", why: "Puts back the three replicas it normally runs." },
      { command: "kubectl get pods", why: "Wait until all three show 1/1 Ready, then declare resolved." },
    ],
  },
  postmortem: {
    question: "What took checkout down?",
    options: [
      "A bad deploy crashed every pod",
      "Someone scaled checkout-api to zero replicas, thinking they were on staging",
      "orders-db refused all connections",
      "The load balancer lost its health checks",
    ],
    answerIndex: 1,
    explanation: {
      cause: "A kubectl scale meant for staging ran against prod and set checkout-api to 0 replicas.",
      why: "The deployment did exactly what it was told: it wanted zero pods, so it stopped all three, and the load balancer had nothing to send traffic to. Restarting or rolling back doesn't help while the desired count is zero; scaling back to 3 does.",
      tell: "kubectl get pods returned nothing, and kubectl get events showed a ScalingReplicaSet to 0 with no deploy around it.",
    },
  },
};
