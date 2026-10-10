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
export type Loop = { readonly points: readonly Point[]; readonly pauses: readonly number[]; readonly length: number; readonly duration: number };

export const WALK_SPEED = 1.25;

export function loopThrough(stops: readonly { node: string; pause: number }[]): Loop {
  const points: Point[] = [];
  const pauses: number[] = [];
  stops.forEach((stop, index) => {
    const next = stops[(index + 1) % stops.length];
    const leg = route(stop.node, next.node);
    leg.slice(0, -1).forEach((point, legIndex) => {
      points.push(point);
      pauses.push(legIndex === 0 ? stop.pause : 0);
    });
  });
  let length = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    length += Math.hypot(next.x - point.x, next.z - point.z);
  });
  const duration = length / WALK_SPEED + pauses.reduce((sum, pause) => sum + pause, 0);
  return { points, pauses, length, duration };
}

/** Where a looping walker is at `seconds`, and which way they face. */
export function positionOnLoop(loop: Loop, seconds: number): { x: number; z: number; heading: number; isWalking: boolean } {
  let remaining = ((seconds % loop.duration) + loop.duration) % loop.duration;
  for (let index = 0; index < loop.points.length; index += 1) {
    const from = loop.points[index];
    const to = loop.points[(index + 1) % loop.points.length];
    const heading = Math.atan2(to.x - from.x, to.z - from.z);
    if (remaining < loop.pauses[index]) return { x: from.x, z: from.z, heading, isWalking: false };
    remaining -= loop.pauses[index];
    const legTime = Math.hypot(to.x - from.x, to.z - from.z) / WALK_SPEED;
    if (remaining < legTime) {
      const ratio = remaining / legTime;
      return { x: from.x + (to.x - from.x) * ratio, z: from.z + (to.z - from.z) * ratio, heading, isWalking: true };
    }
    remaining -= legTime;
  }
  const last = loop.points[0];
  return { x: last.x, z: last.z, heading: 0, isWalking: false };
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
