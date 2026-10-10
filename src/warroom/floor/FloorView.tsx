import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { edgeHealth, sameNode, type NodeId } from "../health.ts";
import type { CommsMessage, Scenario } from "../scenario.ts";
import { openConnections } from "../sim/engine.ts";
import type { ClusterState } from "../sim/model.ts";
import { AgXToneMapping, NoToneMapping } from "three";
import { Effects } from "./environment/Effects.tsx";
import { pinnedQuality, QUALITY, readDeviceHints, startingQuality, type Quality } from "./environment/quality.ts";
import { Laptop } from "./Laptop.tsx";
import { layoutHall, obstaclesOf, rowSigns, type Rack } from "./layout.ts";
import { Office } from "./Office.tsx";
import type { Role } from "../../domain/incident.ts";
import { BUILDING, DATACENTRE_ORIGIN, officeObstacles, screenFootprint, spawnFor, WALL_SCREENS, type WallScreen } from "./office.ts";
import type { Footprint } from "./layout.ts";
import { whereabouts, type Whereabouts } from "./whereabouts.ts";

type Usable = {
  readonly key: string;
  readonly footprint: Footprint;
  readonly verb: string;
  readonly label: string;
  readonly target: { readonly kind: "rack"; readonly rack: Rack } | { readonly kind: "screen"; readonly screen: WallScreen };
};
import { People, Teammates } from "./People.tsx";
import type { Teammate } from "../ui/feed.ts";
import { facing, walk, type Intent, type Player } from "./player.ts";
import { Beacon, RackModel } from "./Racks.tsx";
import { signTexture } from "./tokens.ts";

type Props = {
  cluster: ClusterState;
  scenario: Scenario;
  /** Your role: you start the day in its room. */
  role: Role;
  selected: NodeId | null;
  comms: readonly CommsMessage[];
  isLaptopOpen: boolean;
  /** Something else (a discussion) has the screen; walking pauses. */
  isOverlayOpen: boolean;
  /** 0..1 — how close to chaos the office should feel. */
  panic: number;
  /** DOM element the laptop's screen rectangle is written to each frame. */
  laptopScreenRef: RefObject<HTMLDivElement | null>;
  onInspect: (node: NodeId) => void;
  /** Player pressed E at a wall screen. */
  onUseScreen: (screen: WallScreen) => void;
  onToggleLaptop: () => void;
  /** Fired when the player's zone or nearness to the racks changes — drives the soundscape. */
  onWhereabouts?: (where: Whereabouts) => void;
  /** Fired once per stride while walking. */
  onStep?: (surface: Whereabouts["surface"]) => void;
  /** Other players in a shared room. */
  teammates?: readonly Teammate[];
  /** Your own position, for teammates to see (the room client throttles it). */
  onPresence?: (position: { x: number; z: number; yaw: number }) => void;
};

const STRIDE_METRES = 0.72;

const STILL: Intent = { forward: 0, strafe: 0, yawDelta: 0, pitchDelta: 0 };

const EYE_HEIGHT = 1.62;
const LOOK_SPEED = 0.0045;
const CLICK_REACH = 4.5;
const DRAG_SLOP = 6;
function startFor(role: Role): Player {
  const spot = spawnFor(role);
  return devSpawnOverride() ?? { x: spot.x, z: spot.z, yaw: spot.yaw, pitch: -0.05 };
}

/** Development only: `?at=<screen id>` or `?at=x,z,yaw` drops you there (stripped from production builds). */
function devSpawnOverride(): Player | null {
  if (!import.meta.env.DEV) return null;
  const id = new URLSearchParams(window.location.search).get("at");
  const [x, z, yaw] = (id ?? "").split(",").map(Number);
  if ([x, z, yaw].every(Number.isFinite)) return { x, z, yaw, pitch: 0 };
  const screen = WALL_SCREENS.find((candidate) => candidate.id === id);
  if (!screen) return null;
  const [nx, nz] = screen.normal;
  return { x: screen.x + nx * 1.6, z: screen.z + nz * 1.6, yaw: Math.atan2(nx, nz), pitch: 0 };
}

type Controls = {
  keys: Set<string>;
  stick: { x: number; y: number };
  look: { x: number; y: number };
  player: Player;
  dragDistance: number;
};

