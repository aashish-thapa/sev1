import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
/** Downloaded sources; gitignored, safe to delete. */
export const CACHE = join(ROOT, ".asset-cache");
/** Built, web-ready assets served by Vite at `/office/`. */
export const PUBLIC = join(ROOT, "public");
