import { useGLTF } from "@react-three/drei";
import { useLayoutEffect, useMemo } from "react";
import { Box3, Matrix4, Mesh, MeshStandardMaterial, Vector3, type Object3D } from "three";
import { assetPath, PROP_NAMES, type PropName } from "../assets/catalog.ts";
import { BUILDING } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { FURNISHING, PROP_FIT, type Placement, type PropFit } from "./furnishing.ts";
import { assetUrl } from "../assets/url.ts";

/** Meshopt-compressed; nothing in the catalog uses Draco, so its decoder is never fetched. */
const USE_DRACO = false;
const GLOW_INTENSITY = 2.2;

const urlOf = (prop: PropName) => assetUrl(assetPath.prop(prop));

// Start every prop download as soon as the floor chunk loads, rather than one by one as each kind first renders.
for (const prop of PROP_NAMES) useGLTF.preload(urlOf(prop), USE_DRACO);

/** Every scanned prop placed in the office, one model download per kind, shared geometry per copy. */
export function Props({ hasShadows }: { hasShadows: boolean }) {
  const byProp = useMemo(() => {
    const groups = new Map<PropName, Placement[]>();
    for (const placement of FURNISHING) groups.set(placement.prop, [...(groups.get(placement.prop) ?? []), placement]);
    return [...groups];
  }, []);
  return (
    <>
      {byProp.map(([prop, placements]) => (
        <PropKind key={prop} prop={prop} placements={placements} hasShadows={hasShadows} />
      ))}
    </>
  );
}

type Fitted = { readonly scale: number; readonly offset: Vector3 };

/** Uniform scale to the fit height, and the shift that puts the model's anchor point at the origin. */
function fit(scene: Object3D, { height, anchor, tilt = 0 }: PropFit): Fitted {
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(scene).applyMatrix4(new Matrix4().makeRotationX(tilt));
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  const scale = height / size.y;
  const point =
    anchor === "floor" ? new Vector3(centre.x, box.min.y, centre.z) : anchor === "ceiling" ? new Vector3(centre.x, box.max.y, centre.z) : new Vector3(centre.x, centre.y, box.min.z);
  return { scale, offset: point.multiplyScalar(-scale) };
}

function PropKind({ prop, placements, hasShadows }: { prop: PropName; placements: readonly Placement[]; hasShadows: boolean }) {
  const { scene } = useGLTF(urlOf(prop), USE_DRACO);
  const spec = PROP_FIT[prop];
  const fitted = useMemo(() => fit(scene, spec), [scene, spec]);
  const copies = useMemo(
    () =>
      placements.map(() => {
        const copy = scene.clone(true);
        copy.traverse((child) => {
          child.castShadow = hasShadows;
          child.receiveShadow = hasShadows;
        });
        return copy;
      }),
    [scene, placements, hasShadows],
  );
  // Lamps' bulbs and globes are the light source; the cached materials are shared, so this happens once per kind.
  useLayoutEffect(() => {
    const fragment = spec.glow;
    if (!fragment) return;
    const glow = tokenColor("--color-world-ceiling");
    scene.traverse((child) => {
      if (child instanceof Mesh && child.material instanceof MeshStandardMaterial && child.material.name.includes(fragment)) {
        child.material.emissive.copy(glow);
        child.material.emissiveIntensity = GLOW_INTENSITY;
      }
    });
  }, [scene, spec]);

  return (
    <>
      {placements.map((placement, index) => (
        <group key={index} position={[placement.x, spec.anchor === "ceiling" ? BUILDING.ceiling : placement.y, placement.z]} rotation={[0, (placement.turns * Math.PI) / 2, 0]}>
          <group position={fitted.offset} scale={fitted.scale}>
            <group rotation={[spec.tilt ?? 0, 0, 0]}>
              <primitive object={copies[index]} />
            </group>
          </group>
        </group>
      ))}
    </>
  );
}
