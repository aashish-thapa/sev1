import { useEffect, useMemo } from "react";
import { cardTexture } from "./textures.ts";
import { NOTE_WALL } from "./useStickyWall.ts";

const NOTE_SIZE = 0.13;
const GAP = 0.03;
/** Your notes start just past the team's sheet, in two rows at eye height. */
const FIRST_Z = NOTE_WALL.z + 0.5;
const ROWS = [NOTE_WALL.y + 0.08, NOTE_WALL.y - 0.1] as const;

/** The notes you pinned, on the west wall beside the team's (the wall faces +x). */
export function PinnedNotes({ notes }: { notes: readonly string[] }) {
  const textures = useMemo(
    () => notes.map((note) => cardTexture({ lines: [note], background: "--color-accent", ink: "--color-accent-ink", width: 256, height: 256, font: "body", size: 30 })),
    [notes],
  );
  useEffect(() => () => textures.forEach((texture) => texture.dispose()), [textures]);
  return (
    <>
      {textures.map((texture, index) => (
        <mesh key={index} position={[NOTE_WALL.x - 0.04, ROWS[index % 2], FIRST_Z + Math.floor(index / 2) * (NOTE_SIZE + GAP)]} rotation={[0, Math.PI / 2, (index % 3) * 0.03 - 0.03]}>
          <planeGeometry args={[NOTE_SIZE, NOTE_SIZE]} />
          <meshStandardMaterial map={texture} roughness={0.9} />
        </mesh>
      ))}
    </>
  );
}
