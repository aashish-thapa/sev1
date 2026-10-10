import { useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, CanvasTexture, CylinderGeometry, MeshBasicMaterial, MeshStandardMaterial, SRGBColorSpace, type BufferGeometry, type InstancedMesh, type Material, type Matrix4 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { DESK, DESKS, seatOf, type Desk } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { FINISHES, type FinishMaterials } from "./finishes.ts";
import { MONITOR, MONITOR_Z, onDesk, SCREEN, SEAT_HEIGHT, TOP_THICKNESS } from "./deskLayout.ts";
import { worldBox } from "./worldUv.ts";

const DIVIDER = { height: 0.36, thickness: 0.028 } as const;

type Placed = { readonly desk: Desk; readonly matrix: Matrix4 };

/** Task chair, occupant facing +z: fabric seat and back, aluminium five-star base on casters. */
function chairGeometries(): { fabric: BufferGeometry; frame: BufferGeometry } {
  const at = (geometry: BufferGeometry, x: number, y: number, z: number, rotationY = 0, rotationX = 0) => {
    geometry.rotateX(rotationX);
    geometry.rotateY(rotationY);
    geometry.translate(x, y, z);
    return geometry;
  };
  const fabric = mergeGeometries([
    at(new BoxGeometry(0.5, 0.075, 0.48), 0, SEAT_HEIGHT, 0),
    at(new BoxGeometry(0.46, 0.52, 0.06), 0, SEAT_HEIGHT + 0.36, -0.27, 0, -0.12),
  ]);
  const legs = Array.from({ length: 5 }, (_, index) => {
    const angle = (index / 5) * Math.PI * 2;
    return [
      at(new BoxGeometry(0.04, 0.03, 0.32), Math.sin(angle) * 0.16, 0.08, Math.cos(angle) * 0.16, angle),
      at(new CylinderGeometry(0.025, 0.025, 0.04, 10).rotateZ(Math.PI / 2), Math.sin(angle) * 0.31, 0.03, Math.cos(angle) * 0.31, angle),
    ];
  }).flat();
  const frame = mergeGeometries([
    at(new CylinderGeometry(0.028, 0.028, SEAT_HEIGHT - 0.1, 12), 0, (SEAT_HEIGHT + 0.06) / 2, 0),
    at(new BoxGeometry(0.03, 0.3, 0.02), 0, SEAT_HEIGHT + 0.12, -0.25),
    ...legs,
  ]);
  return { fabric, frame };
}

/** Every desk, chair, monitor and keyboard in the building, as a handful of instanced meshes. */
export function Workstations({ finishes }: { finishes: FinishMaterials }) {
  const code = useMemo(() => codeTexture(), []);
  const materials = useMemo(() => {
    const fabricBase = finishes.carpet;
    return {
      aluminium: new MeshStandardMaterial({ color: tokenColor("--color-world-aluminium"), roughness: 0.32, metalness: 1 }),
      plastic: new MeshStandardMaterial({ color: tokenColor("--color-world-plastic"), roughness: 0.55 }),
      // The carpet scan's weave doubles as upholstery once it's dyed dark.
      fabric: new MeshStandardMaterial({ map: fabricBase.map, normalMap: fabricBase.normalMap, roughnessMap: fabricBase.roughnessMap, color: tokenColor("--color-world-fabric"), roughness: 1 }),
      screen: new MeshBasicMaterial({ map: code, toneMapped: false }),
    };
  }, [code, finishes.carpet]);
  useLayoutEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);

  const geometries = useMemo(() => {
    const chair = chairGeometries();
    return {
      top: worldBox(DESK.width, TOP_THICKNESS, DESK.depth, FINISHES.wood.tileMetres),
      leg: new BoxGeometry(0.05, DESK.height - TOP_THICKNESS, DESK.depth * 0.86),
      divider: new BoxGeometry(DESK.width, DIVIDER.height, DIVIDER.thickness),
      monitor: new BoxGeometry(MONITOR.width, MONITOR.height, MONITOR.depth),
      neck: new BoxGeometry(0.05, MONITOR.lift + MONITOR.height / 2, 0.025),
      foot: new BoxGeometry(0.24, 0.012, 0.17),
      screen: new BoxGeometry(SCREEN.width, SCREEN.height, 0.001),
      keyboard: new BoxGeometry(0.44, 0.016, 0.14),
      mouse: new BoxGeometry(0.06, 0.022, 0.1),
      chairFabric: chair.fabric,
      chairFrame: chair.frame,
    };
  }, []);
  useLayoutEffect(() => () => Object.values(geometries).forEach((geometry) => geometry.dispose()), [geometries]);

  const parts = useMemo(() => {
    const surface = DESK.height;
    // Occupant-relative offsets: +dz is away from the occupant, toward the shared middle of the cluster.
    const monitorZ = MONITOR_Z;
    const each = (dx: number, y: number, dz: number): Placed[] => DESKS.map((desk) => ({ desk, matrix: onDesk(desk, dx, y, dz) }));
    return {
      top: each(0, surface - TOP_THICKNESS / 2, 0),
      legs: [...each(-(DESK.width / 2 - 0.04), (surface - TOP_THICKNESS) / 2, 0), ...each(DESK.width / 2 - 0.04, (surface - TOP_THICKNESS) / 2, 0)],
      divider: each(0, surface + DIVIDER.height / 2, DESK.depth / 2 - DIVIDER.thickness / 2),
      monitor: each(0, surface + MONITOR.lift + MONITOR.height / 2, monitorZ),
      screen: each(0, surface + MONITOR.lift + MONITOR.height / 2, monitorZ - MONITOR.depth / 2 - 0.001),
      neck: each(0, surface + (MONITOR.lift + MONITOR.height / 2) / 2, monitorZ + 0.03),
      foot: each(0, surface + 0.006, monitorZ + 0.02),
      keyboard: each(0, surface + 0.008, -0.12),
      mouse: each(0.3, surface + 0.011, -0.12),
      chair: DESKS.map((desk) => {
        const seat = seatOf(desk);
        return { desk, matrix: onDesk(desk, 0, 0, (seat.z - desk.z) * desk.facing) };
      }),
    };
  }, []);

  return (
    <>
      <Instanced geometry={geometries.top} material={finishes.wood} placed={parts.top} />
      <Instanced geometry={geometries.leg} material={materials.aluminium} placed={parts.legs} />
      <Instanced geometry={geometries.divider} material={materials.fabric} placed={parts.divider} />
      <Instanced geometry={geometries.monitor} material={materials.plastic} placed={parts.monitor} />
      <Instanced geometry={geometries.neck} material={materials.aluminium} placed={parts.neck} />
      <Instanced geometry={geometries.foot} material={materials.aluminium} placed={parts.foot} />
      <Instanced geometry={geometries.screen} material={materials.screen} placed={parts.screen} hasShadow={false} />
      <Instanced geometry={geometries.keyboard} material={materials.plastic} placed={parts.keyboard} />
      <Instanced geometry={geometries.mouse} material={materials.plastic} placed={parts.mouse} />
      <Instanced geometry={geometries.chairFabric} material={materials.fabric} placed={parts.chair} />
      <Instanced geometry={geometries.chairFrame} material={materials.aluminium} placed={parts.chair} />
    </>
  );
}

