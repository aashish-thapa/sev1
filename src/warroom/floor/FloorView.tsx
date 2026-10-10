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
import { BUILDING, DATACENTRE_ORIGIN, officeObstacles, PLAYER_DESK, screenFootprint, spawnFor, WALL_SCREENS, type WallScreen } from "./office.ts";
import { whereabouts, type Whereabouts } from "./whereabouts.ts";
import { useCareer } from "../../app/career-context.ts";
import { BrewingCup } from "./interactions/BrewingCup.tsx";
import { HeldCup } from "./interactions/HeldCup.tsx";
import { LifeHud } from "./interactions/LifeHud.tsx";
import { MyDesk } from "./interactions/MyDesk.tsx";
import { PinnedNotes } from "./interactions/PinnedNotes.tsx";
import { eyeHeightOf, lookWhileSeated, wantsToWalk, type Stance } from "./interactions/stance.ts";
import { StickyWallPanel } from "./interactions/StickyWallPanel.tsx";
import type { Usable } from "./interactions/usable.ts";
import { useCoffee } from "./interactions/useCoffee.ts";
import { useSeating } from "./interactions/useSeating.ts";
import { hasPresenceChanged, presenceOf, type PlayerPresence } from "./interactions/presence.ts";
import { useSmallTalk } from "./interactions/useSmallTalk.ts";
import { useStandup } from "./interactions/useStandup.ts";
import { useStickyWall } from "./interactions/useStickyWall.ts";
import { SIPS_PER_CUP } from "./interactions/coffee.ts";
import "./interactions/office-life.css";
import { People, Teammates } from "./People.tsx";
import { SelfBody } from "./people/SelfBody.tsx";
import type { Teammate } from "../ui/feed.ts";
import { facing, walk, type Intent, type Player } from "./player.ts";
import { MathUtils, Vector3 } from "three";
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
  /** What teammates should see of you; sent whenever it changes. */
  onPresence?: (presence: PlayerPresence) => void;
  /** Picks your own body; teammates derive the same avatar from the same seed. */
  selfAvatarSeed: string;
  /** An incident is live and it's yours: the floor points you back to your desk. */
  isPaged?: boolean;
};

const STRIDE_METRES = 0.72;

