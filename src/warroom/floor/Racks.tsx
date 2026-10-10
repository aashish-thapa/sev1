import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, CanvasTexture, EdgesGeometry, RepeatWrapping, SRGBColorSpace, type Group, type MeshStandardMaterial } from "three";
import type { Health } from "../health.ts";
import type { Rack } from "./layout.ts";
import { HEALTH_TOKEN, signTexture, tokenColor } from "./tokens.ts";

const LED_COUNT = 10;
/** Perforation pitch of a server-rack door, metres; the texture holds a 2 × 2 cell of holes. */
const PERFORATION_PITCH = 0.025;

type RackProps = {
  rack: Rack;
  /** 0..1 — how full this rack's meter is (connection pool, DB connections). */
  load: number;
  isFocused: boolean;
  isSelected: boolean;
  reduceMotion: boolean;
  onActivate: (rack: Rack, event: ThreeEvent<MouseEvent>) => void;
};

export function RackModel({ rack, load, isFocused, isSelected, reduceMotion, onActivate }: RackProps) {
  const { footprint, height, kind } = rack;
  if (kind === "external") return <ExternalCage rack={rack} isFocused={isFocused} onActivate={onActivate} />;

  const bodyColor = tokenColor("--color-world-rack");
  const highlight = isSelected ? tokenColor("--color-focus") : isFocused ? tokenColor("--color-ink-2") : null;
  const lit = kind === "idle" ? 3 : Math.max(1, Math.round(load * LED_COUNT));
  const door = { width: footprint.width * 0.94, height: height * 0.95 };

  return (
    <group position={[footprint.x, 0, footprint.z]} rotation={[0, rack.front === 1 ? 0 : Math.PI, 0]} onClick={(event) => onActivate(rack, event)}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[footprint.width, height, footprint.depth]} />
        <meshStandardMaterial color={bodyColor} roughness={0.55} metalness={0.5} />
      </mesh>
      <mesh position={[0, height / 2, footprint.depth / 2 + 0.003]}>
        <planeGeometry args={[door.width, door.height]} />
        <meshStandardMaterial
          color={tokenColor("--color-world-metal")}
          map={perforation(door.width, door.height)}
          roughness={0.62}
          metalness={0.15}
          emissive={highlight ?? bodyColor}
          emissiveIntensity={highlight ? 0.35 : 0}
        />
      </mesh>
      <mesh position={[-footprint.width * 0.38, height * 0.55, footprint.depth / 2 + 0.02]}>
        <boxGeometry args={[0.02, 0.32, 0.03]} />
        <meshStandardMaterial color={tokenColor("--color-world-aluminium")} roughness={0.3} metalness={1} />
      </mesh>
      {Array.from({ length: LED_COUNT }, (_, index) => (
        <Led
          key={index}
          position={[footprint.width * 0.3, 0.25 + index * ((height - 0.5) / LED_COUNT), footprint.depth / 2 + 0.01]}
          health={index < lit ? rack.health : null}
          phase={index}
          isBlinking={!reduceMotion && (rack.health === "critical" || rack.health === "pending")}
        />
      ))}
      {rack.label && <Sign title={rack.label} caption={rack.caption} health={rack.health} height={height} />}
    </group>
  );
}

function Led({ position, health, phase, isBlinking }: { position: [number, number, number]; health: Health | null; phase: number; isBlinking: boolean }) {
  const material = useRef<MeshStandardMaterial>(null);
  const color = health ? tokenColor(HEALTH_TOKEN[health]) : tokenColor("--color-rule-2");

  useFrame(({ clock }) => {
    if (!material.current) return;
    const base = health ? 1.6 : 0;
    material.current.emissiveIntensity = isBlinking ? base * (0.35 + 0.65 * Math.max(0, Math.sin(clock.elapsedTime * 6 + phase * 0.6))) : base;
  });

  return (
    <mesh position={position}>
      <boxGeometry args={[0.16, 0.05, 0.02]} />
      <meshStandardMaterial ref={material} color={color} emissive={color} emissiveIntensity={health ? 1.6 : 0} toneMapped={false} />
    </mesh>
  );
}

function Sign({ title, caption, health, height }: { title: string; caption: string; health: Health; height: number }) {
  const texture = useMemo(() => signTexture(title, caption, health), [title, caption, health]);
  useEffect(() => () => texture.dispose(), [texture]);
  const aspect = texture.image.width / texture.image.height;
  return (
    <sprite position={[0, height + 0.35, 0]} scale={[0.42 * aspect, 0.42, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

function ExternalCage({ rack, isFocused, onActivate }: { rack: Rack; isFocused: boolean; onActivate: RackProps["onActivate"] }) {
  const { footprint, height } = rack;
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(footprint.width, height, footprint.depth)), [footprint.width, footprint.depth, height]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <group position={[footprint.x, 0, footprint.z]} onClick={(event) => onActivate(rack, event)}>
      <lineSegments position={[0, height / 2, 0]} geometry={edges}>
        <lineBasicMaterial color={tokenColor(isFocused ? "--color-ink" : "--color-rule-strong")} />
      </lineSegments>
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[footprint.width, height, footprint.depth]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Sign title={rack.label} caption={rack.caption} health={rack.health} height={height} />
    </group>
  );
}

/** A rotating alarm light over the hall while customers are failing. */
export function Beacon({ health, reduceMotion, x, z }: { health: Health; reduceMotion: boolean; x: number; z: number }) {
  const group = useRef<Group>(null);
  const isAlarm = health === "critical" || health === "warn";
  const color = tokenColor(health === "critical" ? "--color-critical" : "--color-accent");
  useFrame((_, delta) => {
    if (group.current && isAlarm && !reduceMotion) group.current.rotation.y += delta * 3;
  });
  if (!isAlarm) return null;
  return (
    <group ref={group} position={[x, 3.45, z]}>
      <pointLight color={color} intensity={18} distance={16} decay={1.6} position={[0.6, -0.2, 0]} />
      <mesh>
        <cylinderGeometry args={[0.12, 0.16, 0.2, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} toneMapped={false} />
      </mesh>
    </group>
  );
}

const perforations = new Map<string, CanvasTexture>();

/** A perforated steel door: bright metal with dark holes on a staggered grid, tiled at real pitch. Cached per door size. */
function perforation(width: number, height: number): CanvasTexture {
  const key = `${width.toFixed(2)}x${height.toFixed(2)}`;
  const cached = perforations.get(key);
  if (cached) return cached;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const styles = getComputedStyle(document.documentElement);
  context.fillStyle = styles.getPropertyValue("--color-world-aluminium").trim();
  context.fillRect(0, 0, size, size);
  context.fillStyle = styles.getPropertyValue("--color-terminal").trim();
  for (const [x, y] of [[0.25, 0.25], [0.75, 0.25], [0, 0.75], [0.5, 0.75], [1, 0.75]] as const) {
    context.beginPath();
    context.arc(x * size, y * size, size * 0.16, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  texture.repeat.set(width / (PERFORATION_PITCH * 2), height / (PERFORATION_PITCH * 2));
  perforations.set(key, texture);
  return texture;
}
