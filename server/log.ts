export type LogLevel = "info" | "warn" | "error";

export type Logger = (level: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>) => void;

/** One JSON object per line, so the process output can go straight into a log pipeline. */
export function jsonLineLogger(write: (line: string) => void, now: () => Date = () => new Date()): Logger {
  return (level, event, fields) => write(`${JSON.stringify({ time: now().toISOString(), level, event, ...fields })}\n`);
}

export const silentLogger: Logger = () => {};
