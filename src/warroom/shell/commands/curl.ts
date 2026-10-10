import { isServing } from "../../sim/model.ts";
import { err, out, type Command } from "../types.ts";

type Route = { path: RegExp; respond: (pool: { size: number; active: number; isStarved: boolean }) => string };

/** Responses come from whichever pod the Service routes this request to (round-robin by clock). */
const ROUTES: readonly Route[] = [
  { path: /^\/healthz\/?$/, respond: () => '{"status":"UP"}' },
  {
    path: /^\/actuator\/health\/?$/,
    respond: ({ isStarved }) =>
      isStarved
        ? '{"status":"DOWN","components":{"db":{"status":"DOWN","details":{"error":"org.springframework.jdbc.CannotGetJdbcConnectionException: Failed to obtain JDBC Connection"}},"ping":{"status":"UP"}}}'
        : '{"status":"UP","components":{"db":{"status":"UP","details":{"database":"PostgreSQL","validationQuery":"isValid()"}},"ping":{"status":"UP"}}}',
  },
  {
    path: /^\/actuator\/metrics\/hikaricp\.connections\.active\/?$/,
    respond: ({ active }) => `{"name":"hikaricp.connections.active","description":"Active connections","baseUnit":"connections","measurements":[{"statistic":"VALUE","value":${active}.0}],"availableTags":[{"tag":"pool","values":["HikariPool-1"]}]}`,
  },
  {
    path: /^\/actuator\/metrics\/hikaricp\.connections\.max\/?$/,
    respond: ({ size }) => `{"name":"hikaricp.connections.max","description":"Max connections","baseUnit":"connections","measurements":[{"statistic":"VALUE","value":${size}.0}],"availableTags":[{"tag":"pool","values":["HikariPool-1"]}]}`,
  },
];

export const curl: Command = {
  name: "curl",
  roles: ["infrastructure"],
  refuse(args) {
    // Off the bastion there is no cluster DNS: service names don't resolve from a laptop.
    const target = args.find((arg) => !arg.startsWith("-")) ?? "";
    const host = /^(?:[a-z]+:\/\/)?([^/:]+)/.exec(target)?.[1] ?? target;
    return err(`curl: (6) Could not resolve host: ${host}`);
  },
  usage: "curl -s http://checkout-api:8080/actuator/health",
  summary: "Call a service from inside the cluster",
  run(args, { cluster }) {
    const target = args.find((arg) => !arg.startsWith("-"));
    if (!target) return { output: err("curl: try 'curl --help' for more information") };
    let url: URL;
    try {
      url = new URL(target.includes("://") ? target : `http://${target}`);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return { output: err(`curl: (3) URL rejected: Malformed input to a URL function`) };
    }
    const deployment = cluster.deployments.find((candidate) => candidate.name === url.hostname.split(".")[0]);
    if (!deployment) return { output: err(`curl: (6) Could not resolve host: ${url.hostname}`) };
    const serving = deployment.pods.filter(isServing);
    if (serving.length === 0) return { output: err(`curl: (7) Failed to connect to ${url.hostname} port ${url.port || 80} after 3 ms: Couldn't connect to server`) };
    const pod = serving[cluster.t % serving.length];
    const route = ROUTES.find((candidate) => candidate.path.test(url.pathname));
    if (!route) return { output: out('{"timestamp":"…","status":404,"error":"Not Found","path":"' + url.pathname + '"}') };
    const active = Math.min(deployment.poolSize, pod.connectionHistory.at(-1) ?? pod.leaked);
    return { output: out(route.respond({ size: deployment.poolSize, active, isStarved: pod.leaked >= deployment.poolSize })) };
  },
  complete: (_args, _partial, { cluster }) =>
    cluster.deployments.flatMap((deployment) => [
      `http://${deployment.name}:8080/healthz`,
      `http://${deployment.name}:8080/actuator/health`,
      `http://${deployment.name}:8080/actuator/metrics/hikaricp.connections.active`,
    ]),
};
