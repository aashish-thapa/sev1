import { useMemo } from "react";
import { onDesk } from "../environment/deskLayout.ts";
import { DESK } from "../office.ts";
import { DESK_CLUTTER } from "./deskClutter.ts";
import { Mug, PaperCup, SnackModel } from "./Items.tsx";

/** Colleagues' mugs, takeaway cups and half-eaten snacks, each on its own desk. */
export function DeskClutter() {
  const placed = useMemo(() => DESK_CLUTTER.map((clutter) => ({ clutter, frame: onDesk(clutter.desk, 0, DESK.height, 0) })), []);
  return (
    <>
      {placed.map(({ clutter, frame }, index) => (
        <group key={index} matrix={frame} matrixAutoUpdate={false}>
          <group position={[clutter.x, 0, clutter.z]} rotation={[0, index * 1.3, 0]}>
            {clutter.thing.kind === "mug" ? <Mug /> : clutter.thing.kind === "cup" ? <PaperCup /> : <LyingSnack item={clutter.thing.item} />}
          </group>
        </group>
      ))}
    </>
  );
}

/** A bar or a bag lies flat on a desk; an apple just sits there. */
function LyingSnack({ item }: { item: Parameters<typeof SnackModel>[0]["item"] }) {
  return item === "apple" ? (
    <SnackModel item="apple" />
  ) : (
    <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0.05]}>
      <SnackModel item={item} />
    </group>
  );
}
