import { NAV_EDGES, NAV_NODES, type NavNode } from "./office.ts";

export type Point = { readonly x: number; readonly z: number };

const byId = new Map(NAV_NODES.map((node) => [node.id, node]));
const neighbours = new Map<string, string[]>();
for (const [a, b] of NAV_EDGES) {
  neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
  neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
}

export function navNode(id: string): NavNode {
  const found = byId.get(id);
  if (!found) throw new Error(`unknown nav node ${id}`);
  return found;
}

export function nearestNode(point: Point): NavNode {
  let best = NAV_NODES[0];
  let bestDistance = Infinity;
  for (const candidate of NAV_NODES) {
    const distance = Math.hypot(candidate.x - point.x, candidate.z - point.z);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Shortest walk between two nav nodes (Dijkstra over the corridor graph). */
export function route(fromId: string, toId: string): Point[] {
  const distance = new Map<string, number>([[fromId, 0]]);
  const previous = new Map<string, string>();
  const open = new Set([fromId]);
  while (open.size > 0) {
    const current = [...open].reduce((best, id) => ((distance.get(id) ?? Infinity) < (distance.get(best) ?? Infinity) ? id : best));
    open.delete(current);
    if (current === toId) break;
    for (const next of neighbours.get(current) ?? []) {
      const step = Math.hypot(navNode(current).x - navNode(next).x, navNode(current).z - navNode(next).z);
      const candidate = (distance.get(current) ?? Infinity) + step;
      if (candidate < (distance.get(next) ?? Infinity)) {
        distance.set(next, candidate);
        previous.set(next, current);
        open.add(next);
      }
    }
  }
  if (!distance.has(toId)) throw new Error(`no route from ${fromId} to ${toId}`);
  const path: Point[] = [];
  for (let id: string | undefined = toId; id; id = previous.get(id)) {
    const { x, z } = navNode(id);
    path.unshift({ x, z });
  }
  return path;
}

/** A closed loop through `stops`, pausing at each one. */
export type Loop = {
  readonly points: readonly Point[];
  readonly pauses: readonly number[];
  readonly length: number;
  readonly duration: number;
  /** The point index each stop starts at, in stop order. */
  readonly stopPoints: readonly number[];
};

export const WALK_SPEED = 1.25;

/** How far right of a nav edge's centreline people walk, so oncoming traffic passes side by side. */
export const LANE_OFFSET = 0.35;

function rightOf(from: Point, to: Point): Point {
  const length = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  return { x: -(to.z - from.z) / length, z: (to.x - from.x) / length };
}

/**
 * Shifts a polyline into its keep-right lane. Each corner splits into the end of the
 * incoming lane and the start of the outgoing one (a bevel), so U-turns stay finite.
 * Returns, for every input point, the index of its first output point.
 */
function keepRight(points: readonly Point[], isClosed: boolean): { points: Point[]; firstOf: number[] } {
  const out: Point[] = [];
  const firstOf: number[] = [];
  const count = points.length;
  points.forEach((point, index) => {
    firstOf.push(out.length);
    const previous = isClosed ? points[(index - 1 + count) % count] : points[index - 1];
    const next = isClosed ? points[(index + 1) % count] : points[index + 1];
    if (!isClosed && (index === 0 || index === count - 1)) {
      out.push(point);
      return;
    }
    const incoming = rightOf(previous, point);
    const outgoing = rightOf(point, next);
    out.push({ x: point.x + incoming.x * LANE_OFFSET, z: point.z + incoming.z * LANE_OFFSET });
    if (Math.hypot(incoming.x - outgoing.x, incoming.z - outgoing.z) > 1e-3) {
      out.push({ x: point.x + outgoing.x * LANE_OFFSET, z: point.z + outgoing.z * LANE_OFFSET });
    }
  });
  return { points: out, firstOf };
}

/** A one-way walk in the keep-right lane; the start and end stay exactly where asked. */
export function walkingPath(path: readonly Point[]): Point[] {
  return keepRight(path, false).points;
}

export function loopThrough(stops: readonly { node: string; pause: number }[]): Loop {
  const centreline: Point[] = [];
  const stopPauses: number[] = [];
  const stopCentrelineIndex: number[] = [];
  stops.forEach((stop, index) => {
    const next = stops[(index + 1) % stops.length];
    const leg = route(stop.node, next.node);
    stopCentrelineIndex.push(centreline.length);
    leg.slice(0, -1).forEach((point, legIndex) => {
      centreline.push(point);
      stopPauses.push(legIndex === 0 ? stop.pause : 0);
    });
  });
  const lane = keepRight(centreline, true);
  const points = lane.points;
  const pauses = points.map(() => 0);
  lane.firstOf.forEach((outIndex, index) => {
    pauses[outIndex] = stopPauses[index];
  });
  let length = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    length += Math.hypot(next.x - point.x, next.z - point.z);
  });
  const duration = length / WALK_SPEED + pauses.reduce((sum, pause) => sum + pause, 0);
  return { points, pauses, length, duration, stopPoints: stopCentrelineIndex.map((index) => lane.firstOf[index]) };
}

/** Where a looping walker is at `seconds`, and which way they face. */
export type LoopPose = {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly isWalking: boolean;
  /** The stop most recently reached (paused at, or walking away from), as an index into the loop's stops. */
  readonly lastStop: number;
};

export function positionOnLoop(loop: Loop, seconds: number): LoopPose {
  let remaining = ((seconds % loop.duration) + loop.duration) % loop.duration;
  for (let index = 0; index < loop.points.length; index += 1) {
    const from = loop.points[index];
    const to = loop.points[(index + 1) % loop.points.length];
    const heading = Math.atan2(to.x - from.x, to.z - from.z);
    if (remaining < loop.pauses[index]) return { x: from.x, z: from.z, heading, isWalking: false, lastStop: stopReached(loop, index) };
    remaining -= loop.pauses[index];
    const legTime = Math.hypot(to.x - from.x, to.z - from.z) / WALK_SPEED;
    if (remaining < legTime) {
      const ratio = remaining / legTime;
      return { x: from.x + (to.x - from.x) * ratio, z: from.z + (to.z - from.z) * ratio, heading, isWalking: true, lastStop: stopReached(loop, index) };
    }
    remaining -= legTime;
  }
  const last = loop.points[0];
  return { x: last.x, z: last.z, heading: 0, isWalking: false, lastStop: 0 };
}

/** Which stop a walker on point `index` last left or is standing at. */
function stopReached(loop: Loop, index: number): number {
  let reached = loop.stopPoints.length - 1;
  loop.stopPoints.forEach((point, stop) => {
    if (point <= index) reached = stop;
  });
  return reached;
}

/** Walk a one-way path; returns the point reached after `seconds`, clamped at the end. */
export function positionOnPath(path: readonly Point[], seconds: number): { x: number; z: number; heading: number; isWalking: boolean } {
  let remaining = seconds * WALK_SPEED;
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    const legLength = Math.hypot(to.x - from.x, to.z - from.z);
    const heading = Math.atan2(to.x - from.x, to.z - from.z);
    if (remaining <= legLength) {
      const ratio = legLength === 0 ? 1 : remaining / legLength;
      return { x: from.x + (to.x - from.x) * ratio, z: from.z + (to.z - from.z) * ratio, heading, isWalking: true };
    }
    remaining -= legLength;
  }
  const end = path.at(-1) ?? { x: 0, z: 0 };
  const before = path.at(-2) ?? end;
  return { x: end.x, z: end.z, heading: Math.atan2(end.x - before.x, end.z - before.z), isWalking: false };
}
