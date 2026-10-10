import { BoxGeometry, PlaneGeometry, type BufferGeometry } from "three";

/**
 * Geometry whose UVs are measured in tiles of `tileMetres`, so one shared material
 * (RepeatWrapping) keeps planks, tiles and plaster at real size on surfaces of any size.
 */
export function worldPlane(width: number, depth: number, tileMetres: number): PlaneGeometry {
  const geometry = new PlaneGeometry(width, depth);
  scaleUv(geometry, 0, 4, width / tileMetres, depth / tileMetres);
  return geometry;
}

/** BoxGeometry face order is +x, -x, +y, -y, +z, -z; each face is four vertices. */
export function worldBox(width: number, height: number, depth: number, tileMetres: number): BoxGeometry {
  const geometry = new BoxGeometry(width, height, depth);
  const faceSizes: readonly (readonly [number, number])[] = [
    [depth, height],
    [depth, height],
    [width, depth],
    [width, depth],
    [width, height],
    [width, height],
  ];
  faceSizes.forEach(([u, v], face) => scaleUv(geometry, face * 4, 4, u / tileMetres, v / tileMetres));
  return geometry;
}

function scaleUv(geometry: BufferGeometry, start: number, count: number, uScale: number, vScale: number): void {
  const uv = geometry.getAttribute("uv");
  for (let index = start; index < start + count; index += 1) uv.setXY(index, uv.getX(index) * uScale, uv.getY(index) * vScale);
  uv.needsUpdate = true;
}
