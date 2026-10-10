import { useTexture } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, Vector2, type Texture } from "three";
import { assetPath } from "../assets/catalog.ts";
import { tokenColor } from "../tokens.ts";
import { FINISHES, type Finish, type FinishName } from "./finishes.ts";
import { assetUrl } from "../assets/url.ts";

const MAX_ANISOTROPY = 8;

const keyOf = (name: FinishName, map: string) => `${name}:${map}`;

const URLS: Record<string, string> = Object.fromEntries(
  (Object.entries(FINISHES) as [FinishName, Finish][]).flatMap(([name, finish]) =>
    finish.maps.map((map) => [keyOf(name, map), assetUrl(assetPath.surface(finish.surface, map))]),
  ),
);

/** One PBR material per finish, shared by every floor, wall and ceiling that uses it. Suspends while maps load. */
export function useFinishes(): Readonly<Record<FinishName, MeshStandardMaterial>> {
  const textures = useTexture(URLS) as Record<string, Texture>;
  const anisotropy = useThree((state) => Math.min(MAX_ANISOTROPY, state.gl.capabilities.getMaxAnisotropy()));
  const materials = useMemo(() => {
    for (const [key, texture] of Object.entries(textures)) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = anisotropy;
      if (key.endsWith(":color")) texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
    }
    const entries = (Object.entries(FINISHES) as [FinishName, Finish][]).map(([name, finish]) => {
      const map = (kind: string) => textures[keyOf(name, kind)] ?? null;
      const material = new MeshStandardMaterial({
        map: map("color"),
        normalMap: map("normal"),
        normalScale: new Vector2(finish.normalScale, finish.normalScale),
        roughnessMap: map("roughness"),
        aoMap: map("ao"),
        ...(finish.paint ? { color: tokenColor(finish.paint) } : {}),
        roughness: 1,
        metalness: 0,
      });
      return [name, material] as const;
    });
    return Object.fromEntries(entries) as Record<FinishName, MeshStandardMaterial>;
  }, [textures, anisotropy]);
  useEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);
  return materials;
}
