/** Small pantry things as 3D models, in metres, standing upright on their base: a paper cup, a mug, the snacks. */
import { DoubleSide } from "three";
import type { SnackId } from "../../../domain/pantry.ts";
import { tokenColor } from "../tokens.ts";

/** A takeaway paper cup with a cardboard sleeve and a lid. */
export function PaperCup() {
  const paper = tokenColor("--color-world-wall");
  const sleeve = tokenColor("--color-world-desk");
  const lid = tokenColor("--color-ink-2");
  return (
    <group>
      <mesh position={[0, 0.055, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.031, 0.11, 20, 1, true]} />
        <meshStandardMaterial color={paper} roughness={0.7} side={DoubleSide} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.038, 0.035, 0.04, 20, 1, true]} />
        <meshStandardMaterial color={sleeve} roughness={0.9} side={DoubleSide} />
      </mesh>
      <mesh position={[0, 0.113, 0]}>
        <cylinderGeometry args={[0.041, 0.041, 0.008, 20]} />
        <meshStandardMaterial color={lid} roughness={0.5} />
      </mesh>
    </group>
  );
}

/** A ceramic desk mug with a handle. */
export function Mug() {
  const ceramic = tokenColor("--color-world-wall");
  const coffee = tokenColor("--color-world-desk");
  return (
    <group>
      <mesh position={[0, 0.045, 0]} castShadow>
        <cylinderGeometry args={[0.038, 0.035, 0.09, 20]} />
        <meshStandardMaterial color={ceramic} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.087, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.033, 20]} />
        <meshStandardMaterial color={coffee} roughness={0.15} />
      </mesh>
      <mesh position={[0.045, 0.045, 0]} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.022, 0.006, 8, 16, Math.PI]} />
        <meshStandardMaterial color={ceramic} roughness={0.35} />
      </mesh>
    </group>
  );
}

/** One snack, as you'd hold it: a wrapped bar, an apple, a bag of chips. */
export function SnackModel({ item, bitesTaken = 0 }: { item: SnackId; bitesTaken?: number }) {
  switch (item) {
    case "granola-bar":
      return <GranolaBar shortenedBy={bitesTaken * 0.025} />;
    case "apple":
      return <Apple />;
    case "chips":
      return <ChipsBag />;
  }
}

function GranolaBar({ shortenedBy }: { shortenedBy: number }) {
  const wrapper = tokenColor("--color-accent");
  const bar = tokenColor("--color-world-wood");
  const length = 0.11 - shortenedBy;
  return (
    <group>
      <mesh position={[0, length / 2, 0]} castShadow>
        <boxGeometry args={[0.035, length, 0.014]} />
        <meshStandardMaterial color={bar} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.03, 0]}>
        <boxGeometry args={[0.038, 0.06, 0.017]} />
        <meshStandardMaterial color={wrapper} roughness={0.35} metalness={0.3} />
      </mesh>
    </group>
  );
}

function Apple() {
  const skin = tokenColor("--color-critical");
  const stem = tokenColor("--color-world-wood");
  return (
    <group>
      <mesh position={[0, 0.038, 0]} scale={[1, 0.92, 1]} castShadow>
        <sphereGeometry args={[0.04, 20, 16]} />
        <meshStandardMaterial color={skin} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.08, 0]} rotation={[0, 0, 0.2]}>
        <cylinderGeometry args={[0.003, 0.003, 0.018, 6]} />
        <meshStandardMaterial color={stem} roughness={0.9} />
      </mesh>
    </group>
  );
}

function ChipsBag() {
  const foil = tokenColor("--color-accent");
  const band = tokenColor("--color-world-wall");
  return (
    <group>
      <mesh position={[0, 0.07, 0]} scale={[1, 1, 0.45]} castShadow>
        <boxGeometry args={[0.1, 0.14, 0.06]} />
        <meshStandardMaterial color={foil} roughness={0.25} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0.07, 0.0145]}>
        <planeGeometry args={[0.09, 0.03]} />
        <meshStandardMaterial color={band} roughness={0.6} />
      </mesh>
    </group>
  );
}

/** What's left of a snack: a crumpled wrapper, or an apple core. */
export function SnackLeftover({ item }: { item: SnackId }) {
  if (item === "apple") {
    const flesh = tokenColor("--color-world-wall");
    const skin = tokenColor("--color-critical");
    return (
      <group rotation={[0, 0, Math.PI / 2]} position={[0, 0.018, 0]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.012, 0.012, 0.06, 10]} />
          <meshStandardMaterial color={flesh} roughness={0.8} />
        </mesh>
        {[-1, 1].map((end) => (
          <mesh key={end} position={[0, end * 0.03, 0]} scale={[1, 0.45, 1]}>
            <sphereGeometry args={[0.022, 12, 8]} />
            <meshStandardMaterial color={skin} roughness={0.4} />
          </mesh>
        ))}
      </group>
    );
  }
  const foil = tokenColor("--color-accent");
  return (
    <mesh position={[0, 0.012, 0]} scale={item === "chips" ? [1.4, 0.35, 1] : [1, 0.3, 0.7]} rotation={[0, 0.6, 0]} castShadow>
      <icosahedronGeometry args={[0.035, 0]} />
      <meshStandardMaterial color={foil} roughness={0.3} metalness={0.5} flatShading />
    </mesh>
  );
}
