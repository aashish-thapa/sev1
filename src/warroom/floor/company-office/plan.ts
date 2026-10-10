/**
 * What a company's office holds: only the rooms it bought. Each open-plan bay is one desk cluster
 * (the one nearest your usual desk first) with a one-rack closet beside it; a server room opens the
 * data centre and racks its servers along the back wall. Pure: the floor draws whatever this says.
 */
import { roomKindById, type RoomKindId, type ServerTierId } from "../../../domain/company/catalog.ts";
import type { Company } from "../../../storage/company-protocol.ts";
import { CLUSTERS, DATACENTRE_DOOR, DESKS, desksOf, officeObstacles, PLAYER_DESK, type Desk, type DeskCluster } from "../office.ts";
import type { Footprint } from "../layout.ts";

export type OfficeRack = {
  readonly key: string;
  readonly footprint: Footprint;
  /** Which way the rack's front points along z. */
  readonly front: 1 | -1;
  /** The server racked here, if any. */
  readonly server: ServerTierId | null;
};

export type OfficePlan = {
  /** False in a company office: nobody works there but its members. */
  readonly hasColleagues: boolean;
  readonly clusters: readonly DeskCluster[];
  readonly desks: readonly Desk[];
  /** Each member's own desk, founder first, then in the order they joined. */
  readonly memberDesks: ReadonlyMap<string, Desk>;
  /** Closed off (dark glass, door shut) until the company buys a server room. */
  readonly isDataCentreOpen: boolean;
  /** The company's own racks: bay closets first, then the server room's. */
  readonly racks: readonly OfficeRack[];
};

/** The whole building, as job mode and ordinary team rooms use it. */
export const FULL_OFFICE: OfficePlan = {
  hasColleagues: true,
  clusters: CLUSTERS,
  desks: DESKS,
  memberDesks: new Map(),
  isDataCentreOpen: true,
  racks: [],
};

export type CompanyLayout = Pick<Company, "rooms" | "servers" | "members">;

const RACK = { width: 0.8, depth: 1.1 } as const;
/** Desks per cluster: a bay's four seats fill exactly one. */
const SEATS_PER_CLUSTER = 4;
/** The data centre's back wall row, clear of every scenario's racks. */
const SERVER_ROW = { x: -9.5, z: -13.6, pitch: 1.05 } as const;
/** Closets sit by the aisle in front of a cluster: toward the corridor for the front row, the window for the back. */
const CLOSET_Z = { front: 4.95, back: 14.4 } as const;

const homeCluster = CLUSTERS.find((cluster) => desksOf(cluster).some((desk) => desk.id === PLAYER_DESK.id)) ?? CLUSTERS[0];

/** Clusters nearest your usual desk first, so a one-bay company sits where everyone always does. */
const CLUSTERS_BY_NEARNESS = [...CLUSTERS].sort(
  (a, b) => Math.hypot(a.x - homeCluster.x, a.z - homeCluster.z) - Math.hypot(b.x - homeCluster.x, b.z - homeCluster.z),
);

/** Within a cluster, your usual desk first, so the founder always sits where the player always has. */
function deskOrder(cluster: DeskCluster): Desk[] {
  const desks = desksOf(cluster);
  return [...desks.filter((desk) => desk.id === PLAYER_DESK.id), ...desks.filter((desk) => desk.id !== PLAYER_DESK.id)];
}

function closetRack(cluster: DeskCluster, index: number): Omit<OfficeRack, "server"> {
  const isFrontRow = cluster.z < homeCluster.z + 2;
  return {
    key: `closet:${index}`,
    footprint: { x: cluster.x, z: isFrontRow ? CLOSET_Z.front : CLOSET_Z.back, ...RACK },
    front: isFrontRow ? 1 : -1,
  };
}

export function officePlan(company: CompanyLayout | null): OfficePlan {
  if (!company) return FULL_OFFICE;
  const rooms = company.rooms.map((id: RoomKindId) => roomKindById(id));
  const seats = rooms.reduce((sum, room) => sum + room.seats, 0);
  const clusters = CLUSTERS_BY_NEARNESS.slice(0, Math.min(CLUSTERS.length, Math.ceil(seats / SEATS_PER_CLUSTER)));
  const desks = clusters.flatMap(deskOrder);

  // Rooms with desks keep their racks in a closet by their cluster; rooms without desks are server rooms.
  const closetCount = rooms.filter((room) => room.seats > 0).reduce((sum, room) => sum + room.racks, 0);
  const hallCount = rooms.filter((room) => room.seats === 0).reduce((sum, room) => sum + room.racks, 0);
  const closets = Array.from({ length: closetCount }, (_, index) => closetRack(clusters[index % Math.max(1, clusters.length)] ?? homeCluster, index));
  const hall = Array.from({ length: hallCount }, (_, index) => ({
    key: `hall:${index}`,
    footprint: { x: SERVER_ROW.x + index * SERVER_ROW.pitch, z: SERVER_ROW.z, ...RACK },
    front: 1 as const,
  }));
  const racks = [...closets, ...hall].map((rack, index) => ({ ...rack, server: company.servers[index] ?? null }));

  const ordered = [...company.members].sort((a, b) => Number(b.isFounder) - Number(a.isFounder) || a.joinedAt - b.joinedAt);
  const memberDesks = new Map(ordered.flatMap((member, index) => (desks[index] ? [[member.username, desks[index]] as const] : [])));

  return { hasColleagues: false, clusters, desks, memberDesks, isDataCentreOpen: hallCount > 0, racks };
}

/** Your desk in this office: the one assigned to you, or the first desk when you aren't on the books. */
export function myDeskIn(plan: OfficePlan, username: string | null): Desk {
  const assigned = username ? plan.memberDesks.get(username) : undefined;
  if (assigned) return assigned;
  return plan.desks.some((desk) => desk.id === PLAYER_DESK.id) ? PLAYER_DESK : (plan.desks[0] ?? PLAYER_DESK);
}

/** What you walk into here: walls, the clusters that exist, the company's racks, and a shut data-centre door. */
export function planObstacles(plan: OfficePlan): Footprint[] {
  const door: Footprint[] = plan.isDataCentreOpen
    ? []
    : [{ x: (DATACENTRE_DOOR.fromX + DATACENTRE_DOOR.toX) / 2, z: DATACENTRE_DOOR.z, width: DATACENTRE_DOOR.toX - DATACENTRE_DOOR.fromX, depth: 0.2 }];
  return [...officeObstacles(plan.clusters), ...plan.racks.map((rack) => rack.footprint), ...door];
}
