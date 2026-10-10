import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { CanvasTexture, SRGBColorSpace, type Group, type Sprite } from "three";
import type { CommsMessage } from "../scenario.ts";
import type { Teammate } from "../ui/feed.ts";
import { loopThrough, navNode, nearestNode, positionOnLoop, positionOnPath, route, type Point } from "./navigation.ts";
import { PEOPLE, seatOf, type Outfit, type Person } from "./office.ts";
import { tokenColor } from "./tokens.ts";

type Props = {
  comms: readonly CommsMessage[];
  /** Simulated seconds since the page — compared with each message's `at`. */
  now: number;
  getPlayer: () => Point;
  reduceMotion: boolean;
};

/** How long (simulated seconds) a colleague stays at your desk after their message. */
const VISIT_SECONDS = 60;

export function People({ comms, now, getPlayer, reduceMotion }: Props) {
  return (
    <>
      {PEOPLE.map((person, index) => (
        <PersonModel key={person.id} person={person} skin={((index % 4) + 1) as 1 | 2 | 3 | 4} comms={comms} now={now} getPlayer={getPlayer} reduceMotion={reduceMotion} />
      ))}
    </>
  );
}

type PersonProps = Props & { person: Person; skin: 1 | 2 | 3 | 4 };

function PersonModel({ person, skin, comms, now, getPlayer, reduceMotion }: PersonProps) {
  const body = useRef<Group>(null);
  const leftLeg = useRef<Group>(null);
  const rightLeg = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const loop = useMemo(() => (person.kind === "walker" ? loopThrough(person.stops) : null), [person]);
  const visit = useVisit(person, comms, now, getPlayer);
  const isSeated = person.kind === "seated";

  useFrame(({ clock }) => {
    const group = body.current;
    if (!group) return;
    const time = clock.elapsedTime;
    let pose = { x: 0, z: 0, heading: 0, isWalking: false };

    if (person.kind === "seated") {
      const seat = seatOf(person.desk);
      pose = { x: seat.x, z: seat.z, heading: person.desk.facing === 1 ? 0 : Math.PI, isWalking: false };
    } else if (person.kind === "standing") {
      pose = { x: person.x, z: person.z, heading: person.yaw, isWalking: false };
    } else if (person.kind === "walker" && loop) {
      pose = positionOnLoop(loop, time + person.offset * 7);
    } else if (person.kind === "messenger") {
      pose = visit.pose(time);
    }

    group.position.set(pose.x, 0, pose.z);
    group.rotation.y = pose.heading;

    const swing = pose.isWalking && !reduceMotion ? Math.sin(time * 7.5) * 0.55 : 0;
    const typing = isSeated && !reduceMotion ? Math.sin(time * 18 + pose.x) * 0.06 : 0;
    if (leftLeg.current && rightLeg.current) {
      leftLeg.current.rotation.x = isSeated ? -Math.PI / 2 : swing;
      rightLeg.current.rotation.x = isSeated ? -Math.PI / 2 : -swing;
    }
    if (leftArm.current && rightArm.current) {
      leftArm.current.rotation.x = isSeated ? -0.75 + typing : -swing * 0.8;
      rightArm.current.rotation.x = isSeated ? -0.75 - typing : swing * 0.8;
    }
  });

  return (
    <group ref={body} name={person.id}>
      <HumanFigure limbs={{ leftLeg, rightLeg, leftArm, rightArm }} skin={skin} outfit={person.outfit} isSeated={isSeated} />
      {person.kind === "messenger" && <SpeechBubble name={person.name} text={visit.message?.text ?? null} isShown={visit.isArrived} y={(isSeated ? 0.5 : 0.92) + 1.12} />}
    </group>
  );
}

type Limbs = {
  leftLeg: React.RefObject<Group | null>;
  rightLeg: React.RefObject<Group | null>;
  leftArm: React.RefObject<Group | null>;
  rightArm: React.RefObject<Group | null>;
};