/** Walkable server hall. Each rack is a live object in the same simulation as the terminal. */
export default function FloorView({ cluster, scenario, role, selected, comms, isLaptopOpen, isOverlayOpen, panic, laptopScreenRef, onInspect, onUseScreen, onToggleLaptop, onWhereabouts, onStep, teammates = [], onPresence }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [start] = useState(() => startFor(role));
  const isLaptopOpenRef = useRef(isLaptopOpen);
  // Racks are laid out around their own origin, then wheeled into the data-centre room.
  const racks = useMemo(
    () =>
      layoutHall(cluster, scenario.externals).map((rack) => ({
        ...rack,
        footprint: { ...rack.footprint, x: rack.footprint.x + DATACENTRE_ORIGIN.x, z: rack.footprint.z + DATACENTRE_ORIGIN.z },
      })),
    [cluster, scenario.externals],
  );
  const reduceMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [pinned] = useState(pinnedQuality);
  const [quality, setQuality] = useState<Quality>(() => pinned ?? startingQuality(readDeviceHints()));
  const settings = QUALITY[quality];
  // Only ever step down: switching shadows recompiles every material, so bouncing between tiers would stutter.
  const stepDown = useCallback(() => {
    if (!pinned) setQuality("low");
  }, [pinned]);
  // With post-processing the effect chain tone-maps; without it the renderer does.
  const gl = useMemo(() => ({ antialias: true, powerPreference: "high-performance" as const, toneMapping: settings.hasEffects ? NoToneMapping : AgXToneMapping }), [settings.hasEffects]);
  const controls = useRef<Controls>({
    keys: new Set(),
    stick: { x: 0, y: 0 },
    look: { x: 0, y: 0 },
    player: start,
    dragDistance: 0,
  });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // Everything you can press E on: live racks and the role rooms' wall screens.
  const usables = useMemo<Usable[]>(
    () => [
      ...racks.flatMap((rack) => (rack.node ? [{ key: rack.key, footprint: rack.footprint, verb: "Inspect", label: rack.label, target: { kind: "rack" as const, rack } }] : [])),
      ...WALL_SCREENS.map((screen) => ({ key: screen.id, footprint: screenFootprint(screen), verb: "Discuss at", label: screen.title.split(" · ")[0], target: { kind: "screen" as const, screen } })),
    ],
    [racks],
  );
  const focused = usables.find((usable) => usable.key === focusedKey) ?? null;
  const lookPointer = useRef<{ id: number; x: number; y: number } | null>(null);

  // While the laptop is up you're typing, not walking; when it goes down, the hall takes the keyboard back.
  const isBusy = isLaptopOpen || isOverlayOpen;
  useEffect(() => {
    isLaptopOpenRef.current = isBusy;
    controls.current.keys.clear();
    controls.current.look = { x: 0, y: 0 };
    if (!isBusy) wrapper.current?.focus({ preventScroll: true });
  }, [isBusy]);

  const readIntent = useCallback((seconds: number): Intent => {
    const state = controls.current;
    if (isLaptopOpenRef.current) return STILL;
    const axis = (positive: string[], negative: string[]) =>
      (positive.some((key) => state.keys.has(key)) ? 1 : 0) - (negative.some((key) => state.keys.has(key)) ? 1 : 0);
    const intent: Intent = {
      forward: axis(["w", "arrowup"], ["s", "arrowdown"]) - state.stick.y,
      strafe: axis(["d"], ["a"]) + state.stick.x,
      yawDelta: -state.look.x * LOOK_SPEED + axis(["arrowleft", "q"], ["arrowright"]) * seconds * 1.8,
      pitchDelta: -state.look.y * LOOK_SPEED,
    };
    state.look = { x: 0, y: 0 };
    return intent;
  }, []);

  const rackFootprints = useMemo(() => racks.map((rack) => rack.footprint), [racks]);
  const rackFootprintsRef = useRef(rackFootprints);
  useEffect(() => {
    rackFootprintsRef.current = rackFootprints;
  }, [rackFootprints]);
  const lastWhere = useRef<string>("");
  const strideLeft = useRef(STRIDE_METRES);
  const onPlayerMove = useCallback(
    (player: Player) => {
      const previous = controls.current.player;
      controls.current.player = player;
      const where = whereabouts(player, rackFootprintsRef.current);
      const key = `${where.zone}:${where.rackProximity}`;
      if (key !== lastWhere.current) {
        lastWhere.current = key;
        onWhereabouts?.(where);
      }
      const moved = Math.hypot(player.x - previous.x, player.z - previous.z);
      if (moved > 0.001 || Math.abs(player.yaw - previous.yaw) > 0.01) onPresence?.({ x: player.x, z: player.z, yaw: player.yaw });
      strideLeft.current -= moved;
      if (strideLeft.current <= 0) {
        strideLeft.current = STRIDE_METRES;
        onStep?.(where.surface);
      }
    },
    [onPresence, onStep, onWhereabouts],
  );
  const getPlayer = useCallback(() => controls.current.player, []);

  const moveStick = useCallback((x: number, y: number) => {
    controls.current.stick = { x, y };
  }, []);

  const inspect = useCallback((rack: Rack | null) => {
    if (rack?.node) onInspect(rack.node);
  }, [onInspect]);
  const use = useCallback(
    (usable: Usable | null) => {
      if (!usable) return;
      if (usable.target.kind === "rack") inspect(usable.target.rack);
      else onUseScreen(usable.target.screen);
    },
    [inspect, onUseScreen],
  );

  const onKey = (isDown: boolean) => (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "q", "e"].includes(key)) event.preventDefault();
    if (isDown && !event.repeat && (key === "e" || key === "enter")) use(focused);
    if (isDown && !event.repeat && key === "l") onToggleLaptop();
    if (isDown) controls.current.keys.add(key);
    else controls.current.keys.delete(key);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (isLaptopOpenRef.current || (event.target as Element).closest("button, .stick")) return;
    lookPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    controls.current.dragDistance = 0;
    event.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = lookPointer.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    controls.current.look.x += dx;
    controls.current.look.y += dy;
    controls.current.dragDistance += Math.hypot(dx, dy);
    lookPointer.current = { id: pointer.id, x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (lookPointer.current?.id === event.pointerId) lookPointer.current = null;
  };

  const onRackClick = useCallback(
    (rack: Rack, event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      const { player, dragDistance } = controls.current;
      if (dragDistance > DRAG_SLOP) return;
      const distance = Math.hypot(rack.footprint.x - player.x, rack.footprint.z - player.z);
      if (distance <= CLICK_REACH) inspect(rack);
    },
    [inspect],
  );

  const capacity = cluster.database.maxConnections - cluster.database.reservedConnections;
  const poolSize = cluster.deployments[0]?.poolSize ?? 1;
  const loadOf = (rack: Rack): number => {
    if (rack.kind === "database") return openConnections(cluster.deployments) / capacity;
    if (rack.kind === "network") return Math.max(0.15, cluster.errorRate);
    if (rack.node?.kind === "pod") {
      const name = rack.node.name;
      const pod = cluster.deployments.flatMap((deployment) => deployment.pods).find((candidate) => candidate.name === name);
      return pod && pod.phase === "Running" ? Math.min(1, pod.leaked / poolSize) : 0;
    }
    return 0.3;
  };

  return (
    <div
      ref={wrapper}
      className="floor"
      tabIndex={0}
      role="application"
      aria-label="Server hall. W A S D or arrow keys to walk, drag to look, E to inspect the rack in front of you, L to raise your laptop."
      onKeyDown={onKey(true)}
      onKeyUp={onKey(false)}
      onBlur={() => controls.current.keys.clear()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <Canvas
        dpr={[...settings.dpr]}
        shadows={settings.hasShadows ? "percentage" : false}
        gl={gl}
        camera={{ fov: 70, near: 0.05, far: 80, position: [start.x, EYE_HEIGHT, start.z] }}
      >
        <color attach="background" args={[0, 0, 0]} />
        <PerformanceMonitor onDecline={stepDown} onFallback={stepDown} />
        <Office panic={panic} reduceMotion={reduceMotion} hasShadows={settings.hasShadows} />
        <People comms={comms} now={cluster.t} getPlayer={getPlayer} reduceMotion={reduceMotion} panic={panic} />
        <Teammates teammates={teammates} reduceMotion={reduceMotion} />
        {racks.map((rack) => (
          <RackModel
            key={rack.key}
            rack={rack}
            load={loadOf(rack)}
            isFocused={rack.key === focusedKey}
            isSelected={rack.node !== null && sameNode(rack.node, selected)}
            reduceMotion={reduceMotion}
            onActivate={onRackClick}
          />
        ))}
        {rowSigns(cluster).map((sign) => (
          <RowSign key={sign.label} title={sign.label} health={sign.health} x={sign.x + DATACENTRE_ORIGIN.x} z={sign.z + DATACENTRE_ORIGIN.z} />
        ))}
        <Beacon health={edgeHealth(cluster)} reduceMotion={reduceMotion} x={DATACENTRE_ORIGIN.x} z={DATACENTRE_ORIGIN.z} />
        <Laptop isOpen={isLaptopOpen} reduceMotion={reduceMotion} screenRef={laptopScreenRef} />
        {settings.hasEffects && <Effects />}
        <PlayerRig start={start} racks={racks} usables={usables} readIntent={readIntent} onMove={onPlayerMove} onFocus={setFocusedKey} tremor={reduceMotion ? 0 : panic} />
      </Canvas>

      {!isBusy && <Stick onMove={moveStick} />}
      {!isBusy && focused && (
        <button type="button" className="floor__prompt" onClick={() => use(focused)}>
          <kbd>E</kbd> {focused.verb} {focused.label}
        </button>
      )}
      {!isBusy && (
        <button type="button" className="floor__laptop" onClick={onToggleLaptop}>
          <kbd>L</kbd> Laptop
        </button>
      )}
      {!isBusy && (
        <p className="floor__help" aria-hidden="true">
          Drag to look · stick or WASD to walk
        </p>
      )}
    </div>
  );
}

