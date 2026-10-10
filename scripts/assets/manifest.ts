/**
 * Where each asset in the office's catalog comes from, and its licence.
 * `fetch.ts` downloads these into `.asset-cache/`; `build.ts` turns them into `public/office/`.
 */
import type { ClipName, PropName, SurfaceName } from "../../src/warroom/floor/assets/catalog.ts";

export const ROCKETBOX = {
  licence: "MIT — Microsoft Rocketbox Avatar Library (github.com/microsoft/Microsoft-Rocketbox)",
  raw: "https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets",
  api: "https://api.github.com/repos/microsoft/Microsoft-Rocketbox/contents/Assets",
} as const;

/** Rocketbox ships one take per file; walks only exist with root motion, which the build pins in place. */
export const CLIP_SOURCES: Readonly<Record<ClipName, { male: string; female: string; hasRootMotion: boolean }>> = {
  idle: { male: "m_idle_neutral_01", female: "f_idle_neutral_01", hasRootMotion: false },
  walk: { male: "m_walk_neutral_01", female: "f_walk_neutral_01", hasRootMotion: true },
  hurry: { male: "m_walk_fast_01", female: "f_walk_fast_01", hasRootMotion: true },
  talk: { male: "m_gestic_talk_neutral_01", female: "f_gestic_talk_neutral_01", hasRootMotion: false },
  "talk-nervous": { male: "m_gestic_talk_nervous_01", female: "f_gestic_talk_nervous_01", hasRootMotion: false },
  phone: { male: "m_cell_phone_talk_01", female: "f_cell_phone_textmessage", hasRootMotion: false },
  desk: { male: "m_sit_table_idle_neutral_01", female: "f_sit_table_idle_neutral_01", hasRootMotion: false },
};

export const POLY_HAVEN = {
  licence: "CC0 — Poly Haven (polyhaven.com)",
  api: "https://api.polyhaven.com/files",
} as const;

export const PROP_SOURCES: Readonly<Record<PropName, string>> = {
  "executive-desk": "metal_office_desk",
  "plant-large": "potted_plant_02",
  "plant-small": "potted_plant_04",
  sofa: "sofa_02",
  "coffee-table": "modern_coffee_table_01",
  "coffee-cart": "CoffeeCart_01",
  shelves: "steel_frame_shelves_01",
  "wall-clock": "wall_clock",
  armchair: "modern_arm_chair_01",
  "lounge-chair": "mid_century_lounge_chair",
  "security-camera": "security_camera_01",
  "desk-lamp": "desk_lamp_arm_01",
  "pendant-lamp": "modern_ceiling_lamp_01",
  "projector-screen": "projector_screen",
  "sticky-notes": "office_notepads",
};

export const SURFACE_SOURCES: Readonly<Record<SurfaceName, string>> = {
  "office-floor": "laminate_floor_02",
  "raised-floor": "granite_tile",
  carpet: "poly_wool_herringbone",
  wall: "painted_plaster_wall",
  ceiling: "ceiling_interior",
};

export const ENVIRONMENT_SOURCE = "unfinished_office";