const STILL: Intent = { forward: 0, strafe: 0, yawDelta: 0, pitchDelta: 0 };

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
export default function FloorView({ cluster, scenario, role, selected, comms, isLaptopOpen, isOverlayOpen, panic, laptopScreenRef, onInspect, onUseScreen, onToggleLaptop, onWhereabouts, onStep, teammates = [], onPresence, selfAvatarSeed, isPaged = false }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [start] = useState(() => startFor(role));
  const isLaptopOpenRef = useRef(isLaptopOpen);
  // Only the laptop (not overlays or the note wall) shows on your body for teammates.
  const isOnLaptopRef = useRef(isLaptopOpen);
  const lastPresence = useRef<PlayerPresence | null>(null);
  useEffect(() => {
    isOnLaptopRef.current = isLaptopOpen;
  }, [isLaptopOpen]);
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
  const getPlayer = useCallback(() => controls.current.player, []);
  const career = useCareer();
  const seating = useSeating(getPlayer);
  const readStance = seating.readStance;
  const coffee = useCoffee();
  const smallTalk = useSmallTalk(panic);
  const noteWall = useStickyWall();
  const standup = useStandup(isPaged, career.title);

  const inspect = useCallback((rack: Rack | null) => {
    if (rack?.node) onInspect(rack.node);
  }, [onInspect]);
  // Everything you can press E on: live racks, the role rooms' wall screens, and the office itself.
  const usables = useMemo<Usable[]>(
    () => [
      ...racks.flatMap((rack) => (rack.node ? [{ key: rack.key, footprint: rack.footprint, verb: "Inspect", label: rack.label, use: () => inspect(rack) }] : [])),
      ...WALL_SCREENS.map((screen) => ({ key: screen.id, footprint: screenFootprint(screen), verb: "Discuss at", label: screen.title.split(" · ")[0], use: () => onUseScreen(screen) })),
      ...seating.usables,
      ...coffee.usables,
      ...smallTalk.usables,
      ...noteWall.usables,
      ...standup.usables,
    ],
    [coffee.usables, inspect, noteWall.usables, onUseScreen, racks, seating.usables, smallTalk.usables, standup.usables],
  );
  // Sitting, the only thing to do with E is get up again.
  const focused = seating.standUsable ?? usables.find((usable) => usable.key === focusedKey) ?? null;
  const lookPointer = useRef<{ id: number; x: number; y: number } | null>(null);

  // While the laptop is up you're typing, not walking; when it goes down, the hall takes the keyboard back.
  const isBusy = isLaptopOpen || isOverlayOpen || noteWall.isOpen;
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
  const [isAwayFromDesk, setAwayFromDesk] = useState(true);
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
      const isAway = Math.hypot(player.x - PLAYER_DESK.x, player.z - PLAYER_DESK.z) > DESK_HINT_DISTANCE;
      setAwayFromDesk((current) => (current === isAway ? current : isAway));
      const moved = Math.hypot(player.x - previous.x, player.z - previous.z);
      const presence = presenceOf(player, readStance(), isOnLaptopRef.current);
      if (hasPresenceChanged(lastPresence.current, presence)) {
        lastPresence.current = presence;
        onPresence?.(presence);
      }
      strideLeft.current -= moved;
      if (strideLeft.current <= 0) {
        strideLeft.current = STRIDE_METRES;
        onStep?.(where.surface);
      }
    },
    [onPresence, onStep, onWhereabouts, readStance],
  );
  const moveStick = useCallback((x: number, y: number) => {
    controls.current.stick = { x, y };
  }, []);

  const onKey = (isDown: boolean) => (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "q", "e", "c"].includes(key)) event.preventDefault();
    if (isDown && !event.repeat && (key === "e" || key === "enter")) focused?.use();
    if (isDown && !event.repeat && key === "l") onToggleLaptop();
    if (isDown && !event.repeat && key === "c") coffee.sip();
    if (isDown && !event.repeat && key === "escape" && !isLaptopOpen) seating.stand();
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

  const openTerminalAtDesk = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      const { player, dragDistance } = controls.current;
      if (dragDistance > DRAG_SLOP || isLaptopOpen) return;
      if (Math.hypot(PLAYER_DESK.x - player.x, PLAYER_DESK.z - player.z) <= CLICK_REACH) onToggleLaptop();
    },
    [isLaptopOpen, onToggleLaptop],
  );
  const rig = useMemo<RigControl>(
    () => ({ stance: seating.readStance, takeTeleport: seating.takeTeleport, pace: coffee.pace, standUp: seating.stand }),
    [coffee.pace, seating.readStance, seating.stand, seating.takeTeleport],
  );
  const cup = coffee.coffee.cup;

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
      aria-label="The office. W A S D or arrow keys to walk, drag to look, E to use what's in front of you (sit at a desk, make coffee, chat, inspect a rack), C to sip your coffee, L to raise your laptop."
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
        camera={{ fov: 70, near: 0.05, far: 80, position: [start.x, eyeHeightOf({ kind: "standing" }), start.z] }}
      >
        <color attach="background" args={[0, 0, 0]} />
        <PerformanceMonitor onDecline={stepDown} onFallback={stepDown} />
        <Office panic={panic} reduceMotion={reduceMotion} hasShadows={settings.hasShadows} />
        <People comms={comms} now={cluster.t} getPlayer={getPlayer} reduceMotion={reduceMotion} panic={panic} teammates={teammates} conversation={smallTalk.conversation} />
        <Teammates teammates={teammates} reduceMotion={reduceMotion} />
        <SelfBody seed={selfAvatarSeed} getPlayer={getPlayer} getStance={seating.readStance} reduceMotion={reduceMotion} />
        <MyDesk role={role} onOpenTerminal={openTerminalAtDesk} />
        <PinnedNotes notes={noteWall.notes} />
        {cup.kind === "brewing" && coffee.machine && <BrewingCup machine={coffee.machine} reduceMotion={reduceMotion} />}
        <HeldCup isHeld={cup.kind === "holding"} sips={cup.kind === "holding" ? SIPS_PER_CUP - cup.sipsLeft : 0} isHandsBusy={isLaptopOpen} reduceMotion={reduceMotion} />
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
        <PlayerRig start={start} racks={racks} usables={usables} readIntent={readIntent} onMove={onPlayerMove} onFocus={setFocusedKey} tremor={reduceMotion ? 0 : panic} control={rig} reduceMotion={reduceMotion} />
      </Canvas>

      {!isBusy && <Stick onMove={moveStick} />}
      {!isBusy && focused && (
        <button type="button" className="floor__prompt" onClick={() => focused.use()}>
          <kbd>E</kbd> {`${focused.verb} ${focused.label}`.trim()}
        </button>
      )}
      {!isBusy && (
        <LifeHud
          cup={cup}
          caffeine={coffee.caffeineLeft()}
          onSip={coffee.sip}
          standup={standup.notice}
          showDeskHint={isPaged && seating.stance.kind === "standing" && isAwayFromDesk}
        />
      )}
      {noteWall.isOpen && <StickyWallPanel notes={noteWall.notes} onPin={noteWall.pin} onClose={noteWall.close} />}
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

