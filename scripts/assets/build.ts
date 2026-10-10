/**
 * Turns `.asset-cache/` sources into web-ready files under `public/office/` (see the catalog for the layout).
 * Rocketbox FBX goes through headless Blender (`BLENDER`, default `blender`); everything is then
 * resized, re-encoded to WebP and meshopt-compressed with glTF Transform.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeIO, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, resample, simplify, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import { assetPath, AVATARS, CLIP_NAMES, PROP_NAMES, SURFACE_MAPS, SURFACE_NAMES, type Sex } from "../../src/warroom/floor/assets/catalog.ts";
import { CLIP_SOURCES, ENVIRONMENT_SOURCE, PROP_SOURCES, SURFACE_SOURCES } from "./manifest.ts";
import { CACHE, PUBLIC } from "./paths.ts";

const WORK = join(CACHE, "work");
const BLENDER = process.env.BLENDER ?? "blender";
const CONVERTER = join(import.meta.dirname, "rocketbox.py");

/** Faces read from a few metres away; 1K keeps clothing weave and faces legible without the 4K weight. */
const AVATAR_TEXTURE = 1024;
const PROP_TEXTURE = 1024;
const SURFACE_TEXTURE = 1024;
/** Props denser than this get decimated — nobody counts a plant's leaf edges at desk distance. */
const PROP_VERTEX_BUDGET = 24_000;

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });

const out = (relative: string) => {
  const path = join(PUBLIC, relative);
  mkdirSync(dirname(path), { recursive: true });
  return path;
};

const isFresh = (target: string, source: string) => existsSync(target) && statSync(target).mtimeMs > statSync(source).mtimeMs;

function blender(...args: string[]): void {
  execFileSync(BLENDER, ["-b", "--factory-startup", "-P", CONVERTER, "--", ...args], { stdio: ["ignore", "ignore", "inherit"] });
}

async function compress(document: Document, textureSize: number): Promise<void> {
  await document.transform(
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [textureSize, textureSize], quality: 82 }),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
}

/** Rocketbox hair and lashes are cut-outs; blending them sorts badly against the head. */
function cutOutOpacityMaterials(document: Document): void {
  for (const material of document.getRoot().listMaterials()) {
    if (material.getAlphaMode() === "BLEND") material.setAlphaMode("MASK").setAlphaCutoff(0.5);
  }
}

async function buildAvatars(): Promise<void> {
  for (const { id } of AVATARS) {
    const source = join(CACHE, "rocketbox", id, "Export", `${id}.fbx`);
    const target = out(assetPath.avatar(id));
    if (isFresh(target, source)) continue;
    const raw = join(WORK, `${id}.glb`);
    mkdirSync(WORK, { recursive: true });
    blender("avatar", source, raw);
    const document = await io.read(raw);
    cutOutOpacityMaterials(document);
    await compress(document, AVATAR_TEXTURE);
    await io.write(target, document);
    console.log(`✓ ${assetPath.avatar(id)}`);
  }
}

async function buildClips(): Promise<void> {
  for (const name of CLIP_NAMES) {
    for (const sex of ["male", "female"] as const satisfies readonly Sex[]) {
      const take = CLIP_SOURCES[name][sex];
      const source = join(CACHE, "rocketbox", "clips", `${take}.fbx`);
      const target = out(assetPath.clip(sex, name));
      if (isFresh(target, source)) continue;
      const raw = join(WORK, `${sex}-${name}.glb`);
      mkdirSync(WORK, { recursive: true });
      blender("clip", source, raw, name, ...(CLIP_SOURCES[name].hasRootMotion ? ["--in-place"] : []));
      const document = await io.read(raw);
      await document.transform(resample(), prune(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
      await io.write(target, document);
      console.log(`✓ ${assetPath.clip(sex, name)}`);
    }
  }
}

function vertexCount(document: Document): number {
  return document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((sum, primitive) => sum + (primitive.getAttribute("POSITION")?.getCount() ?? 0), 0);
}

async function buildProps(): Promise<void> {
  for (const name of PROP_NAMES) {
    const id = PROP_SOURCES[name];
    const source = join(CACHE, "polyhaven", "models", id, `${id}.gltf`);
    const target = out(assetPath.prop(name));
    if (isFresh(target, source)) continue;
    const document = await io.read(source);
    const vertices = vertexCount(document);
    if (vertices > PROP_VERTEX_BUDGET) {
      await document.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: PROP_VERTEX_BUDGET / vertices, error: 0.002 }));
    }
    await compress(document, PROP_TEXTURE);
    await io.write(target, document);
    console.log(`✓ ${assetPath.prop(name)} (${vertices} → ${vertexCount(document)} vertices)`);
  }
}

async function buildSurfaces(): Promise<void> {
  for (const name of SURFACE_NAMES) {
    for (const map of SURFACE_MAPS) {
      const source = join(CACHE, "polyhaven", "textures", SURFACE_SOURCES[name], `${map}.jpg`);
      if (!existsSync(source)) continue;
      const target = out(assetPath.surface(name, map));
      if (isFresh(target, source)) continue;
      await sharp(source).resize(SURFACE_TEXTURE, SURFACE_TEXTURE, { fit: "inside" }).webp({ quality: 82 }).toFile(target);
      console.log(`✓ ${assetPath.surface(name, map)}`);
    }
  }
}

function buildEnvironment(): void {
  const source = join(CACHE, "polyhaven", "hdri", `${ENVIRONMENT_SOURCE}.hdr`);
  const target = out(assetPath.environment());
  if (isFresh(target, source)) return;
  copyFileSync(source, target);
  console.log(`✓ ${assetPath.environment()}`);
}

await buildSurfaces();
buildEnvironment();
await buildProps();
await buildClips();
await buildAvatars();
