import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, type Ref } from "react";
import { Object3D, type InstancedMesh, type Material, type MeshStandardMaterial } from "three";
import { BUILDING, WALLS, ZONES, type Wall } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { FINISHES, FLOOR_FINISH, type FinishMaterials, type FinishName } from "./finishes.ts";
import type { PanicRef } from "./Lighting.tsx";
import { worldBox, worldPlane } from "./worldUv.ts";

const WALL_THICKNESS = 0.18;
const SKIRTING = { height: 0.09, proud: 0.012 } as const;
/** Mineral-fibre ceiling grid: 600 mm tiles in a 24 mm T-bar grid. */
const CEILING_TILE = 0.6;
const T_BAR = 0.024;
/** Recessed 1200 × 600 troffers, spaced on the tile grid so their edges land on T-bars. */
const TROFFER_SPACING = { x: CEILING_TILE * 8, z: CEILING_TILE * 7 } as const;

type ShellProps = {
  materials: FinishMaterials;
  panic: PanicRef;
  reduceMotion: boolean;
};

/** The building itself: floors per zone, walls, glazing, and the lit suspended ceiling. */
export function Shell({ materials, panic, reduceMotion }: ShellProps) {
  return (
    <>
      {ZONES.map((zone) => {
        const finish = FLOOR_FINISH[zone.floor];
        const width = zone.maxX - zone.minX;
        const depth = zone.maxZ - zone.minZ;
        return (
          <FloorPatch key={zone.name} finish={finish} material={materials[finish]} width={width} depth={depth} x={(zone.minX + zone.maxX) / 2} z={(zone.minZ + zone.maxZ) / 2} lift={zone.floor === "raised" ? 0.002 : 0} />
        );
      })}
      {WALLS.map((wall, index) =>
        wall.kind === "glass" ? <GlassWall key={index} wall={wall} /> : <SolidWall key={index} wall={wall} material={materials.plaster} />,
      )}
      <Ceiling material={materials.ceiling} panic={panic} reduceMotion={reduceMotion} />
    </>
  );
}

