import { knownTags } from "../domain/tags.ts";

/** Granted tags next to a name, e.g. Creator. Unknown ids (a newer server's) are skipped. */
export function TagMarks({ ids }: { ids: readonly string[] }) {
  return (
    <>
      {knownTags(ids).map((tag) => (
        <span key={tag.id} className="tag-mark" data-tag={tag.id} title={tag.description}>
          {tag.label}
        </span>
      ))}
    </>
  );
}
