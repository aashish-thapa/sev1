import { useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "three";
import type { CommsMessage } from "../scenario.ts";
import type { Teammate } from "../ui/feed.ts";
import { loopThrough, positionOnLoop, WALK_SPEED, type Point } from "./navigation.ts";
import { PEOPLE, seatOf, type Person } from "./office.ts";
import { Avatar } from "./people/Avatar.tsx";
import { avatarFor, HEAD_HEIGHT } from "./people/avatars.ts";
import { motionFor, type Situation } from "./people/behaviour.ts";
import { bubbleTexture } from "./people/bubble.ts";
import { easeSidestep, rightOf, sidestepFor, type Crowd } from "./people/crowd.ts";
import { SpeechBubble } from "./people/SpeechBubble.tsx";
import { StandIn } from "./people/StandIn.tsx";
import { follow, STILL_SPEED, type Follower } from "./people/follow.ts";
import { useVisit } from "./people/useVisit.ts";

type Props = {
  comms: readonly CommsMessage[];
  /** Simulated seconds since the page — compared with each message's `at`. */
  now: number;
  getPlayer: () => Point;
  reduceMotion: boolean;
  /** 0 calm … 1 meltdown. */
  panic: number;
  /** Other players in a shared room; colleagues make room for them too. */
  teammates: readonly Teammate[];
};

type Level = { readonly current: number };

export function People({ comms, now, getPlayer, reduceMotion, panic, teammates }: Props) {
  const panicLevel = useRef(panic);
  useEffect(() => {
    panicLevel.current = panic;
  }, [panic]);
  const crowd = useRef<Crowd>(new Map());
  const others = useRef(teammates);
  useEffect(() => {
    others.current = teammates;
  }, [teammates]);
  useFrame(() => {
    const everyone = crowd.current;
    everyone.set("player", getPlayer());
    const present = new Set<string>();
    for (const teammate of others.current) {
      if (!teammate.position) continue;
      const key = `teammate:${teammate.id}`;
      present.add(key);
      everyone.set(key, teammate.position);
    }
    for (const key of everyone.keys()) if (key.startsWith("teammate:") && !present.has(key)) everyone.delete(key);
  });
  return (
    <>
      {PEOPLE.map((person) => (
        <PersonModel key={person.id} person={person} comms={comms} now={now} getPlayer={getPlayer} reduceMotion={reduceMotion} panic={panicLevel} crowd={crowd} />
      ))}
    </>
  );
}

type PersonProps = Omit<Props, "panic" | "teammates"> & { person: Person; panic: Level; crowd: { readonly current: Crowd } };

function PersonModel({ person, comms, now, getPlayer, reduceMotion, panic, crowd }: PersonProps) {
  const body = useRef<Group>(null);
  // Metres to the right of their lane they've stepped to let someone pass.
  const sidestep = useRef(0);
  const situation = useRef<Situation>(person.kind === "seated" ? { state: "seated" } : { state: "standing", activity: "waiting" });
  const loop = useMemo(() => (person.kind === "walker" ? loopThrough(person.stops) : null), [person]);
  const visit = useVisit(person, comms, now, getPlayer);
  const motion = () => motionFor(situation.current, panic.current, reduceMotion);

  useFrame(({ clock }, delta) => {
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

    if (pose.isWalking) {
      const right = rightOf(pose.heading);
      const at = { x: pose.x + right.x * sidestep.current, z: pose.z + right.z * sidestep.current };
      sidestep.current = easeSidestep(sidestep.current, sidestepFor(person.id, at, pose.heading, crowd.current), delta);
    }
    // Held while paused so nobody slides sideways on the spot; given back once walking clears.
    const right = rightOf(pose.heading);
    const x = pose.x + right.x * sidestep.current;
    const z = pose.z + right.z * sidestep.current;
    crowd.current.set(person.id, { x, z });
    group.position.set(x, 0, z);
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

function TeammateModel({ teammate, reduceMotion }: { teammate: Teammate; reduceMotion: boolean }) {
  const body = useRef<Group>(null);
  const target = teammate.position;
  const follower = useRef<Follower>({ x: target?.x ?? 0, z: target?.z ?? 0, speed: 0 });
  const tag = useMemo(() => bubbleTexture(teammate.name, teammate.roleLabel), [teammate.name, teammate.roleLabel]);
  useEffect(() => () => tag.dispose(), [tag]);
  const motion = () => {
    const { speed } = follower.current;
    return motionFor(speed > STILL_SPEED ? { state: "walking", speed } : { state: "standing", activity: "waiting" }, 0, reduceMotion);
  };

  useFrame((_, delta) => {
    const group = body.current;
    if (!group || !target) return;
    // Presence arrives ~10×/s; easing toward it makes movement read as walking, and gives the legs a real speed.
    follower.current = follow(follower.current, target, delta);
    group.position.x = follower.current.x;
    group.position.z = follower.current.z;
    group.rotation.y = target.yaw + Math.PI;
  });

  // Placed once on arrival; after that only the easing above moves the body, so its speed is real.
  const [arrival] = useState(() => [target?.x ?? 0, 0, target?.z ?? 0] as const);
  const aspect = tag.image.width / tag.image.height;
  return (
    <group ref={body} position={arrival}>
      <Suspense fallback={<StandIn isSeated={false} />}>
        <Avatar id={avatarFor(teammate.id)} motion={motion} />
      </Suspense>
      <sprite position={[0, HEAD_HEIGHT + 0.37, 0]} scale={[0.3 * aspect, 0.3, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}
