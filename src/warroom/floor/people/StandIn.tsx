import { tokenColor } from "../tokens.ts";

/** A plain silhouette shown while someone's avatar streams in, so the floor is never empty. */
export function StandIn({ isSeated }: { isSeated: boolean }) {
  const cloth = tokenColor("--color-outfit-3");
  const skin = tokenColor("--color-skin-2");
  const hip = isSeated ? 0.5 : 0.92;
  return (
    <>
      {!isSeated && (
        <mesh position={[0, hip / 2, 0]}>
          <boxGeometry args={[0.36, hip, 0.18]} />
          <meshStandardMaterial color={cloth} roughness={0.85} />
        </mesh>
      )}
      <mesh position={[0, hip + 0.32, 0]}>
        <boxGeometry args={[0.44, 0.64, 0.25]} />
        <meshStandardMaterial color={cloth} roughness={0.8} />
      </mesh>
      <mesh position={[0, hip + 0.8, 0]}>
        <sphereGeometry args={[0.13, 18, 14]} />
        <meshStandardMaterial color={skin} roughness={0.7} />
      </mesh>
    </>
  );
}
