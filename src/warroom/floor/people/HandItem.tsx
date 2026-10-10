import { createPortal, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Quaternion, Vector3, type Group, type Object3D } from "three";
import type { Carried } from "../office.ts";
import { PaperCup, SnackModel } from "../pantry/Items.tsx";

/** Rocketbox names its right hand like this (three.js turns the spaces into underscores on load). */
const RIGHT_HAND = /^Bip01[ _]R[ _]Hand$/;
/**
 * Where the item sits in the hand's own frame, metres: out along the fingers (+x), and turned so
 * its up axis matches world up while the arm hangs relaxed — measured from the rig's idle pose.
 */
const GRIP_AT = [0.075, 0.02, 0] as const;
const GRIP_UP = new Vector3(-0.73, -0.66, 0.15).normalize();
const GRIP_TURN = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), GRIP_UP);
const SCRATCH = new Vector3();

type Props = {
  body: Object3D;
  /** Read every frame: what's in the hand right now. */
  carried: () => Carried | null;
};

/** A cup or a snack in a colleague's right hand, following the hand through every animation. */
export function HandItem({ body, carried }: Props) {
  const hand = useMemo(() => {
    let found: Object3D | null = null;
    body.traverse((node) => {
      if (!found && RIGHT_HAND.test(node.name)) found = node;
    });
    return found as Object3D | null;
  }, [body]);
  const holder = useRef<Group>(null);
  const cup = useRef<Group>(null);
  const snack = useRef<Group>(null);

  useFrame(() => {
    const group = holder.current;
    if (!group || !hand) return;
    // The rig is authored in centimetres; undo the hand's world scale so the item stays real-sized.
    hand.getWorldScale(SCRATCH);
    if (SCRATCH.x > 0) group.scale.setScalar(1 / SCRATCH.x);
    const item = carried();
    if (cup.current) cup.current.visible = item === "cup";
    if (snack.current) snack.current.visible = item === "snack";
  });

  if (!hand) return null;
  return createPortal(
    <group ref={holder}>
      <group position={GRIP_AT} quaternion={GRIP_TURN}>
        <group ref={cup} visible={false} position={[0, -0.05, 0]}>
          <PaperCup />
        </group>
        <group ref={snack} visible={false} position={[0, -0.04, 0]}>
          <SnackModel item="granola-bar" />
        </group>
      </group>
    </group>,
    hand,
  );
}
