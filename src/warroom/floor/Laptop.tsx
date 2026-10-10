import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { MathUtils, Vector3, type Group, type PerspectiveCamera } from "three";
import { tokenColor } from "./tokens.ts";

/** Real-world-ish laptop proportions, metres. */
const SCREEN = { width: 0.31, height: 0.195 } as const;
const LID = { width: 0.34, height: 0.225, thickness: 0.008 } as const;
const BASE = { width: 0.34, depth: 0.235, height: 0.016 } as const;

const RAISE_SECONDS = 0.55;
/** The glass sits a few millimetres above the lid's centre line, inside the bezel. */
const SCREEN_LIFT = 0.004;
/** Share of the view the open screen may fill — leaves the keyboard and the hall visible around it. */
const FILL = { width: 0.94, height: 0.7 } as const;

type Props = {
  isOpen: boolean;
  reduceMotion: boolean;
  /** The DOM terminal is laid exactly over the 3D screen once the lid is fully open. */
  screenRef: RefObject<HTMLDivElement | null>;
};

/**
 * A laptop held in front of the player. It rides along with the camera, rises and opens
 * when `isOpen` turns true, and hands its on-screen rectangle to the DOM overlay.
 */
export function Laptop({ isOpen, reduceMotion, screenRef }: Props) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const size = useThree((state) => state.size);
  const rig = useRef<Group>(null);
  const lid = useRef<Group>(null);
  const progress = useRef(0);
  const corners = useMemo(() => [new Vector3(), new Vector3()], []);

  // The default camera isn't part of the scene graph; children of it only render once it is.
  useEffect(() => {
    scene.add(camera);
    return () => {
      scene.remove(camera);
    };
  }, [camera, scene]);

  useEffect(() => {
    const group = rig.current;
    if (!group) return;
    camera.add(group);
    return () => {
      camera.remove(group);
    };
  }, [camera]);

  useFrame((_, delta) => {
    const group = rig.current;
    const hinge = lid.current;
    const overlay = screenRef.current;
    if (!group || !hinge) return;

    const step = reduceMotion ? 1 : delta / RAISE_SECONDS;
    progress.current = MathUtils.clamp(progress.current + (isOpen ? step : -step), 0, 1);
    const eased = 1 - (1 - progress.current) ** 3;

    // Pull the laptop back until its screen fits the view on any aspect ratio.
    const halfV = Math.tan(MathUtils.degToRad(camera.fov / 2));
    const halfH = halfV * camera.aspect;
    const distance = Math.max(SCREEN.width / (2 * halfH * FILL.width), SCREEN.height / (2 * halfV * FILL.height));
    const screenCentreY = -0.04 * distance;
    const hingeY = screenCentreY - LID.height / 2 - SCREEN_LIFT;

    group.visible = progress.current > 0;
    group.position.set(0, hingeY - (1 - eased) * 0.45, -distance);
    // Lid folds from closed (lying on the keyboard) to upright, in the second half of the rise.
    const lidOpen = MathUtils.clamp((eased - 0.35) / 0.65, 0, 1);
    hinge.rotation.x = MathUtils.lerp(Math.PI / 2, 0, lidOpen);

    if (!overlay) return;
    if (progress.current < 1) {
      overlay.dataset.visible = "false";
      return;
    }
    // Lid is upright and square to the camera, so the screen projects to an axis-aligned rectangle.
    corners[0].set(-SCREEN.width / 2, screenCentreY + SCREEN.height / 2, -distance);
    corners[1].set(SCREEN.width / 2, screenCentreY - SCREEN.height / 2, -distance);
    const [topLeft, bottomRight] = corners.map((corner) => corner.clone().applyMatrix4(camera.projectionMatrix));
    const left = ((topLeft.x + 1) / 2) * size.width;
    const top = ((1 - topLeft.y) / 2) * size.height;
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.width = `${((bottomRight.x + 1) / 2) * size.width - left}px`;
    overlay.style.height = `${((1 - bottomRight.y) / 2) * size.height - top}px`;
    overlay.dataset.visible = "true";
  });

  const shell = tokenColor("--color-rule");
  const deck = tokenColor("--color-paper-3");
  const glass = tokenColor("--color-terminal");
  const keys = tokenColor("--color-rule-2");

  return (
    <group ref={rig} visible={false}>
      {/* Base with keyboard, extending from the hinge toward the player. */}
      <mesh position={[0, -BASE.height / 2, BASE.depth / 2]}>
        <boxGeometry args={[BASE.width, BASE.height, BASE.depth]} />
        <meshStandardMaterial color={shell} roughness={0.5} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0.0005, BASE.depth * 0.36]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BASE.width * 0.86, BASE.depth * 0.46]} />
        <meshStandardMaterial color={keys} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.0005, BASE.depth * 0.8]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BASE.width * 0.32, BASE.depth * 0.22]} />
        <meshStandardMaterial color={deck} roughness={0.6} />
      </mesh>
      {/* Lid hinged at the back edge of the base. */}
      <group ref={lid} rotation={[Math.PI / 2, 0, 0]}>
        <mesh position={[0, LID.height / 2, -LID.thickness / 2]}>
          <boxGeometry args={[LID.width, LID.height, LID.thickness]} />
          <meshStandardMaterial color={shell} roughness={0.5} metalness={0.6} />
        </mesh>
        <mesh position={[0, LID.height / 2 + SCREEN_LIFT, 0.0005]}>
          <planeGeometry args={[SCREEN.width, SCREEN.height]} />
          <meshStandardMaterial color={glass} emissive={glass} emissiveIntensity={0.6} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}
