import { AnimationClip, type Mesh, type Object3D, type SkinnedMesh } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { assetPath, AVATARS, CLIP_NAMES, type AvatarId, type ClipName, type Sex } from "../assets/catalog.ts";
import { assetUrl } from "../assets/url.ts";

export const avatarUrl = (id: AvatarId) => assetUrl(assetPath.avatar(id));
export const clipUrls = (sex: Sex) => CLIP_NAMES.map((name) => assetUrl(assetPath.clip(sex, name)));

const SEX_OF = new Map<AvatarId, Sex>(AVATARS.map((avatar) => [avatar.id, avatar.sex]));
export const sexOf = (id: AvatarId): Sex => SEX_OF.get(id) ?? "male";

/**
 * Ground speed (m/s) each locomotion take covers at timeScale 1, measured from the
 * root motion the build pins in place. Playback is scaled to the real speed so feet don't slide.
 */
export const STRIDE_SPEED: Readonly<Record<Sex, { readonly walk: number; readonly hurry: number }>> = {
  male: { walk: 1.01, hurry: 1.5 },
  female: { walk: 1.21, hurry: 1.53 },
};

/** Same person every time for the same seed — teammates keep their look across reconnects. */
export function avatarFor(seed: string): AvatarId {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return AVATARS[Math.abs(hash) % AVATARS.length].id;
}

/** Height of a standing avatar's crown, for name tags and speech bubbles. */
export const HEAD_HEIGHT = 1.78;

/**
 * Skinned bounds are the bind pose in the rig's own units and go stale as limbs move;
 * the floor culls each person as a body-sized sphere in world space instead (see Avatar).
 */
export function cloneAvatar(scene: Object3D): Object3D {
  const copy = cloneSkinned(scene);
  copy.traverse((node) => {
    if (!(node as SkinnedMesh).isSkinnedMesh) return;
    node.frustumCulled = false;
    node.castShadow = true;
  });
  return copy;
}

/** Rocketbox gives the head, and the hair with lashes, their own materials (`…_head`, `…_opacity`). */
const HEAD_MATERIAL = /_(head|opacity)$/;

/** Your own body in first person: the camera sits where the eyes are, so the head would fill the view. */
export function hideHead(body: Object3D): void {
  body.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some((material) => HEAD_MATERIAL.test(material.name))) mesh.visible = false;
  });
}

/** Rocketbox takes animate end-effector bones ("Nub", fingertips, toes) the avatars were exported without. */
export function clipsFor(clips: readonly AnimationClip[][], skeleton: Object3D): Map<ClipName, AnimationClip> {
  const bones = new Set<string>();
  skeleton.traverse((node) => bones.add(node.name));
  const result = new Map<ClipName, AnimationClip>();
  CLIP_NAMES.forEach((name, index) => {
    const clip = clips[index]?.[0];
    if (!clip) return;
    const tracks = clip.tracks.filter((track) => bones.has(track.name.slice(0, track.name.lastIndexOf("."))));
    result.set(name, new AnimationClip(name, clip.duration, tracks));
  });
  return result;
}
