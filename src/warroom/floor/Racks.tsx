import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, EdgesGeometry, type Group, type MeshStandardMaterial } from "three";
import type { Health } from "../health.ts";
import type { Rack } from "./layout.ts";
import { HEALTH_TOKEN, signTexture, tokenColor } from "./tokens.ts";

const LED_COUNT = 10;

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

  const bodyColor = tokenColor(kind === "idle" ? "--color-paper-2" : "--color-paper-3");
  const trimColor = tokenColor(isSelected ? "--color-focus" : isFocused ? "--color-ink-2" : "--color-rule");
  const lit = kind === "idle" ? 3 : Math.max(1, Math.round(load * LED_COUNT));

  return (
    <group position={[footprint.x, 0, footprint.z]} rotation={[0, rack.front === 1 ? 0 : Math.PI, 0]} onClick={(event) => onActivate(rack, event)}>
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[footprint.width, height, footprint.depth]} />
        <meshStandardMaterial color={bodyColor} roughness={0.75} metalness={0.35} />
      </mesh>
      <mesh position={[0, height / 2, footprint.depth / 2 + 0.002]}>
        <planeGeometry args={[footprint.width * 0.92, height * 0.94]} />
        <meshStandardMaterial color={trimColor} roughness={0.9} metalness={0.1} transparent opacity={isFocused || isSelected ? 0.55 : 0.25} />
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
