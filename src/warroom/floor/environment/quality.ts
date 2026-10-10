/** How much the GPU is asked to do. High: shadows, ambient occlusion, bloom, sharp DPR. Low: none of that. */
export type Quality = "high" | "low";

export type QualitySettings = {
  readonly dpr: readonly [number, number];
  readonly hasShadows: boolean;
  readonly hasEffects: boolean;
};

export const QUALITY: Readonly<Record<Quality, QualitySettings>> = {
  high: { dpr: [1, 2], hasShadows: true, hasEffects: true },
  low: { dpr: [1, 1], hasShadows: false, hasEffects: false },
};

export type DeviceHints = { readonly isCoarsePointer: boolean; readonly cores: number };

/** Phones and small machines start low; the performance monitor can only ever step down from here. */
export function startingQuality({ isCoarsePointer, cores }: DeviceHints): Quality {
  return isCoarsePointer || cores < 6 ? "low" : "high";
}

export function readDeviceHints(): DeviceHints {
  return { isCoarsePointer: window.matchMedia("(pointer: coarse)").matches, cores: navigator.hardwareConcurrency || 4 };
}

/** Development only: `?quality=high|low` pins the tier (headless capture runs at 1 FPS and would always step down). */
export function pinnedQuality(): Quality | null {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(window.location.search).get("quality");
  return value === "high" || value === "low" ? value : null;
}
