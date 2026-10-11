import { ContactShadows } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useCallback, useMemo, useRef, type PointerEvent, type ReactNode } from "react";
import { AgXToneMapping, type Group } from "three";
import { Avatar } from "../../warroom/floor/people/Avatar.tsx";
import { avatarFor } from "../../warroom/floor/people/avatars.ts";
import type { Motion } from "../../warroom/floor/people/behaviour.ts";
import { tokenColor } from "../../warroom/floor/tokens.ts";

const IDLE: Motion = { clip: "idle", speed: 0 };
/** Radians per pixel of drag, and how fast the body drifts back to facing you once let go. */
const TURN_PER_PIXEL = 0.012;
const SETTLE = 1.6;

/**
 * The lobby's stage: you, standing in front of the data centre, turnable by dragging. Lazy-loaded
 * so the menus are usable before three.js arrives; the backdrop image fills in meanwhile.
 */
export default function LobbyScene({ seed, reduceMotion }: { seed: string; reduceMotion: boolean }) {
  const turn = useRef({ angle: 0, isDragging: false, lastX: 0 });
  const gl = useMemo(() => ({ antialias: true, alpha: true, toneMapping: AgXToneMapping }), []);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    turn.current.isDragging = true;
    turn.current.lastX = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!turn.current.isDragging) return;
    turn.current.angle += (event.clientX - turn.current.lastX) * TURN_PER_PIXEL;
    turn.current.lastX = event.clientX;
  };
  const up = () => {
    turn.current.isDragging = false;
  };
  // Let go and you turn back to face the camera, unless motion is reduced (then you stay put).
  const angleAfter = useCallback(
    (delta: number) => {
      const state = turn.current;
      if (!state.isDragging && !reduceMotion) state.angle -= state.angle * Math.min(1, delta * SETTLE);
      return state.angle;
    },
    [reduceMotion],
  );

  return (
    <div className="lobby-scene" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <Canvas dpr={[1, 2]} gl={gl} camera={{ fov: 30, position: [0, 1.05, 4.6] }} onCreated={({ camera }) => camera.lookAt(0, 0.92, 0)}>
        <Lights />
        <Suspense fallback={null}>
          <Turntable angleAfter={angleAfter}>
            <Avatar id={avatarFor(seed)} motion={() => IDLE} />
          </Turntable>
        </Suspense>
        <Platform />
        <ContactShadows position={[0, 0.005, 0]} opacity={0.6} scale={4} blur={2.4} far={2} />
      </Canvas>
    </div>
  );
}

function Lights() {
  const accent = useMemo(() => tokenColor("--color-accent"), []);
  const ink = useMemo(() => tokenColor("--color-ink"), []);
  return (
    <>
      <hemisphereLight args={[ink, tokenColor("--color-paper"), 0.55]} />
      <directionalLight position={[2.5, 4, 3.5]} intensity={1.6} color={ink} />
      {/* The rim from the data centre behind: warm, from back left, so the silhouette reads against the dark. */}
      <pointLight position={[-1.6, 1.9, -1.6]} intensity={14} distance={6} color={accent} />
    </>
  );
}

/** A low disc to stand on, catching a little of the warm rim. */
function Platform() {
  const paper = useMemo(() => tokenColor("--color-paper-2"), []);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0]}>
      <circleGeometry args={[1.15, 64]} />
      <meshStandardMaterial color={paper} roughness={0.85} metalness={0.1} />
    </mesh>
  );
}

/** Turns its children to the angle the scene reports each frame. */
function Turntable({ angleAfter, children }: { angleAfter: (delta: number) => number; children: ReactNode }) {
  const group = useRef<Group>(null);
  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y = angleAfter(delta);
  });
  return <group ref={group}>{children}</group>;
}
