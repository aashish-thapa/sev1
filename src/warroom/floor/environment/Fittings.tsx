import { useLayoutEffect, useMemo } from "react";
import { MeshStandardMaterial, type Material } from "three";
import { FURNITURE, type Furniture } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { COUNTER_TOP, machineFrame } from "./coffeeMachine.ts";
import { FINISHES, type FinishMaterials, type FinishName } from "./finishes.ts";
import { worldBox } from "./worldUv.ts";

const WORKTOP = 0.035;
const LEG = 0.05;

type Kit = { finishes: FinishMaterials; aluminium: Material; plastic: Material; cabinet: Material };

/** Built-in fittings (meeting and kitchen tables, the kitchen run, fridge, coffee machine), drawn from boxes. */
export function Fittings({ finishes }: { finishes: FinishMaterials }) {
  const materials = useMemo(
    () => ({
      aluminium: new MeshStandardMaterial({ color: tokenColor("--color-world-aluminium"), roughness: 0.3, metalness: 1 }),
      plastic: new MeshStandardMaterial({ color: tokenColor("--color-world-plastic"), roughness: 0.45 }),
      cabinet: new MeshStandardMaterial({ color: tokenColor("--color-world-desk"), roughness: 0.4 }),
    }),
    [],
  );
  useLayoutEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);
  const kit: Kit = { finishes, ...materials };
  return (
    <>
      {FURNITURE.map((item, index) => (
        <Fitting key={index} item={item} kit={kit} />
      ))}
    </>
  );
}

function Slab({ width, height, depth, finish, material, position }: { width: number; height: number; depth: number; finish: FinishName; material: Material; position: [number, number, number] }) {
  const geometry = useMemo(() => worldBox(width, height, depth, FINISHES[finish].tileMetres), [width, height, depth, finish]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} material={material} position={position} castShadow receiveShadow />;
}

function Block({ size, material, position }: { size: [number, number, number]; material: Material; position: [number, number, number] }) {
  return (
    <mesh material={material} position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
    </mesh>
  );
}

function Fitting({ item, kit }: { item: Furniture; kit: Kit }) {
  const { footprint: box, height } = item;
  switch (item.kind) {
    case "table": {
      const inset = 0.12;
      const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [box.x + sx * (box.width / 2 - inset), box.z + sz * (box.depth / 2 - inset)] as const));
      return (
        <>
          <Slab width={box.width} height={WORKTOP} depth={box.depth} finish="wood" material={kit.finishes.wood} position={[box.x, height - WORKTOP / 2, box.z]} />
          {legs.map(([x, z]) => (
            <Block key={`${x}:${z}`} size={[LEG, height - WORKTOP, LEG]} material={kit.aluminium} position={[x, (height - WORKTOP) / 2, z]} />
          ))}
        </>
      );
    }
    case "counter":
      return (
        <>
          <Block size={[box.width - 0.04, height - WORKTOP, box.depth]} material={kit.cabinet} position={[box.x + 0.02, (height - WORKTOP) / 2, box.z]} />
          <Slab width={box.width} height={WORKTOP} depth={box.depth} finish="stone" material={kit.finishes.stone} position={[box.x, height - WORKTOP / 2, box.z]} />
        </>
      );
    case "fridge":
      return (
        <>
          <Block size={[box.width, height, box.depth]} material={kit.aluminium} position={[box.x, height / 2, box.z]} />
          <Block size={[0.03, 0.6, 0.03]} material={kit.plastic} position={[box.x - box.width / 2 - 0.02, height * 0.62, box.z + box.depth / 2 - 0.1]} />
        </>
      );
    case "coffee":
      return <CoffeeMachine box={box} height={height} kit={kit} />;
  }
}

/** A bean-to-cup machine: dark body, brushed front, a spout over the drip tray, a lit display, a bean hopper. */
function CoffeeMachine({ box, height, kit }: { box: Furniture["footprint"]; height: number; kit: Kit }) {
  const tall = height - COUNTER_TOP;
  const body = machineFrame(box);
  const { face } = body;
  const display = tokenColor("--color-good");
  const beans = tokenColor("--color-world-desk");
  const glass = tokenColor("--color-world-glass");
  return (
    <>
      <Block size={[body.width, tall * 0.92, 0.38]} material={kit.plastic} position={[body.x, COUNTER_TOP + (tall * 0.92) / 2, box.z]} />
      <Block size={[0.02, tall * 0.34, 0.34]} material={kit.aluminium} position={[face - 0.01, COUNTER_TOP + tall * 0.7, box.z]} />
      <Block size={[0.12, 0.05, 0.16]} material={kit.aluminium} position={[face - 0.06, COUNTER_TOP + tall * 0.47, box.z]} />
      <mesh material={kit.aluminium} position={[face - 0.08, COUNTER_TOP + tall * 0.4, box.z]}>
        <cylinderGeometry args={[0.012, 0.012, 0.05, 12]} />
      </mesh>
      <Block size={[0.16, 0.022, 0.3]} material={kit.aluminium} position={[face - 0.08, COUNTER_TOP + 0.011, box.z]} />
      <mesh position={[face - 0.021, COUNTER_TOP + tall * 0.76, box.z]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[0.12, 0.05]} />
        <meshBasicMaterial color={display} toneMapped={false} />
      </mesh>
      <mesh position={[body.x + 0.04, COUNTER_TOP + tall * 0.92 + 0.06, box.z]}>
        <cylinderGeometry args={[0.08, 0.07, 0.12, 20]} />
        <meshStandardMaterial color={glass} roughness={0.1} transparent opacity={0.45} />
      </mesh>
      <mesh position={[body.x + 0.04, COUNTER_TOP + tall * 0.92 + 0.035, box.z]}>
        <cylinderGeometry args={[0.068, 0.068, 0.06, 20]} />
        <meshStandardMaterial color={beans} roughness={0.8} />
      </mesh>
    </>
  );
}
