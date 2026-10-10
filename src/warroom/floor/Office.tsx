import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import { CanvasTexture, Object3D, SRGBColorSpace, type HemisphereLight, type InstancedMesh, type Matrix4, type MeshStandardMaterial, type PointLight } from "three";
import { BUILDING, DESK, DESKS, FURNITURE, SCREEN_SIZE, WALL_SCREENS, WALLS, ZONES, seatOf, type Desk, type Furniture, type WallScreen, type Zone } from "./office.ts";
import { signTexture, tokenColor } from "./tokens.ts";

const WALL_THICKNESS = 0.18;

const FLOOR_TOKEN: Record<Zone["floor"], string> = {
  carpet: "--color-world-carpet",
  tile: "--color-world-tile",
  wood: "--color-world-wood",
  raised: "--color-world-raised",
};

type OfficeProps = {
  /** 0 = a normal day, 1 = everything is on fire. Drives lighting, flicker and alarms. */
  panic: number;
  reduceMotion: boolean;
};

/** The building: floors, walls, ceiling lights, desks and fittings, plus how the room feels under pressure. */
export function Office({ panic, reduceMotion }: OfficeProps) {
  const panicRef = useRef(panic);
  useLayoutEffect(() => {
    panicRef.current = panic;
  }, [panic]);
  return (
    <>
      <Lighting panic={panicRef} reduceMotion={reduceMotion} />
      <CorridorAlarms panic={panicRef} reduceMotion={reduceMotion} />
      {ZONES.map((zone) => (
        <mesh key={zone.name} position={[(zone.minX + zone.maxX) / 2, zone.floor === "raised" ? 0.002 : 0, (zone.minZ + zone.maxZ) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[zone.maxX - zone.minX, zone.maxZ - zone.minZ]} />
          <meshStandardMaterial color={tokenColor(FLOOR_TOKEN[zone.floor])} roughness={zone.floor === "tile" ? 0.45 : 0.95} />
        </mesh>
      ))}
      <RaisedFloorGrid />
      <Ceiling panic={panicRef} reduceMotion={reduceMotion} />
      {WALLS.map((wall, index) => (
        <WallSegment key={index} from={wall.from} to={wall.to} isGlass={wall.kind === "glass"} />
      ))}
      <Desks />
      {FURNITURE.map((item, index) => (
        <FurnitureModel key={index} item={item} />
      ))}
      <Sign text="Data centre" caption="infra · authorised staff" x={8} z={1.2} y={2.75} />
      <Sign text="Library" caption="discussions" x={10.75} z={4.3} y={2.75} />
      <Sign text="Data lab" caption="data & ML" x={18.25} z={4.3} y={2.75} />
      <Sign text="Device lab" caption="mobile" x={-19.25} z={1.2} y={2.75} />
      <Sign text="SOC" caption="security" x={-13.75} z={1.2} y={2.75} />
      <Sign text="Web studio" caption="frontend" x={-20.4} z={6} y={2.75} />
      <Sign text="Kitchen" caption="" x={14} z={1.4} y={2.75} />
      {WALL_SCREENS.map((screen) => (
        <ScreenModel key={screen.id} screen={screen} />
      ))}
    </>
  );
}

type PanicRef = { readonly current: number };

function Lighting({ panic, reduceMotion }: { panic: PanicRef; reduceMotion: boolean }) {
  const sky = tokenColor("--color-world-ceiling");
  const ground = tokenColor("--color-world-carpet");
  const hemisphere = useRef<HemisphereLight>(null);
  const alarmTint = tokenColor("--color-critical");
  useFrame(() => {
    const light = hemisphere.current;
    if (!light) return;
    // The room drains toward red as customers start failing.
    light.intensity = 1.1 * (1 - 0.45 * panic.current);
    light.color.copy(sky).lerp(alarmTint, reduceMotion ? panic.current * 0.15 : panic.current * 0.3);
  });
  return (
    <>
      <hemisphereLight ref={hemisphere} args={[sky, ground, 1.1]} />
      <directionalLight position={[6, 9, 20]} intensity={1.4} color={sky} />
      {/* Daylight through the dev floor's windows. */}
      <mesh position={[0, BUILDING.ceiling / 2, BUILDING.maxZ + 0.6]}>
        <planeGeometry args={[BUILDING.maxX - BUILDING.minX, BUILDING.ceiling]} />
        <meshBasicMaterial color={sky} toneMapped={false} />
      </mesh>
      {[-6, 6].map((x) => (
        <pointLight key={x} position={[x, 3.2, -7]} intensity={10} distance={14} decay={1.5} color={tokenColor("--color-ink-2")} />
      ))}
    </>
  );
}

/** Red emergency lights down the corridor, pulsing once the incident is serious. */
function CorridorAlarms({ panic, reduceMotion }: { panic: PanicRef; reduceMotion: boolean }) {
  const lights = useRef<(PointLight | null)[]>([]);
  const color = tokenColor("--color-critical");
  const spots = [-16, -6, 4, 14] as const;
  useFrame(({ clock }) => {
    const level = Math.max(0, (panic.current - 0.35) / 0.65);
    lights.current.forEach((light, index) => {
      if (!light) return;
      const pulse = reduceMotion ? 0.6 : 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5 + index * 1.3);
      light.intensity = level * 9 * pulse;
    });
  });
  return (
    <>
      {spots.map((x, index) => (
        <group key={x} position={[x, BUILDING.ceiling - 0.15, 2.75]}>
          <pointLight ref={(light) => void (lights.current[index] = light)} color={color} intensity={0} distance={9} decay={1.6} />
          <mesh>
            <boxGeometry args={[0.3, 0.08, 0.12]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.2} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>
  );
}

function Ceiling({ panic, reduceMotion }: { panic: PanicRef; reduceMotion: boolean }) {
  const ceiling = tokenColor("--color-world-ceiling");
  const panelMaterial = useRef<MeshStandardMaterial>(null);
  // Under real stress the panels flicker — brief, irregular dips, never strobing (no flashes above 3 Hz).
  const flicker = useRef({ until: 0, next: 0 });
  useFrame(({ clock }) => {
    const material = panelMaterial.current;
    if (!material) return;
    const now = clock.elapsedTime;
    const state = flicker.current;
    const isStressed = panic.current > 0.55 && !reduceMotion;
    if (isStressed && now > state.next) {
      state.until = now + 0.08 + Math.random() * 0.12;
      state.next = now + 0.6 + Math.random() * (3.5 - panic.current * 2.5);
    }
    material.emissiveIntensity = isStressed && now < state.until ? 0.35 : 1.4 * (1 - 0.35 * panic.current);
  });
  const panels = useMemo(() => {
    const spots: [number, number][] = [];
    for (let x = -19; x <= 20; x += 4.5) for (let z = -12; z <= 13; z += 4) spots.push([x, z]);
    return spots;
  }, []);
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new Object3D();
    panels.forEach(([x, z], index) => {
      dummy.position.set(x, BUILDING.ceiling - 0.01, z);
      dummy.rotation.set(Math.PI / 2, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [panels]);
  return (
    <>
      <mesh position={[0, BUILDING.ceiling, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BUILDING.maxX - BUILDING.minX, BUILDING.maxZ - BUILDING.minZ]} />
        <meshStandardMaterial color={ceiling} emissive={ceiling} emissiveIntensity={0.32} roughness={1} />
      </mesh>
      <instancedMesh ref={ref} args={[undefined, undefined, panels.length]}>
        <planeGeometry args={[1.2, 0.6]} />
        <meshStandardMaterial ref={panelMaterial} color={ceiling} emissive={ceiling} emissiveIntensity={1.4} toneMapped={false} />
      </instancedMesh>
    </>
  );
}

function RaisedFloorGrid() {
  const zone = ZONES.find((candidate) => candidate.floor === "raised");
  if (!zone) return null;
  const line = tokenColor("--color-rule");
  return (
    <gridHelper
      args={[zone.maxX - zone.minX, 36, line, line]}
      position={[(zone.minX + zone.maxX) / 2, 0.006, (zone.minZ + zone.maxZ) / 2]}
      scale={[1, 1, (zone.maxZ - zone.minZ) / (zone.maxX - zone.minX)]}
    />
  );
}

function WallSegment({ from, to, isGlass }: { from: readonly [number, number]; to: readonly [number, number]; isGlass: boolean }) {
  const [x1, z1] = from;
  const [x2, z2] = to;
  const length = Math.hypot(x2 - x1, z2 - z1);
  const isAlongX = Math.abs(z2 - z1) < Math.abs(x2 - x1);
  const centre: [number, number, number] = [(x1 + x2) / 2, BUILDING.ceiling / 2, (z1 + z2) / 2];
  const size: [number, number, number] = isAlongX ? [length, BUILDING.ceiling, WALL_THICKNESS] : [WALL_THICKNESS, BUILDING.ceiling, length];
  const mullions = isGlass ? Math.max(1, Math.round(length / 2.4)) : 0;

  return (
    <group>
      <mesh position={centre}>
        <boxGeometry args={size} />
        {isGlass ? (
          <meshStandardMaterial color={tokenColor("--color-world-glass")} transparent opacity={0.14} roughness={0.05} metalness={0.2} depthWrite={false} />
        ) : (
          <meshStandardMaterial color={tokenColor("--color-world-wall")} roughness={0.92} />
        )}
      </mesh>
      {Array.from({ length: mullions + 1 }, (_, index) => {
        const ratio = index / mullions;
        return (
          <mesh key={index} position={[x1 + (x2 - x1) * ratio, BUILDING.ceiling / 2, z1 + (z2 - z1) * ratio]}>
            <boxGeometry args={[0.06, BUILDING.ceiling, 0.06]} />
            <meshStandardMaterial color={tokenColor("--color-world-metal")} roughness={0.4} metalness={0.7} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Four instanced meshes draw every desk, monitor, keyboard and chair in the building. */
function Desks() {
  const screen = useMemo(() => codeTexture(), []);
  const parts = useMemo(() => {
    const place = (desk: Desk, dx: number, y: number, dz: number, rotationY = 0) => {
      const dummy = new Object3D();
      dummy.position.set(desk.x + dx, y, desk.z + dz);
      dummy.rotation.set(0, rotationY, 0);
      dummy.updateMatrix();
      return dummy.matrix.clone();
    };
    return {
      tops: DESKS.map((desk) => place(desk, 0, DESK.height, 0)),
      // Monitors stand on the shared middle edge; the lit screen faces each desk's occupant.
      monitors: DESKS.map((desk) => place(desk, 0, DESK.height + 0.3, desk.facing * (DESK.depth / 2 - 0.12), desk.facing === 1 ? Math.PI : 0)),
      screens: DESKS.map((desk) => place(desk, 0, DESK.height + 0.3, desk.facing * (DESK.depth / 2 - 0.12) - desk.facing * 0.017, desk.facing === 1 ? Math.PI : 0)),
      keyboards: DESKS.map((desk) => place(desk, 0, DESK.height + 0.015, -desk.facing * 0.12)),
      chairs: DESKS.map((desk) => {
        const seat = seatOf(desk);
        return place(desk, 0, 0.47, seat.z - desk.z);
      }),
    };
  }, []);

  return (
    <>
      <Instanced matrices={parts.tops} geometry={[DESK.width, 0.04, DESK.depth]} token="--color-world-desk" />
      <Instanced matrices={parts.keyboards} geometry={[0.44, 0.02, 0.14]} token="--color-world-metal" />
      <Instanced matrices={parts.chairs} geometry={[0.5, 0.08, 0.5]} token="--color-outfit-3" />
      <Instanced matrices={parts.monitors} geometry={[0.62, 0.38, 0.03]} token="--color-world-metal" />
      <Screens matrices={parts.screens} texture={screen} />
      <DeskLegs />
    </>
  );
}

function DeskLegs() {
  const matrices = useMemo(
    () =>
      DESKS.flatMap((desk) =>
        [-1, 1].map((side) => {
          const dummy = new Object3D();
          dummy.position.set(desk.x + side * (DESK.width / 2 - 0.05), DESK.height / 2, desk.z);
          dummy.updateMatrix();
          return dummy.matrix.clone();
        }),
      ),
    [],
  );
  return <Instanced matrices={matrices} geometry={[0.04, DESK.height, DESK.depth * 0.9]} token="--color-world-metal" />;
}

/** Lit monitor glass: a plane per desk, facing its occupant only. */
function Screens({ matrices, texture }: { matrices: readonly Matrix4[]; texture: CanvasTexture }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
  }, [matrices]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, matrices.length]}>
      <planeGeometry args={[0.58, 0.34]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </instancedMesh>
  );
}

function Instanced({ matrices, geometry, token }: { matrices: readonly Matrix4[]; geometry: [number, number, number]; token: string }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
  }, [matrices]);
  const color = tokenColor(token);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, matrices.length]}>
      <boxGeometry args={geometry} />
      <meshStandardMaterial color={color} roughness={0.7} metalness={token === "--color-world-metal" ? 0.6 : 0.05} />
    </instancedMesh>
  );
}

function FurnitureModel({ item }: { item: Furniture }) {
  const { footprint, height, kind } = item;
  const position: [number, number, number] = [footprint.x, height / 2, footprint.z];
  if (kind === "plant") {
    return (
      <group position={[footprint.x, 0, footprint.z]}>
        <mesh position={[0, 0.22, 0]}>
          <cylinderGeometry args={[0.2, 0.16, 0.44, 16]} />
          <meshStandardMaterial color={tokenColor("--color-world-desk")} roughness={0.8} />
        </mesh>
        <mesh position={[0, 0.85, 0]}>
          <icosahedronGeometry args={[0.38, 1]} />
          <meshStandardMaterial color={tokenColor("--color-world-leaf")} roughness={0.9} flatShading />
        </mesh>
      </group>
    );
  }
  const token =
    kind === "table" || kind === "counter" ? "--color-world-desk" : kind === "sofa" ? "--color-outfit-1" : "--color-world-metal";
  return (
    <mesh position={position}>
      <boxGeometry args={[footprint.width, height, footprint.depth]} />
      <meshStandardMaterial color={tokenColor(token)} roughness={kind === "fridge" || kind === "coffee" ? 0.3 : 0.75} metalness={kind === "fridge" || kind === "coffee" ? 0.6 : 0.05} />
    </mesh>
  );
}

/** A wall-mounted TV: bezel plus a lit panel showing the room's name. */
function ScreenModel({ screen }: { screen: WallScreen }) {
  const texture = useMemo(() => screenTexture(screen.title), [screen.title]);
  const [nx, nz] = screen.normal;
  const yaw = Math.atan2(nx, nz);
  return (
    <group position={[screen.x, SCREEN_SIZE.y, screen.z]} rotation={[0, yaw, 0]}>
      <mesh>
        <boxGeometry args={[SCREEN_SIZE.width + 0.08, SCREEN_SIZE.height + 0.08, 0.06]} />
        <meshStandardMaterial color={tokenColor("--color-world-metal")} roughness={0.35} metalness={0.7} />
      </mesh>
      <mesh position={[0, 0, 0.032]}>
        <planeGeometry args={[SCREEN_SIZE.width, SCREEN_SIZE.height]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

function screenTexture(title: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 704;
  canvas.height = 400;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  context.fillStyle = token("--color-terminal");
  context.fillRect(0, 0, 704, 400);
  context.fillStyle = token("--color-accent");
  context.font = `600 26px ${token("--font-mono")}`;
  context.fillText("sev1 ·", 40, 64);
  context.fillStyle = token("--color-ink");
  context.font = `800 64px ${token("--font-display")}`;
  context.fillText(title.split(" · ")[0], 40, 170);
  context.fillStyle = token("--color-muted");
  context.font = `400 26px ${token("--font-mono")}`;
  context.fillText(title.includes(" · ") ? title.split(" · ")[1] : "problems on this screen", 40, 220);
  context.fillStyle = token("--color-ink-2");
  context.fillText("walk up · press E to discuss", 40, 340);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function Sign({ text, caption, x, y, z }: { text: string; caption: string; x: number; y: number; z: number }) {
  const texture = useMemo(() => signTexture(text, caption, null), [text, caption]);
  const aspect = texture.image.width / texture.image.height;
  return (
    <sprite position={[x, y, z]} scale={[0.5 * aspect, 0.5, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

/** An editor full of code, drawn once and shared by every monitor in the building. */
function codeTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  context.fillStyle = token("--color-terminal");
  context.fillRect(0, 0, 256, 160);
  const palette = [token("--color-ink-2"), token("--color-accent"), token("--color-good"), token("--color-muted")];
  let seed = 7;
  const next = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let line = 0; line < 14; line += 1) {
    let x = 10 + Math.floor(next() * 4) * 12;
    for (let word = 0; word < 1 + Math.floor(next() * 5); word += 1) {
      const width = 12 + next() * 46;
      context.fillStyle = palette[Math.floor(next() * palette.length)];
      context.fillRect(x, 8 + line * 10.5, width, 4);
      x += width + 6;
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
