import { readConfig } from "./config.ts";
import { jsonLineLogger } from "./log.ts";
import { DEFAULT_ROOM_TIMING } from "./room.ts";
import { findScenario } from "./scenarios.ts";
import { startServer } from "./server.ts";

const ROOM_GRACE_MS = 5 * 60_000;
const HEARTBEAT_MS = 30_000;

const logger = jsonLineLogger((line) => process.stdout.write(line));
const configured = readConfig(process.env);
if (!configured.ok) {
  logger("error", "config_invalid", { reason: configured.reason });
  process.exit(1);
}
const { config } = configured;

const server = await startServer({
  ...config,
  roomGraceMs: ROOM_GRACE_MS,
  heartbeatMs: HEARTBEAT_MS,
  timing: DEFAULT_ROOM_TIMING,
  findScenario,
  random: Math.random,
  logger,
});
logger("info", "listening", { port: server.port, host: config.host ?? null, origins: config.allowedOrigins });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger("info", "shutting_down", { signal });
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger("error", "shutdown_failed", { message: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      },
    );
  });
}
