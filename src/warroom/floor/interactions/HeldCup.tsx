import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { DoubleSide, MathUtils, type Group } from "three";
import { tokenColor } from "../tokens.ts";
import { Steam } from "./Steam.tsx";

/** Where the cup rests in your right hand, in camera space (metres): low right, a forearm away. */
const REST = { x: 0.24, y: -0.27, z: -0.62 } as const;
/** Where it goes for a sip: up and in, tipped toward you. */
const SIP = { x: 0.07, y: -0.1, z: -0.26, tilt: 0.65 } as const;
const SIP_SECONDS = 1.1;

type Props = {
  isHeld: boolean;
  /** Increments on every sip; each change plays one sip. */
  sips: number;
  /** Hidden while the laptop is up: both hands are on the keyboard. */
  isHandsBusy: boolean;
  reduceMotion: boolean;
};

/** A paper cup of office coffee in your hand, with a sleeve, steam, and a lift to your mouth on each sip. */
export function HeldCup({ isHeld, sips, isHandsBusy, reduceMotion }: Props) {
  const camera = useThree((state) => state.camera);
  const rig = useRef<Group>(null);
  const sipStarted = useRef<number | null>(null);
  const lastSips = useRef(sips);

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
    if (sips !== lastSips.current) {
      lastSips.current = sips;
      sipStarted.current = reduceMotion ? null : clock.elapsedTime;
    }
    const elapsed = sipStarted.current === null ? SIP_SECONDS : clock.elapsedTime - sipStarted.current;
    // Up, hold, back down: a sine arch over the sip.
    const lift = elapsed < SIP_SECONDS ? Math.sin((elapsed / SIP_SECONDS) * Math.PI) : 0;
    const sway = reduceMotion ? 0 : Math.sin(clock.elapsedTime * 1.3) * 0.004;
    group.position.set(MathUtils.lerp(REST.x, SIP.x, lift), MathUtils.lerp(REST.y, SIP.y, lift) + sway, MathUtils.lerp(REST.z, SIP.z, lift));
    group.rotation.set(lift * SIP.tilt, -0.25, -lift * 0.2);
  });

  const paper = tokenColor("--color-world-wall");
  const sleeve = tokenColor("--color-world-desk");
  const lid = tokenColor("--color-ink-2");
  return (
    <group ref={rig} visible={false}>
      <mesh>
        <cylinderGeometry args={[0.042, 0.032, 0.12, 28, 1, true]} />
        <meshStandardMaterial color={paper} roughness={0.7} side={DoubleSide} />
      </mesh>
      <mesh position={[0, -0.006, 0]}>
        <cylinderGeometry args={[0.0405, 0.035, 0.05, 28, 1, true]} />
        <meshStandardMaterial color={sleeve} roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.062, 0]}>
        <cylinderGeometry args={[0.044, 0.044, 0.012, 28]} />
        <meshStandardMaterial color={lid} roughness={0.5} />
      </mesh>
      <mesh position={[0, -0.06, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.032, 24]} />
        <meshStandardMaterial color={paper} roughness={0.7} />
      </mesh>
      <Steam origin={[0.012, 0.07, 0]} spread={0.01} rise={0.12} puffs={6} size={0.03} reduceMotion={reduceMotion} />
    </group>
  );
}