type RigProps = {
  start: Player;
  racks: readonly Rack[];
  usables: readonly Usable[];
  /** Pulls (and consumes) this frame's movement intent from whoever owns the input. */
  readIntent: (seconds: number) => Intent;
  onMove: (player: Player) => void;
  onFocus: (key: string | null) => void;
  /** 0..1 camera tremor; zero for people who prefer reduced motion. */
  tremor: number;
};

function PlayerRig({ start, racks, usables, readIntent, onMove, onFocus, tremor }: RigProps) {
  const player = useRef(start);
  const lastFocus = useRef<string | null>(null);
  const obstacles = useMemo(() => [...officeObstacles(), ...obstaclesOf(racks)], [racks]);

  useFrame(({ camera }, delta) => {
    const seconds = Math.min(delta, 0.05);
    player.current = walk(player.current, readIntent(seconds), seconds, obstacles, BUILDING);
    // A faint, irregular tremor once things are bad — adrenaline, not an earthquake.
    const shake = tremor > 0.6 ? (tremor - 0.6) * 0.012 : 0;
    const time = performance.now() / 1000;
    camera.position.set(
      player.current.x + Math.sin(time * 23.1) * shake,
      EYE_HEIGHT + Math.sin(time * 31.7) * shake,
      player.current.z + Math.cos(time * 19.3) * shake,
    );
    // Set all three angles: R3F aims the default camera at the origin, which would leave a roll behind.
    camera.rotation.set(player.current.pitch, player.current.yaw, 0, "YXZ");
    onMove(player.current);

    const key = facing(player.current, usables)?.key ?? null;
    if (key !== lastFocus.current) {
      lastFocus.current = key;
      onFocus(key);
    }
  });
  return null;
}

