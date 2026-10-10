import { useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import type { CommsMessage } from "../scenario.ts";
import type { Teammate } from "../ui/feed.ts";
import { loopThrough, positionOnLoop, WALK_SPEED, type Point } from "./navigation.ts";
import { PEOPLE, seatOf, type Person } from "./office.ts";
import { Avatar } from "./people/Avatar.tsx";
import { avatarFor, HEAD_HEIGHT } from "./people/avatars.ts";
import { motionFor, type Situation } from "./people/behaviour.ts";
import { bubbleTexture } from "./people/bubble.ts";
import { SpeechBubble } from "./people/SpeechBubble.tsx";
import { StandIn } from "./people/StandIn.tsx";
import { useVisit } from "./people/useVisit.ts";

type Props = {
  comms: readonly CommsMessage[];
  /** Simulated seconds since the page — compared with each message's `at`. */
  now: number;
  getPlayer: () => Point;
  reduceMotion: boolean;
  /** 0 calm … 1 meltdown. */
  panic: number;
};

type Level = { readonly current: number };

export function People({ comms, now, getPlayer, reduceMotion, panic }: Props) {
  const panicLevel = useRef(panic);
  useEffect(() => {
    panicLevel.current = panic;
  }, [panic]);
  return (
    <>
      {PEOPLE.map((person) => (
        <PersonModel key={person.id} person={person} comms={comms} now={now} getPlayer={getPlayer} reduceMotion={reduceMotion} panic={panicLevel} />
      ))}
    </>
  );
}

type PersonProps = Omit<Props, "panic"> & { person: Person; panic: Level };

function PersonModel({ person, comms, now, getPlayer, reduceMotion, panic }: PersonProps) {
  const body = useRef<Group>(null);
  const situation = useRef<Situation>(person.kind === "seated" ? { state: "seated" } : { state: "standing", activity: "waiting" });
  const loop = useMemo(() => (person.kind === "walker" ? loopThrough(person.stops) : null), [person]);
  const visit = useVisit(person, comms, now, getPlayer);
  const motion = () => motionFor(situation.current, panic.current, reduceMotion);

  useFrame(({ clock }) => {
    const group = body.current;
    if (!group) return;
    const time = clock.elapsedTime;
    let pose = { x: 0, z: 0, heading: 0, isWalking: false };

    if (person.kind === "seated") {
      const seat = seatOf(person.desk);
      pose = { x: seat.x, z: seat.z, heading: person.desk.facing === 1 ? 0 : Math.PI, isWalking: false };
      situation.current = { state: "seated" };
    } else if (person.kind === "standing") {
      pose = { x: person.x, z: person.z, heading: person.yaw, isWalking: false };
      situation.current = { state: "standing", activity: person.activity };
    } else if (person.kind === "walker" && loop) {
      pose = positionOnLoop(loop, time + person.offset * 7);
      situation.current = pose.isWalking ? { state: "walking", speed: WALK_SPEED } : { state: "standing", activity: "waiting" };
    } else if (person.kind === "messenger") {
      pose = visit.pose(time);
      situation.current = visit.isArrived()
        ? { state: "speaking" }
        : pose.isWalking
          ? { state: "walking", speed: WALK_SPEED }
          : { state: "standing", activity: "waiting" };
    }

    group.position.set(pose.x, 0, pose.z);
    group.rotation.y = pose.heading;
  });

  const isSeated = person.kind === "seated";
  return (
    <group ref={body} name={person.id}>
      <Suspense fallback={<StandIn isSeated={isSeated} />}>
        <Avatar id={person.avatar} motion={motion} />
      </Suspense>
      {person.kind === "messenger" && <SpeechBubble name={person.name} text={visit.message?.text ?? null} isShown={visit.isArrived} y={HEAD_HEIGHT + 0.26} />}
    </group>
  );
}

/** Other players in a shared room: they walk to their reported position and wear a name tag. */
export function Teammates({ teammates, reduceMotion }: { teammates: readonly Teammate[]; reduceMotion: boolean }) {
  return (
    <>
      {teammates.map((teammate) => (teammate.position ? <TeammateModel key={teammate.id} teammate={teammate} reduceMotion={reduceMotion} /> : null))}
    </>
  );
}

/** Below this ground speed (m/s) a teammate reads as standing, not shuffling. */
const STILL_SPEED = 0.15;

function TeammateModel({ teammate, reduceMotion }: { teammate: Teammate; reduceMotion: boolean }) {
  const body = useRef<Group>(null);
  const target = teammate.position;
  const speed = useRef(0);
  const tag = useMemo(() => bubbleTexture(teammate.name, teammate.roleLabel), [teammate.name, teammate.roleLabel]);
  useEffect(() => () => tag.dispose(), [tag]);
  const motion = () =>
    motionFor(speed.current > STILL_SPEED ? { state: "walking", speed: speed.current } : { state: "standing", activity: "waiting" }, 0, reduceMotion);

  useFrame((_, delta) => {
    const group = body.current;
    if (!group || !target || delta <= 0) return;
    // Presence arrives ~10×/s; ease toward it so movement reads as walking, not teleporting.
    const ease = 1 - Math.exp(-delta * 10);
    const stepX = (target.x - group.position.x) * ease;
    const stepZ = (target.z - group.position.z) * ease;
    group.position.x += stepX;
    group.position.z += stepZ;
    group.rotation.y = target.yaw + Math.PI;
    speed.current += (Math.hypot(stepX, stepZ) / delta - speed.current) * Math.min(1, delta * 6);
  });

  const aspect = tag.image.width / tag.image.height;
  return (
    <group ref={body} position={[target?.x ?? 0, 0, target?.z ?? 0]}>
      <Suspense fallback={<StandIn isSeated={false} />}>
        <Avatar id={avatarFor(teammate.id)} motion={motion} />
      </Suspense>
      <sprite position={[0, HEAD_HEIGHT + 0.37, 0]} scale={[0.3 * aspect, 0.3, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}
