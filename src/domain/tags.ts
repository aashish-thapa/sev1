/**
 * Tags are granted, not earned: the server stores them on an account and nobody can claim one
 * from the client. They read next to a name like a badge, but outrank it visually.
 */
export type Tag = {
  readonly id: string;
  readonly label: string;
  /** What hovering the tag explains. */
  readonly description: string;
  /** False for a permission (like admin) that grants access but is never shown by a name. */
  readonly isShown: boolean;
};

export const TAGS: readonly Tag[] = [
  { id: "creator", label: "Creator", description: "Made sev1.", isShown: true },
  { id: "admin", label: "Admin", description: "Can open the admin dashboard.", isShown: false },
];

/** Whether an account's tags let it into the admin dashboard; the server makes the same check on every request. */
export function isAdmin(ids: readonly string[]): boolean {
  return ids.includes("admin");
}

export function tagById(id: string): Tag | undefined {
  return TAGS.find((tag) => tag.id === id);
}

/** The tags to show by a name, in catalog order: known ones only, permissions never. */
export function knownTags(ids: readonly string[]): Tag[] {
  return TAGS.filter((tag) => tag.isShown && ids.includes(tag.id));
}

/**
 * The ids safe to send to anyone but the account's owner: shown catalog tags only. Permissions such
 * as admin never leave the server this way, since naming the admin tells an attacker whose password to guess.
 */
export function shownTags(ids: readonly string[]): string[] {
  return knownTags(ids).map((tag) => tag.id);
}