function RowSign({ title, health, x, z }: { title: string; health: Parameters<typeof signTexture>[2]; x: number; z: number }) {
  const texture = useMemo(() => signTexture(title, "deployment", health), [title, health]);
  useEffect(() => () => texture.dispose(), [texture]);
  const aspect = texture.image.width / texture.image.height;
  return (
    <sprite position={[x, 3.05, z]} scale={[0.6 * aspect, 0.6, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

/** Thumb joystick for touch screens; reports a -1..1 vector into the shared controls. */
function Stick({ onMove }: { onMove: (x: number, y: number) => void }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const pointer = useRef<number | null>(null);
  const RADIUS = 44;

  const update = (event: PointerEvent<HTMLDivElement>) => {
    const box = base.current?.getBoundingClientRect();
    if (!box) return;
    let x = event.clientX - (box.left + box.width / 2);
    let y = event.clientY - (box.top + box.height / 2);
    const length = Math.hypot(x, y);
    if (length > RADIUS) {
      x = (x / length) * RADIUS;
      y = (y / length) * RADIUS;
    }
    setKnob({ x, y });
    onMove(x / RADIUS, y / RADIUS);
  };
  const release = () => {
    pointer.current = null;
    setKnob({ x: 0, y: 0 });
    onMove(0, 0);
  };

  return (
    <div
      ref={base}
      className="stick"
      aria-hidden="true"
      onPointerDown={(event) => {
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        update(event);
      }}
      onPointerMove={(event) => {
        if (pointer.current === event.pointerId) update(event);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <span className="stick__knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}
