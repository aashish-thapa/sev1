import { tokenColor } from "../tokens.ts";

/** Lid opens this far back from the keyboard, radians. */
const LID_ANGLE = 1.9;

type Props = {
  /** Where the laptop sits relative to the body: in the hands when standing, on the desk when seated. */
  position: readonly [number, number, number];
};

/** A teammate's open laptop, screen lit toward them: how you tell from across the floor that they're in a terminal. */
export function HeldLaptop({ position }: Props) {
  const shell = tokenColor("--color-world-aluminium");
  const screen = tokenColor("--color-terminal");
  const glow = tokenColor("--color-good");
  return (
    <group position={[position[0], position[1], position[2]]}>
      <mesh castShadow>
        <boxGeometry args={[0.32, 0.016, 0.22]} />
        <meshStandardMaterial color={shell} metalness={0.7} roughness={0.35} />
      </mesh>
      {/* The body faces +z, so the hinge is on the far (+z) edge and the lid leans a little past upright, screen toward them. */}
      <group position={[0, 0.008, 0.11]} rotation={[LID_ANGLE - Math.PI / 2, 0, 0]}>
        <mesh position={[0, 0.11, 0]} castShadow>
          <boxGeometry args={[0.32, 0.22, 0.01]} />
          <meshStandardMaterial color={shell} metalness={0.7} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.11, -0.0055]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[0.29, 0.19]} />
          <meshStandardMaterial color={screen} emissive={glow} emissiveIntensity={0.35} />
        </mesh>
      </group>
    </group>
  );
}
