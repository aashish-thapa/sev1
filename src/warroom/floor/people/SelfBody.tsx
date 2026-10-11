import { useLook } from "../../../app/look-context.ts";
import { useFrame } from "@react-three/fiber";
import { Suspense, useRef } from "react";
import type { Group } from "three";
import type { Point } from "../navigation.ts";
import { Avatar } from "./Avatar.tsx";
import { wornAvatar } from "./avatars.ts";
import { motionFor } from "./behaviour.ts";
import { follow, STILL_SPEED, type Follower } from "./follow.ts";
import { chairOf, type Stance } from "../interactions/stance.ts";

/** How far the body stands behind the eyes, so looking down shows chest and feet, not the inside of the neck. */
const NECK_BEHIND_EYES = 0.2;

type Props = {
  /** Same seed teammates use for you (your player id, or your role when solo), so everyone sees one body. */
  seed: string;
  getPlayer: () => Point & { readonly yaw: number };
  /** Seated, the body sits on the chair under the eyes instead of standing behind them. */
  getStance: () => Stance;
  reduceMotion: boolean;
};

/** Your own body in first person: look down and you see yourself standing, walking, turning. */
export function SelfBody({ seed, getPlayer, getStance, reduceMotion }: Props) {
  const look = useLook();
  const body = useRef<Group>(null);
  const follower = useRef<Follower | null>(null);
  const motion = () => {
    if (getStance().kind === "seated") return motionFor({ state: "seated" }, 0, reduceMotion);
    const speed = follower.current?.speed ?? 0;
    return motionFor(speed > STILL_SPEED ? { state: "walking", speed } : { state: "standing", activity: "waiting" }, 0, reduceMotion);
  };

  useFrame((_, delta) => {
    const group = body.current;
    if (!group) return;
    const player = getPlayer();
    const stance = getStance();
    if (stance.kind === "seated") {
      const chair = chairOf(stance.seat);
      group.position.set(chair.x, 0, chair.z);
      group.rotation.y = stance.seat.yaw + Math.PI;
      follower.current = { x: player.x, z: player.z, speed: 0 };
      return;
    }
    // The rig already moves smoothly; following it here only measures the speed the legs should match.
    follower.current = follow(follower.current ?? { x: player.x, z: player.z, speed: 0 }, player, delta);
    group.position.set(player.x + Math.sin(player.yaw) * NECK_BEHIND_EYES, 0, player.z + Math.cos(player.yaw) * NECK_BEHIND_EYES);
    group.rotation.y = player.yaw + Math.PI;
  });

  return (
    <group ref={body}>
      <Suspense fallback={null}>
        <Avatar id={wornAvatar(look.avatar, seed)} motion={motion} isFirstPerson />
      </Suspense>
    </group>
  );
}