function Instanced({ geometry, material, placed, hasShadow = true }: { geometry: BufferGeometry; material: Material; placed: readonly Placed[]; hasShadow?: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    placed.forEach(({ matrix }, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placed]);
  return <instancedMesh ref={ref} args={[geometry, material, placed.length]} castShadow={hasShadow} receiveShadow={hasShadow} />;
}

/** An editor full of code, drawn once and shared by every monitor in the building. */
function codeTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 300;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  context.fillStyle = token("--color-terminal");
  context.fillRect(0, 0, 512, 300);
  // A sidebar and a tab strip read as an IDE from across the room.
  context.fillStyle = token("--color-paper-2");
  context.fillRect(0, 0, 92, 300);
  context.fillRect(92, 0, 420, 20);
  const palette = [token("--color-ink-2"), token("--color-accent"), token("--color-good"), token("--color-muted")];
  let seed = 7;
  const next = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let line = 0; line < 24; line += 1) {
    context.fillStyle = token("--color-muted");
    context.fillRect(10, 30 + line * 11, 40 + next() * 30, 4);
    let x = 106 + Math.floor(next() * 4) * 16;
    for (let word = 0; word < 1 + Math.floor(next() * 5); word += 1) {
      const width = 16 + next() * 60;
      context.fillStyle = palette[Math.floor(next() * palette.length)];
      context.fillRect(x, 30 + line * 11, width, 5);
      x += width + 8;
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
