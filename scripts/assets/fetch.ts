/** Downloads every source asset named in the manifest into `.asset-cache/` (skips files already there). */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AVATARS } from "../../src/warroom/floor/assets/catalog.ts";
import { CLIP_SOURCES, ENVIRONMENT_SOURCE, POLY_HAVEN, PROP_SOURCES, ROCKETBOX, SURFACE_SOURCES } from "./manifest.ts";
import { CACHE } from "./paths.ts";

const TEXTURE_RESOLUTION = "1k";
const PARALLEL_DOWNLOADS = 6;

type Download = { readonly url: string; readonly to: string };

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "user-agent": "sev1-asset-fetch" } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return (await response.json()) as T;
}

async function save({ url, to }: Download): Promise<void> {
  if (existsSync(to)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, Buffer.from(await response.arrayBuffer()));
  console.log(`↓ ${to.slice(CACHE.length + 1)}`);
}

async function avatarDownloads(): Promise<Download[]> {
  const listings = await Promise.all(
    AVATARS.map(async ({ id }) => {
      const textures = await getJson<{ name: string }[]>(`${ROCKETBOX.api}/Avatars/Adults/${id}/Textures`);
      return [
        { url: `${ROCKETBOX.raw}/Avatars/Adults/${id}/Export/${id}.fbx`, to: join(CACHE, "rocketbox", id, "Export", `${id}.fbx`) },
        ...textures.map(({ name }) => ({ url: `${ROCKETBOX.raw}/Avatars/Adults/${id}/Textures/${name}`, to: join(CACHE, "rocketbox", id, "Textures", name) })),
      ];
    }),
  );
  return listings.flat();
}

function clipDownloads(): Download[] {
  return Object.values(CLIP_SOURCES).flatMap((clip) =>
    [clip.male, clip.female].map((take) => {
      const folder = clip.hasRootMotion ? "all_animations_max_motextr_xy" : "all_animations_max_motextr_static";
      return { url: `${ROCKETBOX.raw}/Animations/${folder}/${take}.max.fbx`, to: join(CACHE, "rocketbox", "clips", `${take}.fbx`) };
    }),
  );
}

type PolyHavenFile = { url: string; include?: Record<string, { url: string }> };

async function propDownloads(): Promise<Download[]> {
  const lists = await Promise.all(
    Object.values(PROP_SOURCES).map(async (id) => {
      const files = await getJson<{ gltf: Record<string, { gltf: PolyHavenFile }> }>(`${POLY_HAVEN.api}/${id}`);
      const gltf = files.gltf[TEXTURE_RESOLUTION]?.gltf;
      if (!gltf) throw new Error(`Poly Haven ${id} has no ${TEXTURE_RESOLUTION} glTF`);
      const folder = join(CACHE, "polyhaven", "models", id);
      return [
        { url: gltf.url, to: join(folder, `${id}.gltf`) },
        ...Object.entries(gltf.include ?? {}).map(([path, file]) => ({ url: file.url, to: join(folder, path) })),
      ];
    }),
  );
  return lists.flat();
}

/** The maps a surface needs; Poly Haven names them per asset, so take the first that exists. */
const SURFACE_MAPS = { color: ["Diffuse", "diff"], normal: ["nor_gl"], roughness: ["Rough", "rough"], ao: ["AO", "ao"] } as const;

async function surfaceDownloads(): Promise<Download[]> {
  const lists = await Promise.all(
    Object.values(SURFACE_SOURCES).map(async (id) => {
      const files = await getJson<Record<string, Record<string, { jpg?: PolyHavenFile }>>>(`${POLY_HAVEN.api}/${id}`);
      return Object.entries(SURFACE_MAPS).flatMap(([map, keys]) => {
        const file = keys.map((key) => files[key]?.[TEXTURE_RESOLUTION]?.jpg).find(Boolean);
        return file ? [{ url: file.url, to: join(CACHE, "polyhaven", "textures", id, `${map}.jpg`) }] : [];
      });
    }),
  );
  return lists.flat();
}

async function environmentDownloads(): Promise<Download[]> {
  const files = await getJson<{ hdri: Record<string, { hdr: PolyHavenFile }> }>(`${POLY_HAVEN.api}/${ENVIRONMENT_SOURCE}`);
  const hdr = files.hdri[TEXTURE_RESOLUTION]?.hdr;
  if (!hdr) throw new Error(`Poly Haven ${ENVIRONMENT_SOURCE} has no ${TEXTURE_RESOLUTION} HDR`);
  return [{ url: hdr.url, to: join(CACHE, "polyhaven", "hdri", `${ENVIRONMENT_SOURCE}.hdr`) }];
}

async function inBatches(downloads: readonly Download[]): Promise<void> {
  const queue = [...downloads];
  const workers = Array.from({ length: PARALLEL_DOWNLOADS }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await save(next);
  });
  await Promise.all(workers);
}

const downloads = [...(await Promise.all([avatarDownloads(), propDownloads(), surfaceDownloads(), environmentDownloads()])).flat(), ...clipDownloads()];
await inBatches(downloads);
console.log(`✓ ${downloads.length} source files in ${CACHE}`);
