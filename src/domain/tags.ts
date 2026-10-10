/**
 * Tags are granted, not earned: the server stores them on an account and nobody can claim one
 * from the client. They read next to a name like a badge, but outrank it visually.
 */
export type Tag = {
  readonly id: string;
  readonly label: string;
  /** What hovering the tag explains. */
  readonly description: string;
};

export const TAGS: readonly Tag[] = [{ id: "creator", label: "Creator", description: "Made sev1." }];

export function tagById(id: string): Tag | undefined {
  return TAGS.find((tag) => tag.id === id);
}

/** The known tags among `ids`, in catalog order; ids this build doesn't know are skipped. */
export function knownTags(ids: readonly string[]): Tag[] {
  return TAGS.filter((tag) => ids.includes(tag.id));
}
