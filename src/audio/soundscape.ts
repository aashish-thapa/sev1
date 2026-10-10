import { clamp01 } from "./synth.ts";

export type Zone = "desk" | "corridor" | "data-centre" | "meeting" | "other";

export type SoundscapeState = {
  /** 0 = calm, 1 = everything is on fire. The game drives this from the live error rate. */
  readonly panic: number;
  readonly zone: Zone;
  readonly isLaptopOpen: boolean;
  readonly rackProximity: number;
};

/** Target levels (0..1) for each bed; the hook ramps toward them. */
export type SoundscapeMix = {
  readonly ambience: number;
  readonly serverHum: number;
  readonly rackProximity: number;
  readonly alarm: number;
  readonly alarmIntensity: number;
  readonly heartbeat: number;
  readonly heartbeatBpm: number | null;
};

type ZoneAcoustics = {
  readonly ambience: number;
  readonly serverHum: number;
  /** How much of the data-centre siren reaches this zone through walls and doors. */
  readonly alarmReach: number;
};

const ZONES: Readonly<Record<Zone, ZoneAcoustics>> = {
  desk: { ambience: 0.6, serverHum: 0.05, alarmReach: 0.55 },
  corridor: { ambience: 0.45, serverHum: 0.15, alarmReach: 0.7 },
  "data-centre": { ambience: 0.12, serverHum: 0.8, alarmReach: 1 },
  meeting: { ambience: 0.3, serverHum: 0.03, alarmReach: 0.4 },
  other: { ambience: 0.4, serverHum: 0.08, alarmReach: 0.6 },
};

/** Below this the incident is effectively resolved and the siren is off. */
const ALARM_THRESHOLD = 0.05;
const HEARTBEAT_THRESHOLD = 0.35;
const RESTING_BPM = 72;
const PANIC_BPM = 130;
/** Looking at the laptop narrows attention: the room recedes, the pulse comes forward. */
const LAPTOP_ROOM_FACTOR = 0.75;
const LAPTOP_HEARTBEAT_BOOST = 0.1;

export function soundscapeFor(state: SoundscapeState): SoundscapeMix {
  const panic = clamp01(state.panic);
  const zone = ZONES[state.zone];
  const room = state.isLaptopOpen ? LAPTOP_ROOM_FACTOR : 1;
  const rackProximity = state.zone === "data-centre" ? clamp01(state.rackProximity) : 0;

  const alarmIntensity = panic <= ALARM_THRESHOLD ? 0 : 0.15 + 0.85 * easeIn(panic);
  const heartbeatDrive = panic < HEARTBEAT_THRESHOLD ? null : (panic - HEARTBEAT_THRESHOLD) / (1 - HEARTBEAT_THRESHOLD);

  return {
    // People talk more, and louder, as the floor notices something is wrong.
    ambience: zone.ambience * (1 + 0.25 * panic) * room,
    serverHum: Math.min(1, (zone.serverHum + 0.2 * rackProximity) * room),
    rackProximity,
    alarm: alarmIntensity * zone.alarmReach * room,
    alarmIntensity,
    heartbeat:
      heartbeatDrive === null ? 0 : Math.min(1, 0.25 + 0.6 * heartbeatDrive + (state.isLaptopOpen ? LAPTOP_HEARTBEAT_BOOST : 0)),
    heartbeatBpm: heartbeatDrive === null ? null : Math.round(RESTING_BPM + (PANIC_BPM - RESTING_BPM) * heartbeatDrive),
  };
}

/** Quadratic ease-in: panic is felt late, then fast. */
function easeIn(value: number): number {
  return value * value;
}
