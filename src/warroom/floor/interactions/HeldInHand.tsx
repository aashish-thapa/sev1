import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type ReactNode } from "react";
import { MathUtils, type Group } from "three";

/** Where things rest in your right hand, in camera space (metres): low right, a forearm away. */
const REST = { x: 0.24, y: -0.27, z: -0.62 } as const;
/** Where they go for a sip or a bite: up and in, tipped toward you. */
const TO_MOUTH = { x: 0.07, y: -0.1, z: -0.26, tilt: 0.65 } as const;
const LIFT_SECONDS = 1.1;

type Props = {
  isHeld: boolean;
  /** Changes on every sip or bite; each change lifts the thing to your mouth once. */
  uses: number;
  /** Hidden while the laptop is up: both hands are on the keyboard. */
  isHandsBusy: boolean;
  reduceMotion: boolean;
  children: ReactNode;
};

/** Something in your first-person right hand, lifted to your mouth each time you use it. */
export function HeldInHand({ isHeld, uses, isHandsBusy, reduceMotion, children }: Props) {
  const camera = useThree((state) => state.camera);
  const rig = useRef<Group>(null);
  const liftStarted = useRef<number | null>(null);
  const lastUses = useRef(uses);

  useEffect(() => {
    const group = rig.current;
    if (!group) return;
    camera.add(group);
    return () => {
      camera.remove(group);
    };
  }, [camera]);

  useFrame(({ clock }) => {
    const group = rig.current;
    if (!group) return;
    group.visible = isHeld && !isHandsBusy;
    if (uses !== lastUses.current) {
      lastUses.current = uses;
      liftStarted.current = reduceMotion ? null : clock.elapsedTime;
    }
    const elapsed = liftStarted.current === null ? LIFT_SECONDS : clock.elapsedTime - liftStarted.current;
    // Up, hold, back down: a sine arch over the lift.
    const lift = elapsed < LIFT_SECONDS ? Math.sin((elapsed / LIFT_SECONDS) * Math.PI) : 0;
    const sway = reduceMotion ? 0 : Math.sin(clock.elapsedTime * 1.3) * 0.004;
    group.position.set(MathUtils.lerp(REST.x, TO_MOUTH.x, lift), MathUtils.lerp(REST.y, TO_MOUTH.y, lift) + sway, MathUtils.lerp(REST.z, TO_MOUTH.z, lift));
    group.rotation.set(lift * TO_MOUTH.tilt, -0.25, -lift * 0.2);
  });

  return (
    <group ref={rig} visible={false}>
      {children}
    </group>
  );
}
