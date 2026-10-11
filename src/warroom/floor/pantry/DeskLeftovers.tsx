import { useMemo } from "react";
import { onDesk } from "../environment/deskLayout.ts";
import type { Leftover } from "../interactions/useLeftovers.ts";
import { DESK, type Desk } from "../office.ts";
import { PaperCup, SnackLeftover } from "./Items.tsx";

/** Spots on the right of your desk, in the desk's own frame (+x is your left), front to back. */
const SPOTS = [
  [-0.5, 0.06],
  [-0.36, -0.08],
  [-0.58, -0.16],
  [-0.28, 0.1],
] as const;

/** What you've finished today, left where you'd leave it: next to the keyboard. */
export function DeskLeftovers({ leftovers, desk }: { leftovers: readonly Leftover[]; desk: Desk }) {
  const frame = useMemo(() => onDesk(desk, 0, DESK.height, 0), [desk]);
  return (
    <group matrix={frame} matrixAutoUpdate={false}>
      {leftovers.map((leftover, index) => {
        const [x, z] = SPOTS[index % SPOTS.length];
        return (
          <group key={index} position={[x, 0, z]}>
            {leftover.kind === "cup" ? <PaperCup /> : <SnackLeftover item={leftover.item} />}
          </group>
        );
      })}
    </group>
  );
}
