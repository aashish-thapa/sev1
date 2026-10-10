import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  HOST: z.string().min(1).optional(),
  /** Comma-separated, e.g. `https://sev1.example,http://localhost:5173`. Unset accepts any origin. */
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) => {
      const origins = value?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
      return origins.length > 0 ? origins : null;
    }),
  MAX_ROOMS: z.coerce.number().int().positive().default(200),
});

export type Config = {
  readonly port: number;
  readonly host: string | undefined;
  readonly allowedOrigins: readonly string[] | null;
  readonly maxRooms: number;
};

export type ConfigResult = { readonly ok: true; readonly config: Config } | { readonly ok: false; readonly reason: string };

export function readConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) return { ok: false, reason: z.prettifyError(parsed.error) };
  const { PORT, HOST, ALLOWED_ORIGINS, MAX_ROOMS } = parsed.data;
  return { ok: true, config: { port: PORT, host: HOST, allowedOrigins: ALLOWED_ORIGINS, maxRooms: MAX_ROOMS } };
}
