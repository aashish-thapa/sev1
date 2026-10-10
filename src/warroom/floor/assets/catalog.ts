/**
 * The office's built assets, by name. `scripts/assets/` produces exactly these files under `public/office/`;
 * the floor loads them through `assetPath`. Sources and licences live in `scripts/assets/manifest.ts`.
 */

export type Sex = "male" | "female";
export type Avatar = { readonly id: string; readonly sex: Sex };

export const AVATARS = [
  { id: "Male_Adult_02", sex: "male" },
  { id: "Male_Adult_04", sex: "male" },
  { id: "Male_Adult_07", sex: "male" },
  { id: "Male_Adult_08", sex: "male" },
  { id: "Male_Adult_09", sex: "male" },
  { id: "Male_Adult_10", sex: "male" },
  { id: "Male_Adult_12", sex: "male" },
  { id: "Female_Adult_02", sex: "female" },
  { id: "Female_Adult_05", sex: "female" },
  { id: "Female_Adult_06", sex: "female" },
  { id: "Female_Adult_08", sex: "female" },
  { id: "Female_Adult_09", sex: "female" },
  { id: "Female_Adult_12", sex: "female" },
] as const satisfies readonly Avatar[];

export type AvatarId = (typeof AVATARS)[number]["id"];

/** Every avatar can play every clip; each sex has its own take. */
export const CLIP_NAMES = ["idle", "walk", "hurry", "talk", "talk-nervous", "phone", "desk"] as const;
export type ClipName = (typeof CLIP_NAMES)[number];

export const PROP_NAMES = [
  "executive-desk",
  "plant-large",
  "plant-small",
  "sofa",
  "coffee-table",
  "coffee-cart",
  "shelves",
  "wall-clock",
  "armchair",
  "lounge-chair",
  "security-camera",
  "desk-lamp",
  "pendant-lamp",
  "projector-screen",
  "sticky-notes",
] as const;
export type PropName = (typeof PROP_NAMES)[number];

export const SURFACE_NAMES = ["office-floor", "raised-floor", "carpet", "wall", "ceiling"] as const;
export type SurfaceName = (typeof SURFACE_NAMES)[number];

export const SURFACE_MAPS = ["color", "normal", "roughness", "ao"] as const;
export type SurfaceMap = (typeof SURFACE_MAPS)[number];

export const ENVIRONMENT_NAME = "office";

/** Paths relative to the site root; the app prefixes its base URL. */
export const assetPath = {
  avatar: (id: AvatarId) => `office/people/${id}.glb`,
  clip: (sex: Sex, name: ClipName) => `office/clips/${sex}/${name}.glb`,
  prop: (name: PropName) => `office/props/${name}.glb`,
  surface: (name: SurfaceName, map: SurfaceMap) => `office/surfaces/${name}/${map}.webp`,
  environment: () => `office/env/${ENVIRONMENT_NAME}.hdr`,
} as const;
