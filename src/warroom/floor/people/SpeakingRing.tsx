import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Mesh, MeshBasicMaterial } from "three";
import { tokenColor } from "../tokens.ts";

/** Below this the mic is just room noise. */
const SILENCE = 0.08;
/** How quickly the light follows the voice, per second: fast to rise, slower to fade, like a VU meter. */
const RISE = 18;
const FALL = 5;

type Props = {
  /** Read every frame: how loud they are right now, 0…1. */
  level: () => number;
};

/** A soft ring of light on the floor under a teammate while they talk — you see who's speaking without reading anything. */
export function SpeakingRing({ level }: Props) {
  const ring = useRef<Mesh>(null);
  const shown = useRef(0);
  const color = tokenColor("--color-good");

  useFrame((_, delta) => {
    const mesh = ring.current;
    if (!mesh) return;
    const loudness = level();
    const target = loudness > SILENCE ? Math.min(1, loudness * 1.6) : 0;
    const rate = target > shown.current ? RISE : FALL;
    shown.current += (target - shown.current) * Math.min(1, delta * rate);
    const material = mesh.material as MeshBasicMaterial;
    material.opacity = shown.current * 0.75;
    mesh.visible = shown.current > 0.02;
    mesh.scale.setScalar(1 + shown.current * 0.15);
  });

  return (
    <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} visible={false}>
      <ringGeometry args={[0.34, 0.42, 48]} />
      <meshBasicMaterial color={color} transparent opacity={0} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