/** How office life steers the rig: sitting pins you to a chair, coffee quickens your step. */
type RigControl = {
  stance: () => Stance;
  /** A new pose to jump to (sitting down, standing up), taken once. */
  takeTeleport: () => Player | null;
  pace: () => number;
  standUp: () => void;
};

/** Sitting down or getting up glides the camera instead of cutting. */
const POSE_CHANGE_SECONDS = 0.6;
/** Paged and further than this from your desk: the floor reminds you where it is. */
const DESK_HINT_DISTANCE = 5;

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
  control: RigControl;
  reduceMotion: boolean;
};

function PlayerRig({ start, racks, usables, readIntent, onMove, onFocus, tremor, control, reduceMotion }: RigProps) {
  const player = useRef(start);
  const lastFocus = useRef<string | null>(null);
  const obstacles = useMemo(() => [...officeObstacles(), ...obstaclesOf(racks)], [racks]);
  const glide = useRef<{ from: Vector3; startedAt: number } | null>(null);
  const target = useMemo(() => new Vector3(), []);

  useFrame(({ camera }, delta) => {
    const seconds = Math.min(delta, 0.05);
    const time = performance.now() / 1000;
    const jump = control.takeTeleport();
    if (jump) {
      player.current = jump;
      glide.current = reduceMotion ? null : { from: camera.position.clone(), startedAt: time };
    }
    const stance = control.stance();
    const intent = readIntent(seconds);
    if (stance.kind === "seated") {
      if (wantsToWalk(intent)) control.standUp();
      else player.current = lookWhileSeated(player.current, intent, stance.seat);
    } else {
      player.current = walk(player.current, intent, seconds, obstacles, BUILDING, control.pace());
    }
    // A faint, irregular tremor once things are bad — adrenaline, not an earthquake.
    const shake = tremor > 0.6 ? (tremor - 0.6) * 0.012 : 0;
    target.set(player.current.x + Math.sin(time * 23.1) * shake, eyeHeightOf(stance) + Math.sin(time * 31.7) * shake, player.current.z + Math.cos(time * 19.3) * shake);
    const move = glide.current;
    const progress = move ? Math.min(1, (time - move.startedAt) / POSE_CHANGE_SECONDS) : 1;
    if (move && progress < 1) camera.position.lerpVectors(move.from, target, MathUtils.smootherstep(progress, 0, 1));
    else {
      glide.current = null;
      camera.position.copy(target);
    }
    // Set all three angles: R3F aims the default camera at the origin, which would leave a roll behind.
    camera.rotation.set(player.current.pitch, player.current.yaw, 0, "YXZ");
    onMove(player.current);

    const key = stance.kind === "seated" ? null : (facing(player.current, usables)?.key ?? null);
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
