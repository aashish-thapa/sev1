import { jsonLineLogger, type Logger } from "../server/log.ts";

/** Workers Logs captures the console; one JSON object per line keeps it queryable. */
export const workerLogger: Logger = jsonLineLogger((line) => console.log(line.trimEnd()));
