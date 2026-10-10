import type { Footprint } from "../layout.ts";

/** Counter height the machine stands on; its front (spout, tray, display) faces -x, into the kitchen. */
export const COUNTER_TOP = 0.95;
const BODY = { offset: 0.06, width: 0.4 } as const;

/** The machine body's centre x and the x of its front face, from the fitting's footprint. */
export function machineFrame(box: Footprint) {
  const x = box.x + BODY.offset;
  return { x, width: BODY.width, face: x - BODY.width / 2 };
}

/** Where a cup sits on the drip tray, under the spout. */
export function cupSpot(box: Footprint) {
  return { x: machineFrame(box).face - 0.08, y: COUNTER_TOP + 0.022, z: box.z };
}
