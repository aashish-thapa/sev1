import type { Platform } from "./commerce.ts";

/** App Store Connect's 7-day phased release schedule (share of automatic updates offered). */
const PHASED_PERCENT = [1, 2, 5, 10, 20, 50, 100];

/** One second of a platform's rollout: how far `current` has spread through its sessions. */
export function stepRollout(platform: Platform): Platform {
  const { rollout } = platform;
  switch (rollout.kind) {
    case "instant":
      return platform;
    case "phased":
      if (rollout.isPaused || platform.adoption >= 1) return platform;
      return { ...platform, adoption: Math.min(1, platform.adoption + rollout.adoptionPerSecond) };
  }
}

/** How a release console describes the rollout. */
export function rolloutLabel(platform: Platform): string {
  const { rollout } = platform;
  switch (rollout.kind) {
    case "instant":
      return "released (100%)";
    case "phased": {
      const percentToday = PHASED_PERCENT[Math.min(rollout.day, PHASED_PERCENT.length) - 1];
      return `phased${rollout.isPaused ? " · PAUSED" : ""} · day ${rollout.day}/7 (${percentToday}%)`;
    }
  }
}
