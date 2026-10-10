import { describe, expect, it } from "vitest";
import { BUILDING, deskClusterFootprints, FURNITURE, wallFootprints } from "../office.ts";
import type { Footprint } from "../layout.ts";
import { FURNISHING, furnishingFootprints, PROP_FIT } from "./furnishing.ts";
import { worldBox, worldPlane } from "./worldUv.ts";

const overlaps = (a: Footprint, b: Footprint) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2;

describe("furnishing", () => {
  it("keeps every prop inside the building", () => {
    for (const { prop, x, z } of FURNISHING) {
      expect(x, prop).toBeGreaterThan(BUILDING.minX);
      expect(x, prop).toBeLessThan(BUILDING.maxX);
      expect(z, prop).toBeGreaterThan(BUILDING.minZ);
      expect(z, prop).toBeLessThan(BUILDING.maxZ);
    }
  });

  it("stands floor props clear of walls, desks, fittings and each other", () => {
    const fixed = [...wallFootprints(), ...deskClusterFootprints(), ...FURNITURE.map((item) => item.footprint)];
    const props = furnishingFootprints();
    props.forEach((box, index) => {
      expect(fixed.find((other) => overlaps(box, other)), `prop at ${box.x},${box.z} clips a fixed obstacle`).toBeUndefined();
      expect(props.find((other, otherIndex) => otherIndex !== index && overlaps(box, other)), `props overlap at ${box.x},${box.z}`).toBeUndefined();
    });
  });

  it("gives off-floor props no footprint and turns footprints with their prop", () => {
    expect(furnishingFootprints([{ prop: "wall-clock", x: 0, z: 0, y: 2.6, turns: 0 }])).toEqual([]);
    expect(furnishingFootprints([{ prop: "plant-small", x: 0, z: 0, y: 0.76, turns: 0 }])).toEqual([]);
    const [width, depth] = PROP_FIT.sofa.footprint ?? [0, 0];
    expect(furnishingFootprints([{ prop: "sofa", x: 1, z: 2, y: 0, turns: 1 }])).toEqual([{ x: 1, z: 2, width: depth, depth: width }]);
  });
});

describe("world-scale UVs", () => {
  it("measures plane UVs in tiles", () => {
    const uv = worldPlane(4, 2, 0.5).getAttribute("uv");
    const us = Array.from({ length: uv.count }, (_, index) => uv.getX(index));
    const vs = Array.from({ length: uv.count }, (_, index) => uv.getY(index));
    expect(Math.max(...us)).toBeCloseTo(8);
    expect(Math.max(...vs)).toBeCloseTo(4);
  });

  it("scales each box face by its own size", () => {
    const uv = worldBox(4, 3, 0.2, 1).getAttribute("uv");
    const faceMaxU = (face: number) => Math.max(...[0, 1, 2, 3].map((corner) => uv.getX(face * 4 + corner)));
    expect(faceMaxU(0)).toBeCloseTo(0.2);
    expect(faceMaxU(4)).toBeCloseTo(4);
  });
});
