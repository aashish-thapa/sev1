import { DoubleSide, type Material } from "three";
import { COUNTER_TOP } from "../environment/coffeeMachine.ts";
import type { Footprint } from "../layout.ts";
import { tokenColor } from "../tokens.ts";
import { SnackModel } from "./Items.tsx";

type Props = { box: Footprint; wood: Material; metal: Material };

const APPLES = [
  [0, 0],
  [0.05, 0.035],
  [-0.045, 0.04],
  [0.02, -0.05],
  [0, 0.01, 0.045],
] as const;

/** The kitchen's snack corner on the counter: a bowl of apples up front, a two-shelf rack of bars and chips behind. */
export function SnackShelf({ box, wood, metal }: Props) {
  const bowl = tokenColor("--color-world-wood");
  const rackX = box.x + 0.12;
  const bowlX = box.x - 0.16;
  return (
    <group>
      {/* Bowl: a shallow open cylinder with apples heaped in it. */}
      <group position={[bowlX, COUNTER_TOP, box.z + 0.22]} scale={1.3}>
        <mesh position={[0, 0.035, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.13, 0.08, 0.07, 28, 1, true]} />
          <meshStandardMaterial color={bowl} roughness={0.55} side={DoubleSide} />
        </mesh>
        {APPLES.map(([x, z, lift = 0], index) => (
          <group key={index} position={[x, 0.02 + lift, z]} rotation={[0, index, 0.2]}>
            <SnackModel item="apple" />
          </group>
        ))}
      </group>
      {/* Rack: two wooden shelves on metal uprights, packets lined up facing the kitchen. */}
      <group position={[rackX, COUNTER_TOP, box.z - 0.12]} scale={1.45}>
        {[-0.2, 0.2].map((z) => (
          <mesh key={z} material={metal} position={[0.06, 0.2, z]}>
            <boxGeometry args={[0.015, 0.4, 0.015]} />
          </mesh>
        ))}
        {[0.02, 0.22].map((y, shelf) => (
          <group key={y} position={[0, y, 0]}>
            <mesh material={wood} position={[0, 0, 0]} receiveShadow>
              <boxGeometry args={[0.16, 0.015, 0.44]} />
            </mesh>
            {[-0.15, -0.075, 0, 0.075, 0.15].map((z, slot) => (
              <group key={z} position={[-0.02, 0.008, z]} rotation={[0, -Math.PI / 2, shelf === 0 ? 0 : -0.15]}>
                <SnackModel item={(shelf + slot) % 2 === 0 ? "granola-bar" : "chips"} />
              </group>
            ))}
          </group>
        ))}
      </group>
    </group>
  );
}
