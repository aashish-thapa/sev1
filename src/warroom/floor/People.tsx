import { useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "three";
import type { CommsMessage } from "../scenario.ts";
import { badgeById } from "../../domain/achievements.ts";
import { knownTags } from "../../domain/tags.ts";
import type { Teammate } from "../ui/feed.ts";
import { loopThrough, WALK_SPEED, type Point } from "./navigation.ts";
import { carriedAt, walkerPose } from "./people/walkers.ts";
import { seatOf, type Person, type Carried } from "./office.ts";
import { Avatar } from "./people/Avatar.tsx";
import { HEAD_HEIGHT, wornAvatar } from "./people/avatars.ts";
import { motionFor, type Situation } from "./people/behaviour.ts";
import { bubbleTexture } from "./people/bubble.ts";
import { easeSidestep, rightOf, sidestepFor, type Crowd } from "./people/crowd.ts";
import { SpeechBubble } from "./people/SpeechBubble.tsx";
import { StandIn } from "./people/StandIn.tsx";
import { follow, STILL_SPEED, type Follower } from "./people/follow.ts";
import { HeldLaptop } from "./people/HeldLaptop.tsx";
import { SpeakingRing } from "./people/SpeakingRing.tsx";
import { useSpeakingLevels } from "../../multiplayer/voice/context.ts";
import { useVisit } from "./people/useVisit.ts";
import type { Conversation } from "./interactions/useSmallTalk.ts";

const always = () => true;

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
  /** Whoever you're chatting with turns to you, talks, and shows what they said. */
  conversation: Conversation | null;
  /** The colleagues on this floor; none in a company office, where only its members work. */
  people: readonly Person[];
};

type Level = { readonly current: number };

export function People({ comms, now, getPlayer, reduceMotion, panic, teammates, conversation, people }: Props) {
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
      {people.map((person) => (
        <PersonModel
          key={person.id}
          person={person}
          comms={comms}
          now={now}
          getPlayer={getPlayer}
          reduceMotion={reduceMotion}
          panic={panicLevel}
          crowd={crowd}
          conversation={conversation?.colleagueId === person.id ? conversation : null}
        />
      ))}
    </>
  );
}

type PersonProps = Omit<Props, "panic" | "teammates" | "conversation" | "people"> & { person: Person; panic: Level; crowd: { readonly current: Crowd }; conversation: Conversation | null };

/** A seated head is lower than a standing one; the bubble sits just above either. */
const SEATED_HEAD = 1.32;

function PersonModel({ person, comms, now, getPlayer, reduceMotion, panic, crowd, conversation }: PersonProps) {
  const body = useRef<Group>(null);
  // Metres to the right of their lane they've stepped to let someone pass.
  const sidestep = useRef(0);
  const situation = useRef<Situation>(person.kind === "seated" ? { state: "seated" } : { state: "standing", activity: "waiting" });
  const loop = useMemo(() => (person.kind === "walker" ? loopThrough(person.stops) : null), [person]);
  const visit = useVisit(person, comms, now, getPlayer);
  const motion = () => motionFor(situation.current, panic.current, reduceMotion);
  const isTalking = useRef(false);
  const carrying = useRef<Carried | null>(person.kind === "standing" ? (person.holds ?? null) : null);
  useEffect(() => {
    isTalking.current = conversation !== null;
  }, [conversation]);

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
      const player = getPlayer();
      // Mid-conversation they turn to face you; otherwise they face whatever they were doing.
      const heading = isTalking.current ? Math.atan2(player.x - person.x, player.z - person.z) : person.yaw;
      pose = { x: person.x, z: person.z, heading, isWalking: false };
      situation.current = isTalking.current ? { state: "speaking" } : { state: "standing", activity: person.activity };
    } else if (person.kind === "walker" && loop) {
      const step = walkerPose(person, loop, time);
      carrying.current = carriedAt(person, step);
      pose = step;
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
  const carries = (person.kind === "walker" && person.carries) || (person.kind === "standing" && person.holds);
  return (
    <group ref={body} name={person.id}>
      <Suspense fallback={<StandIn isSeated={isSeated} />}>
        <Avatar id={person.avatar} motion={motion} carried={carries ? () => carrying.current : undefined} />
      </Suspense>
      {person.kind === "messenger" && <SpeechBubble name={person.name} text={visit.message?.text ?? null} isShown={visit.isArrived} y={HEAD_HEIGHT + 0.26} />}
      {conversation && <SpeechBubble name={conversation.name} text={conversation.line} isShown={always} y={(isSeated ? SEATED_HEAD : HEAD_HEIGHT) + 0.26} />}
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

/** Standing, the laptop is held at chest height; seated, it's open on the desk in front of them. */
const LAPTOP_IN_HANDS = [0, 1.08, 0.3] as const;
const LAPTOP_ON_DESK = [0, 0.76, 0.42] as const;
/** A seated head sits lower, and so does the name tag above it. */
const SEATED_TAG_DROP = 0.42;

function statusOf(position: Teammate["position"]): string | null {
  if (position?.isOnLaptop) return "on laptop";
  return position?.stance === "seated" ? "at their desk" : null;
}

function TeammateModel({ teammate, reduceMotion }: { teammate: Teammate; reduceMotion: boolean }) {
  const body = useRef<Group>(null);
  const target = teammate.position;
  const isSeated = target?.stance === "seated";
  const isOnLaptop = target?.isOnLaptop ?? false;
  const follower = useRef<Follower>({ x: target?.x ?? 0, z: target?.z ?? 0, speed: 0 });
  // Levels refresh several times a second; read them per frame instead of re-rendering the body.
  const levels = useSpeakingLevels();
  const levelsRef = useRef(levels);
  useEffect(() => {
    levelsRef.current = levels;
  }, [levels]);
  const badge = teammate.badge === null ? undefined : badgeById(teammate.badge);
  const status = statusOf(target);
  const tag = useMemo(() => {
    const line = [teammate.roleLabel, status, badge?.title].filter(Boolean).join(" · ");
    const title = [teammate.name, ...knownTags(teammate.tags).map((tag) => tag.label)].join(" · ");
    return badge ? bubbleTexture(title, line, { glyph: badge.glyph, colorToken: `--color-tier-${badge.tier}` }) : bubbleTexture(title, line);
  }, [badge, status, teammate.name, teammate.roleLabel, teammate.tags]);
  useEffect(() => () => tag.dispose(), [tag]);
  const motion = () => {
    const { speed } = follower.current;
    if (isSeated) return motionFor({ state: "seated" }, 0, reduceMotion);
    if (speed > STILL_SPEED) return motionFor({ state: "walking", speed }, 0, reduceMotion);
    return motionFor({ state: "standing", activity: isOnLaptop ? "on-laptop" : "waiting" }, 0, reduceMotion);
  };

  useFrame((_, delta) => {
    const group = body.current;
    if (!group || !target) return;
    // Presence arrives a few times a second; easing toward it makes movement read as walking, and gives the legs a real speed.
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
        <Avatar id={wornAvatar(teammate.avatar, teammate.id)} motion={motion} carried={() => target?.holding ?? null} />
      </Suspense>
      <SpeakingRing level={() => levelsRef.current.get(teammate.id) ?? 0} />
      {isOnLaptop && <HeldLaptop position={isSeated ? LAPTOP_ON_DESK : LAPTOP_IN_HANDS} />}
      <sprite position={[0, HEAD_HEIGHT + 0.37 - (isSeated ? SEATED_TAG_DROP : 0), 0]} scale={[0.3 * aspect, 0.3, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}