function FloorPatch({ finish, material, width, depth, x, z, lift }: { finish: FinishName; material: Material; width: number; depth: number; x: number; z: number; lift: number }) {
  const geometry = useMemo(() => worldPlane(width, depth, FINISHES[finish].tileMetres), [finish, width, depth]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} material={material} position={[x, lift, z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow />;
}

function wallFrame({ from: [x1, z1], to: [x2, z2] }: Wall) {
  const length = Math.hypot(x2 - x1, z2 - z1);
  const isAlongX = Math.abs(z2 - z1) < Math.abs(x2 - x1);
  return { length, isAlongX, centre: [(x1 + x2) / 2, (z1 + z2) / 2] as const };
}

function SolidWall({ wall, material }: { wall: Wall; material: Material }) {
  const { length, isAlongX, centre } = wallFrame(wall);
  const [width, depth] = isAlongX ? [length, WALL_THICKNESS] : [WALL_THICKNESS, length];
  const geometry = useMemo(() => worldBox(width, BUILDING.ceiling, depth, FINISHES.plaster.tileMetres), [width, depth]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const proud = SKIRTING.proud * 2;
  return (
    <group position={[centre[0], 0, centre[1]]}>
      <mesh geometry={geometry} material={material} position={[0, BUILDING.ceiling / 2, 0]} castShadow receiveShadow />
      <mesh position={[0, SKIRTING.height / 2, 0]}>
        <boxGeometry args={[width + (isAlongX ? 0 : proud), SKIRTING.height, depth + (isAlongX ? proud : 0)]} />
        <meshStandardMaterial color={tokenColor("--color-world-plastic")} roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Frameless glazing with aluminium mullions and a frosted manifestation band at eye level, as fire codes require. */
function GlassWall({ wall }: { wall: Wall }) {
  const { length, isAlongX, centre } = wallFrame(wall);
  const [x1, z1] = wall.from;
  const [x2, z2] = wall.to;
  const size = (height: number, thickness: number): [number, number, number] => (isAlongX ? [length, height, thickness] : [thickness, height, length]);
  const mullions = Math.max(1, Math.round(length / 2.4));
  return (
    <group>
      <mesh position={[centre[0], BUILDING.ceiling / 2, centre[1]]}>
        <boxGeometry args={size(BUILDING.ceiling, 0.02)} />
        <meshStandardMaterial color={tokenColor("--color-world-glass")} transparent opacity={0.1} roughness={0.02} metalness={0} envMapIntensity={1.2} depthWrite={false} />
      </mesh>
      <mesh position={[centre[0], 1.25, centre[1]]}>
        <boxGeometry args={size(0.22, 0.024)} />
        <meshStandardMaterial color={tokenColor("--color-world-ceiling")} transparent opacity={0.42} roughness={0.9} depthWrite={false} />
      </mesh>
      {Array.from({ length: mullions + 1 }, (_, index) => {
        const ratio = index / mullions;
        return (
          <mesh key={index} position={[x1 + (x2 - x1) * ratio, BUILDING.ceiling / 2, z1 + (z2 - z1) * ratio]} castShadow>
            <boxGeometry args={[0.05, BUILDING.ceiling, 0.05]} />
            <meshStandardMaterial color={tokenColor("--color-world-aluminium")} roughness={0.35} metalness={1} />
          </mesh>
        );
      })}
      {[0.03, BUILDING.ceiling - 0.03].map((y) => (
        <mesh key={y} position={[centre[0], y, centre[1]]}>
          <boxGeometry args={size(0.06, 0.06)} />
          <meshStandardMaterial color={tokenColor("--color-world-aluminium")} roughness={0.35} metalness={1} />
        </mesh>
      ))}
    </group>
  );
}

function troffers(): [number, number][] {
  const spots: [number, number][] = [];
  for (let x = -19.2; x <= BUILDING.maxX - 1; x += TROFFER_SPACING.x) {
    for (let z = -12.3; z <= BUILDING.maxZ - 1; z += TROFFER_SPACING.z) spots.push([x, z]);
  }
  return spots;
}

function Ceiling({ material, panic, reduceMotion }: { material: Material; panic: PanicRef; reduceMotion: boolean }) {
  const panelMaterial = useRef<MeshStandardMaterial>(null);
  // Under real stress the panels flicker — brief, irregular dips, never strobing (no flashes above 3 Hz).
  const flicker = useRef({ until: 0, next: 0 });
  useFrame(({ clock }) => {
    const panel = panelMaterial.current;
    if (!panel) return;
    const now = clock.elapsedTime;
    const state = flicker.current;
    const isStressed = panic.current > 0.55 && !reduceMotion;
    if (isStressed && now > state.next) {
      state.until = now + 0.08 + Math.random() * 0.12;
      state.next = now + 0.6 + Math.random() * (3.5 - panic.current * 2.5);
    }
    panel.emissiveIntensity = isStressed && now < state.until ? 0.25 : 1.6 * (1 - 0.35 * panic.current);
  });

  const width = BUILDING.maxX - BUILDING.minX;
  const depth = BUILDING.maxZ - BUILDING.minZ;
  const plane = useMemo(() => worldPlane(width, depth, FINISHES.ceiling.tileMetres), [width, depth]);
  useLayoutEffect(() => () => plane.dispose(), [plane]);
  const panels = useMemo(() => troffers(), []);
  const grid = useMemo(() => {
    const along = (from: number, to: number) => Array.from({ length: Math.round((to - from) / CEILING_TILE) + 1 }, (_, index) => from + index * CEILING_TILE);
    return { xs: along(BUILDING.minX, BUILDING.maxX), zs: along(BUILDING.minZ, BUILDING.maxZ) };
  }, []);
  const light = tokenColor("--color-world-ceiling");
  const bars = tokenColor("--color-world-aluminium");

  return (
    <>
      <mesh geometry={plane} material={material} position={[0, BUILDING.ceiling, 0]} rotation={[Math.PI / 2, 0, 0]} />
      <InstancedStrips positions={grid.xs.map((x) => [x, 0] as const)} size={[T_BAR, 0.012, depth]} color={bars} />
      <InstancedStrips positions={grid.zs.map((z) => [0, z] as const)} size={[width, 0.012, T_BAR]} color={bars} />
      <InstancedStrips positions={panels} size={[CEILING_TILE * 2 - T_BAR, 0.01, CEILING_TILE - T_BAR]} color={light} materialRef={panelMaterial} isLit drop={0.014} />
    </>
  );
}

type StripsProps = {
  positions: readonly (readonly [number, number])[];
  size: [number, number, number];
  color: ReturnType<typeof tokenColor>;
  materialRef?: Ref<MeshStandardMaterial>;
  isLit?: boolean;
  /** How far below the ceiling the strip hangs; troffers sit just under the grid that frames them. */
  drop?: number;
};

function InstancedStrips({ positions, size, color, materialRef, isLit = false, drop = 0.002 }: StripsProps) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new Object3D();
    positions.forEach(([x, z], index) => {
      dummy.position.set(x, BUILDING.ceiling - size[1] / 2 - drop, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [positions, size, drop]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, positions.length]}>
      <boxGeometry args={size} />
      {isLit ? (
        <meshStandardMaterial ref={materialRef} color={color} emissive={color} emissiveIntensity={1.6} toneMapped={false} />
      ) : (
        <meshStandardMaterial ref={materialRef} color={color} roughness={0.5} metalness={0.6} />
      )}
    </instancedMesh>
  );
}
