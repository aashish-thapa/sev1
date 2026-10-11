/** How you appear: which body you wear, and how you stand in the lobby. Cosmetic; nothing is earned by it. */
import { z } from "zod";
import { AVATARS, type AvatarId } from "../warroom/floor/assets/catalog.ts";

/** Poses for the lobby stage, each one of the bodies' existing clips. */
export const POSES = ["idle", "phone", "talk"] as const;
export type Pose = (typeof POSES)[number];

const AVATAR_IDS = AVATARS.map((avatar) => avatar.id) as [AvatarId, ...AvatarId[]];

export const LookSchema = z.object({
  /** Null until chosen: you're then drawn from your name, as before. */
  avatar: z.enum(AVATAR_IDS).nullable().default(null),
  pose: z.enum(POSES).default("idle"),
});
export type Look = z.output<typeof LookSchema>;

export const DEFAULT_LOOK: Look = { avatar: null, pose: "idle" };

/** The next body along the wardrobe, wrapping at either end. */
export function stepAvatar(current: AvatarId, step: 1 | -1): AvatarId {
  const index = AVATAR_IDS.indexOf(current);
  return AVATAR_IDS[(index + step + AVATAR_IDS.length) % AVATAR_IDS.length];
}

export const AVATAR_COUNT = AVATAR_IDS.length;
export const avatarNumber = (id: AvatarId): number => AVATAR_IDS.indexOf(id) + 1;
