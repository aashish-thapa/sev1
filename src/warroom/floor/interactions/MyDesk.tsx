import { useEffect, useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { DoubleSide } from "three";
import { useCareer } from "../../../app/career-context.ts";
import type { Role } from "../../../domain/incident.ts";
import { ROLE_INFO } from "../../../domain/roles.ts";
import { promptFor } from "../../shell/prompt.ts";
import { MONITOR, MONITOR_Z, onDesk, SCREEN, SCREEN_Y } from "../environment/deskLayout.ts";
import { DESK, PLAYER_DESK } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { cardTexture } from "./textures.ts";

type Props = {
  role: Role;
  /** Click on your monitor: bring up your terminal. */
  onOpenTerminal: (event: ThreeEvent<MouseEvent>) => void;
};

/**
 * What makes the desk yours: a name plate with your title and team, your mug, a sticky note on
 * the bezel, and your own terminal on the monitor — click it (or press L) to start typing.
 */
export function MyDesk({ role, onOpenTerminal }: Props) {
  const career = useCareer();
  const frame = useMemo(() => onDesk(PLAYER_DESK, 0, 0, 0), []);
  const plate = useMemo(
    () => cardTexture({ lines: [career.title, ROLE_INFO[role].label], background: "--color-paper-2", ink: "--color-ink", width: 512, height: 160, font: "display", size: 44 }),
    [career.title, role],
  );
  const terminal = useMemo(
    () =>
      cardTexture({
        lines: [promptFor(role), "", "Your terminal.", "Click here or press L to work."],
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
  useEffect(() => () => [plate, terminal, note].forEach((texture) => texture.dispose()), [plate, terminal, note]);

  const screenZ = MONITOR_Z - MONITOR.depth / 2 - 0.004;
  const surface = DESK.height;
  const mug = tokenColor("--color-world-wall");
  const coffee = tokenColor("--color-world-desk");

  // The desk's own frame: +z is where its occupant looks and +x is their left, so faces turned by π look back at them.
  return (
    <group matrix={frame} matrixAutoUpdate={false}>
      <mesh position={[0, SCREEN_Y, screenZ]} rotation={[0, Math.PI, 0]} onClick={onOpenTerminal}>
        <planeGeometry args={[SCREEN.width, SCREEN.height]} />
        <meshBasicMaterial map={terminal} toneMapped={false} />
      </mesh>
      <mesh position={[-0.24, SCREEN_Y + MONITOR.height / 2 - 0.05, screenZ - 0.002]} rotation={[0, Math.PI, -0.08]}>
        <planeGeometry args={[0.075, 0.075]} />
        <meshStandardMaterial map={note} roughness={0.9} />
      </mesh>
      {/* Name plate: a little tent of card facing you, readable from the chair. */}
      <mesh position={[0.46, surface + 0.035, 0.08]} rotation={[-0.35, Math.PI + 0.25, 0]} castShadow>
        <planeGeometry args={[0.2, 0.0625]} />
        <meshStandardMaterial map={plate} roughness={0.7} side={DoubleSide} />
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
  );
}
