import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group, MeshBasicMaterial } from "three";
import { coffeeBrew, getAudio } from "../../../audio/index.ts";
import { COUNTER_TOP, cupSpot, machineFrame } from "../environment/coffeeMachine.ts";
import { loopThrough, type Point } from "../navigation.ts";
import { FURNITURE, PEOPLE, type Person } from "../office.ts";
import { isAtPantry, walkerPose } from "../people/walkers.ts";
import { Steam } from "../interactions/Steam.tsx";
import { tokenColor } from "../tokens.ts";
import { PaperCup } from "./Items.tsx";

const MACHINE = FURNITURE.find((item) => item.kind === "coffee");
type Walker = Extract<Person, { kind: "walker" }>;
const COFFEE_RUNNERS = PEOPLE.filter((person): person is Walker => person.kind === "walker" && person.carries?.from === "kitchen:coffee");
/** Close enough to hear the grinder over the office. */
const HEARING_METRES = 7;

type Props = {
  getPlayer: () => Point;
  /** Your own cup is brewing: the machine is busy for you too (your cup is drawn elsewhere). */
  isPlayerBrewing: boolean;
  reduceMotion: boolean;
};

/** The coffee machine working for a colleague: their cup under the spout, steam, the busy light, and the sound if you're near. */
export function MachineAtWork({ getPlayer, isPlayerBrewing, reduceMotion }: Props) {
  const runners = useMemo(() => COFFEE_RUNNERS.map((walker) => ({ walker, loop: loopThrough(walker.stops) })), []);
  const theirs = useRef<Group>(null);
  const light = useRef<MeshBasicMaterial>(null);
  const wasBusy = useRef(false);
  const busyColor = tokenColor("--color-accent");

  useFrame(({ clock }) => {
    if (!MACHINE) return;
    const isColleagueBrewing = runners.some(({ walker, loop }) => isAtPantry(walker, walkerPose(walker, loop, clock.elapsedTime)));
    if (theirs.current) theirs.current.visible = isColleagueBrewing && !isPlayerBrewing;
    const isBusy = isColleagueBrewing || isPlayerBrewing;
    if (light.current) light.current.opacity = isBusy ? (reduceMotion ? 0.9 : 0.55 + 0.4 * Math.sin(clock.elapsedTime * 5)) : 0;
    if (isColleagueBrewing && !wasBusy.current) {
      const player = getPlayer();
      if (Math.hypot(player.x - MACHINE.footprint.x, player.z - MACHINE.footprint.z) < HEARING_METRES) coffeeBrew(getAudio().engine);
    }
    wasBusy.current = isColleagueBrewing;
  });

  if (!MACHINE) return null;
  const spot = cupSpot(MACHINE.footprint);
  const { face } = machineFrame(MACHINE.footprint);
  const tall = MACHINE.height - COUNTER_TOP;
  return (
    <>
      <group ref={theirs} visible={false} position={[spot.x, spot.y, spot.z]}>
        <PaperCup />
        <Steam origin={[0, 0.12, 0]} spread={0.015} rise={0.22} puffs={8} size={0.05} reduceMotion={reduceMotion} />
      </group>
      {/* A busy light just under the display. */}
      <mesh position={[face - 0.022, COUNTER_TOP + tall * 0.66, MACHINE.footprint.z]} rotation={[0, -Math.PI / 2, 0]}>
        <circleGeometry args={[0.008, 16]} />
        <meshBasicMaterial ref={light} color={busyColor} transparent opacity={0} toneMapped={false} />
      </mesh>
    </>
  );
}
