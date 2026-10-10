import { MeshStandardMaterial } from "three";
import { tokenColor } from "../tokens.ts";
import type { FinishMaterials } from "./finishes.ts";

/** Untextured stand-ins drawn while the scanned surfaces stream in, so the building never vanishes. */
export function flatFinishes(): FinishMaterials {
  const flat = (token: string, roughness: number) => new MeshStandardMaterial({ color: tokenColor(token), roughness });
  return {
    carpet: flat("--color-world-carpet", 0.95),
    wood: flat("--color-world-wood", 0.6),
    raised: flat("--color-world-raised", 0.6),
    stone: flat("--color-world-tile", 0.5),
    plaster: flat("--color-world-wall", 0.92),
    ceiling: flat("--color-world-ceiling", 1),
  };
}
