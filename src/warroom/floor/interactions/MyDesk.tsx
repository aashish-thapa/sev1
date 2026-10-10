import { useEffect, useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import type { Role } from "../../../domain/incident.ts";
import { promptFor } from "../../shell/prompt.ts";
import { MONITOR, MONITOR_Z, onDesk, SCREEN, SCREEN_Y, SEAT_HEIGHT } from "../environment/deskLayout.ts";
import { DESK, PLAYER_DESK, seatOf } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { cardTexture } from "./textures.ts";

type Props = {
  role: Role;
  /** Click on your monitor: bring up your terminal. */
  onOpenTerminal: (event: ThreeEvent<MouseEvent>) => void;
};

/**
 * What makes the desk yours, without a word of text: your jacket over the chair, your mug, a
 * sticky note on the bezel, and your own shell on the monitor — click it (or press L) to start typing.
 */
export function MyDesk({ role, onOpenTerminal }: Props) {
  const frame = useMemo(() => onDesk(PLAYER_DESK, 0, 0, 0), []);
  const chairFrame = useMemo(() => onDesk(PLAYER_DESK, 0, 0, (seatOf(PLAYER_DESK).z - PLAYER_DESK.z) * PLAYER_DESK.facing), []);
  const terminal = useMemo(
    () =>
      cardTexture({
        lines: [`${promptFor(role)} _`],
        background: "--color-terminal",
        ink: "--color-good",
        width: 640,
        height: 368,
        font: "mono",
        size: 30,
      }),
    [role],
  );
  const note = useMemo(() => cardTexture({ lines: ["on call", "this week —", "be kind to", "future you"], background: "--color-accent", ink: "--color-accent-ink", width: 256, height: 256, font: "body", size: 34 }), []);
  useEffect(() => () => [terminal, note].forEach((texture) => texture.dispose()), [terminal, note]);

  const screenZ = MONITOR_Z - MONITOR.depth / 2 - 0.004;
  const surface = DESK.height;
  const mug = tokenColor("--color-world-wall");
  const coffee = tokenColor("--color-world-desk");

  // The desk's own frame: +z is where its occupant looks and +x is their left, so faces turned by π look back at them.
  return (
    <>
    <group matrix={chairFrame} matrixAutoUpdate={false}>
      <DrapedJacket />
    </group>
    <group matrix={frame} matrixAutoUpdate={false}>
      <mesh position={[0, SCREEN_Y, screenZ]} rotation={[0, Math.PI, 0]} onClick={onOpenTerminal}>
        <planeGeometry args={[SCREEN.width, SCREEN.height]} />
        <meshBasicMaterial map={terminal} toneMapped={false} />
      </mesh>
      <mesh position={[-0.24, SCREEN_Y + MONITOR.height / 2 - 0.05, screenZ - 0.002]} rotation={[0, Math.PI, -0.08]}>
        <planeGeometry args={[0.075, 0.075]} />
        <meshStandardMaterial map={note} roughness={0.9} />
      </mesh>
      <group position={[-0.45, surface, 0]}>
        <mesh position={[0, 0.05, 0]} castShadow>
          <cylinderGeometry args={[0.042, 0.038, 0.1, 24]} />
          <meshStandardMaterial color={mug} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.093, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.037, 24]} />
          <meshStandardMaterial color={coffee} roughness={0.15} />
        </mesh>
        <mesh position={[-0.05, 0.05, 0]} rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.025, 0.007, 8, 16, Math.PI]} />
          <meshStandardMaterial color={mug} roughness={0.35} />
        </mesh>
      </group>
    </group>
    </>
  );
}

/** Chair-back geometry (see Workstations): the backrest's top edge, leaning back slightly. */
const BACKREST = { topY: SEAT_HEIGHT + 0.62, z: -0.27, tilt: -0.12 } as const;

/** Your jacket hung over the back of your chair — the one chair on the floor that's obviously taken, by you. */
function DrapedJacket() {
  const cloth = tokenColor("--color-accent");
  return (
    <group position={[0, BACKREST.topY, BACKREST.z]} rotation={[BACKREST.tilt, 0, 0]}>
      <mesh position={[0, 0.005, 0]} castShadow>
        <boxGeometry args={[0.44, 0.035, 0.1]} />
        <meshStandardMaterial color={cloth} roughness={0.95} />
      </mesh>
      <mesh position={[0, -0.2, -0.05]} rotation={[0.06, 0, 0]} castShadow>
        <boxGeometry args={[0.42, 0.4, 0.02]} />
        <meshStandardMaterial color={cloth} roughness={0.95} />
      </mesh>
      <mesh position={[0, -0.09, 0.045]} castShadow>
        <boxGeometry args={[0.4, 0.17, 0.018]} />
        <meshStandardMaterial color={cloth} roughness={0.95} />
      </mesh>
      {[-0.24, 0.24].map((x) => (
        <mesh key={x} position={[x, -0.22, -0.035]} rotation={[0.05, 0, x > 0 ? -0.08 : 0.08]} castShadow>
          <cylinderGeometry args={[0.032, 0.026, 0.42, 10]} />
          <meshStandardMaterial color={cloth} roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}
