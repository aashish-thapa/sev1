import { useEffect, useMemo } from "react";
import type { ServerTierId } from "../../../domain/company/catalog.ts";
import type { Footprint } from "../layout.ts";
import { BUILDING, DATACENTRE_FRONT } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { useOfficePlan } from "./context.ts";
import { boardTexture } from "./board-texture.ts";
import type { BoardFigures, OfficeRack } from "./plan.ts";

const RACK_HEIGHT = 2.1;
const POST = 0.04;
/** How tall each server tier sits in its rack: about 1U, 2U and 4U, so a bigger buy reads at a glance. */
const UNIT_HEIGHT: Readonly<Record<ServerTierId, number>> = { small: 0.09, medium: 0.18, large: 0.36 };
const UNIT_Y = 1.05;

/**
 * What a company owns that the shared office doesn't: its racks, a data centre shut until it buys a server room,
 * and by the first bay its board (`board`, when the company's figures are known) and the punch clock.
 */
export function CompanyFixtures({ board }: { board: BoardFigures | null }) {
  const plan = useOfficePlan();
  if (plan.hasColleagues) return null;
  return (
    <>
      {plan.racks.map((rack) => (
        <OpenRack key={rack.key} rack={rack} />
      ))}
      {!plan.isDataCentreOpen && <ShutDataCentre />}
      {plan.fixtures && board && <Board footprint={plan.fixtures.board} figures={board} />}
      {plan.fixtures && <PunchClock footprint={plan.fixtures.punchClock} />}
    </>
  );
}

const BOARD = { width: 1.6, height: 0.9, centreY: 1.85, bezel: 0.05 } as const;

/** A screen on the wall facing the bay: the company at a glance, redrawn whenever its books are refetched. */
function Board({ footprint, figures }: { footprint: Footprint; figures: BoardFigures }) {
  const texture = useMemo(() => boardTexture(figures), [figures]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <group position={[footprint.x, 0, footprint.z]}>
      <mesh position={[0, BOARD.centreY, 0]} castShadow>
        <boxGeometry args={[BOARD.width + BOARD.bezel * 2, BOARD.height + BOARD.bezel * 2, 0.05]} />
        <meshStandardMaterial color={tokenColor("--color-world-plastic")} roughness={0.4} />
      </mesh>
      <mesh position={[0, BOARD.centreY, 0.027]}>
        <planeGeometry args={[BOARD.width, BOARD.height]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** A time clock on a post: a dial and a card slot, nothing written on it. Press E at it to clock out. */
function PunchClock({ footprint }: { footprint: Footprint }) {
  const body = tokenColor("--color-world-aluminium");
  return (
    <group position={[footprint.x, 0, footprint.z]}>
      <mesh position={[0, 0.55, 0]} castShadow>
        <cylinderGeometry args={[0.03, 0.03, 1.1, 12]} />
        <meshStandardMaterial color={tokenColor("--color-world-metal")} roughness={0.4} metalness={0.7} />
      </mesh>
      <mesh position={[0, 0.015, 0]} receiveShadow>
        <cylinderGeometry args={[0.16, 0.16, 0.03, 20]} />
        <meshStandardMaterial color={tokenColor("--color-world-metal")} roughness={0.4} metalness={0.7} />
      </mesh>
      <mesh position={[0, 1.28, 0]} castShadow>
        <boxGeometry args={[0.3, 0.38, 0.16]} />
        <meshStandardMaterial color={body} roughness={0.35} metalness={0.5} />
      </mesh>
      <mesh position={[0, 1.34, 0.081]}>
        <circleGeometry args={[0.1, 32]} />
        <meshStandardMaterial color={tokenColor("--color-paper")} roughness={0.6} />
      </mesh>
      <mesh position={[0, 1.34, 0.083]} rotation={[0, 0, -0.9]}>
        <planeGeometry args={[0.008, 0.08]} />
        <meshBasicMaterial color={tokenColor("--color-ink")} />
      </mesh>
      {/* The card slot, lit red: the one thing to do here. */}
      <mesh position={[0, 1.165, 0.081]}>
        <planeGeometry args={[0.16, 0.018]} />
        <meshStandardMaterial color={tokenColor("--color-critical")} emissive={tokenColor("--color-critical")} emissiveIntensity={0.8} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** An open-frame rack: four posts, and the server you bought glowing in it, or nothing yet. */
function OpenRack({ rack }: { rack: OfficeRack }) {
  const { footprint, server } = rack;
  const frame = tokenColor("--color-world-rack");
  const front = footprint.depth / 2;
  return (
    <group position={[footprint.x, 0, footprint.z]} rotation={[0, rack.front === 1 ? 0 : Math.PI, 0]}>
      {[-1, 1].flatMap((side) =>
        [-1, 1].map((end) => (
          <mesh key={`${side}${end}`} position={[side * (footprint.width / 2 - POST / 2), RACK_HEIGHT / 2, end * (front - POST / 2)]} castShadow>
            <boxGeometry args={[POST, RACK_HEIGHT, POST]} />
            <meshStandardMaterial color={frame} roughness={0.5} metalness={0.6} />
          </mesh>
        )),
      )}
      <mesh position={[0, RACK_HEIGHT - POST / 2, 0]}>
        <boxGeometry args={[footprint.width, POST, footprint.depth]} />
        <meshStandardMaterial color={frame} roughness={0.5} metalness={0.6} />
      </mesh>
      {server && <ServerUnit width={footprint.width - POST * 2} depth={footprint.depth - POST * 2} height={UNIT_HEIGHT[server]} front={front} />}
    </group>
  );
}

function ServerUnit({ width, depth, height, front }: { width: number; depth: number; height: number; front: number }) {
  return (
    <group position={[0, UNIT_Y + height / 2, 0]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color={tokenColor("--color-world-metal")} roughness={0.4} metalness={0.7} />
      </mesh>
      {/* The front's status strip: green and steady, the server humming along. */}
      <mesh position={[width * 0.3, 0, front - 0.035]}>
        <planeGeometry args={[width * 0.25, Math.min(0.02, height * 0.3)]} />
        <meshStandardMaterial color={tokenColor("--color-good")} emissive={tokenColor("--color-good")} emissiveIntensity={1.4} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Dark glass over the data centre's front and its door: the hall is there, just not the company's yet. */
function ShutDataCentre() {
  const width = DATACENTRE_FRONT.toX - DATACENTRE_FRONT.fromX;
  return (
    <mesh position={[(DATACENTRE_FRONT.fromX + DATACENTRE_FRONT.toX) / 2, BUILDING.ceiling / 2, DATACENTRE_FRONT.z - 0.12]}>
      <planeGeometry args={[width, BUILDING.ceiling]} />
      <meshStandardMaterial color={tokenColor("--color-world-plastic")} transparent opacity={0.7} roughness={0.15} metalness={0.2} depthWrite={false} />
    </mesh>
  );
}
