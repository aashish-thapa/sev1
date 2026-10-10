import { DoubleSide } from "three";
import { cupSpot } from "../environment/coffeeMachine.ts";
import type { Footprint } from "../layout.ts";
import { tokenColor } from "../tokens.ts";
import { Steam } from "./Steam.tsx";

/** Your cup on the drip tray while the machine pours, steaming. */
export function BrewingCup({ machine, reduceMotion }: { machine: Footprint; reduceMotion: boolean }) {
  const spot = cupSpot(machine);
  const paper = tokenColor("--color-world-wall");
  return (
    <group position={[spot.x, spot.y, spot.z]}>
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.035, 0.027, 0.1, 24, 1, true]} />
        <meshStandardMaterial color={paper} roughness={0.7} side={DoubleSide} />
      </mesh>
      <Steam origin={[0, 0.11, 0]} spread={0.015} rise={0.22} puffs={8} size={0.05} reduceMotion={reduceMotion} />
    </group>
  );
}
