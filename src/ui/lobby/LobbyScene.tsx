import { ContactShadows } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useCallback, useMemo, useRef, type PointerEvent, type ReactNode } from "react";
import { AgXToneMapping, type Group } from "three";
import { Avatar } from "../../warroom/floor/people/Avatar.tsx";
import type { AvatarId } from "../../warroom/floor/assets/catalog.ts";
import type { Motion } from "../../warroom/floor/people/behaviour.ts";
import type { Pose } from "../../domain/look.ts";
import { tokenColor } from "../../warroom/floor/tokens.ts";

/** How far left you step when a panel opens beside you, in metres, and how quickly. */
const ASIDE_X = -0.95;
const SLIDE = 4;
/** Radians per pixel of drag, and how fast the body drifts back to facing you once let go. */
const TURN_PER_PIXEL = 0.012;
const SETTLE = 1.6;

/**
 * The lobby's stage: you, standing in front of the data centre, turnable by dragging. Lazy-loaded
 * so the menus are usable before three.js arrives; the backdrop image fills in meanwhile.
 */
type Props = {
  avatar: AvatarId;
  pose: Pose;
  /** A panel is open on the right: stand aside so you're still in view. */
  isAside: boolean;
  reduceMotion: boolean;
};

export default function LobbyScene({ avatar, pose, isAside, reduceMotion }: Props) {
  const motion = useMemo<Motion>(() => ({ clip: pose, speed: 0 }), [pose]);
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
        <Turntable angleAfter={angleAfter} x={isAside ? ASIDE_X : 0} reduceMotion={reduceMotion}>
          <Suspense fallback={null}>
            <Avatar key={avatar} id={avatar} motion={() => motion} />
          </Suspense>
          <Platform />
          <ContactShadows position={[0, 0.005, 0]} opacity={0.6} scale={4} blur={2.4} far={2} />
        </Turntable>
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

/** Turns its children to the angle the scene reports each frame, and eases them to `x`. */
function Turntable({ angleAfter, x, reduceMotion, children }: { angleAfter: (delta: number) => number; x: number; reduceMotion: boolean; children: ReactNode }) {
  const group = useRef<Group>(null);
  useFrame((_, delta) => {
    const body = group.current;
    if (!body) return;
    body.rotation.y = angleAfter(delta);
    body.position.x = reduceMotion ? x : body.position.x + (x - body.position.x) * Math.min(1, delta * SLIDE);
  });
  return <group ref={group}>{children}</group>;
}