/** The body shared by colleagues and teammates; limbs pivot at hip and shoulder so callers can animate them. */
function HumanFigure({ limbs, skin, outfit, isSeated }: { limbs: Limbs; skin: 1 | 2 | 3 | 4; outfit: Outfit; isSeated: boolean }) {
  const skinColor = tokenColor(`--color-skin-${skin}`);
  const shirt = tokenColor(`--color-outfit-${outfit}`);
  const trousers = tokenColor("--color-trousers");
  const hair = tokenColor("--color-hair");
  const hip = isSeated ? 0.5 : 0.92;
  return (
    <>
      {([
        [limbs.leftLeg, -0.1],
        [limbs.rightLeg, 0.1],
      ] as const).map(([ref, x]) => (
        <group key={x} ref={ref} position={[x, hip, 0]}>
          <mesh position={[0, -0.44, 0]}>
            <boxGeometry args={[0.15, 0.88, 0.17]} />
            <meshStandardMaterial color={trousers} roughness={0.85} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, hip + 0.32, 0]}>
        <boxGeometry args={[0.44, 0.64, 0.25]} />
        <meshStandardMaterial color={shirt} roughness={0.8} />
      </mesh>
      {([
        [limbs.leftArm, -0.29],
        [limbs.rightArm, 0.29],
      ] as const).map(([ref, x]) => (
        <group key={x} ref={ref} position={[x, hip + 0.6, 0]}>
          <mesh position={[0, -0.3, 0]}>
            <boxGeometry args={[0.12, 0.6, 0.14]} />
            <meshStandardMaterial color={shirt} roughness={0.8} />
          </mesh>
          <mesh position={[0, -0.64, 0]}>
            <sphereGeometry args={[0.06, 10, 8]} />
            <meshStandardMaterial color={skinColor} roughness={0.7} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, hip + 0.8, 0]}>
        <sphereGeometry args={[0.13, 18, 14]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>
      <mesh position={[0, hip + 0.86, -0.02]} scale={[1.05, 0.75, 1.05]}>
        <sphereGeometry args={[0.13, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={hair} roughness={0.9} />
      </mesh>
      {[-0.045, 0.045].map((x) => (
        <mesh key={x} position={[x, hip + 0.82, 0.118]}>
          <sphereGeometry args={[0.016, 8, 6]} />
          <meshStandardMaterial color={hair} roughness={0.4} />
        </mesh>
      ))}
    </>
  );
}

/** Other players in a shared room: they glide to their reported position and wear a name tag. */
export function Teammates({ teammates, reduceMotion }: { teammates: readonly Teammate[]; reduceMotion: boolean }) {
  return (
    <>
      {teammates.map((teammate, index) =>
        teammate.position ? <TeammateModel key={teammate.id} teammate={teammate} index={index} reduceMotion={reduceMotion} /> : null,
      )}
    </>
  );
}

function TeammateModel({ teammate, index, reduceMotion }: { teammate: Teammate; index: number; reduceMotion: boolean }) {
  const body = useRef<Group>(null);
  const leftLeg = useRef<Group>(null);
  const rightLeg = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const target = teammate.position;
  const tag = useMemo(() => bubbleTexture(teammate.name, teammate.roleLabel), [teammate.name, teammate.roleLabel]);
  useEffect(() => () => tag.dispose(), [tag]);

  useFrame(({ clock }, delta) => {
    const group = body.current;
    if (!group || !target) return;
    // Presence arrives ~10×/s; ease toward it so movement reads as walking, not teleporting.
    const ease = 1 - Math.exp(-delta * 10);
    const dx = target.x - group.position.x;
    const dz = target.z - group.position.z;
    group.position.x += dx * ease;
    group.position.z += dz * ease;
    group.rotation.y = target.yaw + Math.PI;
    const isWalking = Math.hypot(dx, dz) > 0.05;
    const swing = isWalking && !reduceMotion ? Math.sin(clock.elapsedTime * 7.5) * 0.55 : 0;
    if (leftLeg.current) leftLeg.current.rotation.x = swing;
    if (rightLeg.current) rightLeg.current.rotation.x = -swing;
    if (leftArm.current) leftArm.current.rotation.x = -swing * 0.8;
    if (rightArm.current) rightArm.current.rotation.x = swing * 0.8;
  });

  const aspect = tag.image.width / tag.image.height;
  return (
    <group ref={body} position={[target?.x ?? 0, 0, target?.z ?? 0]}>
      <HumanFigure limbs={{ leftLeg, rightLeg, leftArm, rightArm }} skin={((index % 4) + 1) as 1 | 2 | 3 | 4} outfit={(((index + 3) % 6) + 1) as Outfit} isSeated={false} />
      <sprite position={[0, 2.15, 0]} scale={[0.3 * aspect, 0.3, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}

type Pose = { x: number; z: number; heading: number; isWalking: boolean };

/**
 * A messenger's trip: when their newest message lands, they walk from home to
 * the player, stay a while, then walk back. Paths are planned once per message.
 */
function useVisit(person: Person, comms: readonly CommsMessage[], now: number, getPlayer: () => Point) {
  const name = person.kind === "messenger" ? person.name : null;
  const home = person.kind === "messenger" ? navNode(person.home) : { x: 0, z: 0, id: "" };
  const message = name ? ([...comms].reverse().find((item) => item.from.startsWith(name)) ?? null) : null;
  const isVisiting = message !== null && now - message.at < VISIT_SECONDS;
  const trip = useRef<{ key: string; path: Point[]; startedAt: number | null; direction: "going" | "returning" } | null>(null);
  const arrived = useRef(false);

  const key = message ? `${message.at}:${message.text}` : "";
  useEffect(() => {
    if (!name || person.kind !== "messenger") return;
    if (isVisiting) {
      const player = getPlayer();
      const towardPlayer = route(person.home, nearestNode(player).id);
      const last = towardPlayer.at(-1) ?? player;
      const reach = Math.hypot(player.x - last.x, player.z - last.z);
      // Stop at conversational distance, on the side they arrived from.
      const stand = reach > 1.7 ? { x: player.x + ((last.x - player.x) / reach) * 1.6, z: player.z + ((last.z - player.z) / reach) * 1.6 } : last;
      trip.current = { key, path: [...towardPlayer, stand], startedAt: null, direction: "going" };
      arrived.current = false;
    } else if (trip.current?.direction === "going") {
      trip.current = { ...trip.current, path: [...trip.current.path].reverse(), startedAt: null, direction: "returning" };
      arrived.current = false;
    }
  }, [getPlayer, isVisiting, key, name, person]);

  return {
    message: isVisiting ? message : null,
    /** Read per frame: true once they're standing at your desk. */
    isArrived: () => isVisiting && arrived.current,
    pose(time: number): Pose {
      const current = trip.current;
      if (!current) return { x: home.x, z: home.z, heading: Math.PI, isWalking: false };
      if (current.startedAt === null) current.startedAt = time;
      const step = positionOnPath(current.path, time - current.startedAt);
      if (!step.isWalking) {
        arrived.current = current.direction === "going";
        if (current.direction === "returning") trip.current = null;
        if (current.direction === "going") {
          const player = getPlayer();
          return { x: step.x, z: step.z, heading: Math.atan2(player.x - step.x, player.z - step.z), isWalking: false };
        }
      }
      return step;
    },
  };
}

function SpeechBubble({ name, text, isShown, y }: { name: string; text: string | null; isShown: () => boolean; y: number }) {
  const sprite = useRef<Sprite>(null);
  const texture = useMemo(() => (text ? bubbleTexture(name, text) : null), [name, text]);
  useEffect(() => () => texture?.dispose(), [texture]);
  useFrame(() => {
    if (sprite.current) sprite.current.visible = isShown() && texture !== null;
  });
  if (!texture) return null;
  const aspect = texture.image.width / texture.image.height;
  return (
    <sprite ref={sprite} position={[0, y, 0]} scale={[0.38 * aspect, 0.38, 1]} visible={false}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

function bubbleTexture(name: string, text: string): CanvasTexture {
  const scale = 2;
  const width = 420;
  const styles = getComputedStyle(document.documentElement);
  const token = (key: string) => styles.getPropertyValue(key).trim();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const body = `400 20px ${token("--font-body")}`;
  context.font = body;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const attempt = line ? `${line} ${word}` : word;
    if (context.measureText(attempt).width > width - 36 && line) {
      lines.push(line);
      line = word;
    } else {
      line = attempt;
    }
  }
  if (line) lines.push(line);
  const height = 56 + lines.length * 26;
  canvas.width = width * scale;
  canvas.height = height * scale;
  context.scale(scale, scale);
  context.fillStyle = token("--color-paper-2");
  context.beginPath();
  context.roundRect(0, 0, width, height, 14);
  context.fill();
  context.fillStyle = token("--color-accent");
  context.font = `600 18px ${token("--font-mono")}`;
  context.fillText(name, 18, 30);
  context.fillStyle = token("--color-ink");
  context.font = body;
  lines.forEach((text, index) => context.fillText(text, 18, 58 + index * 26));
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
