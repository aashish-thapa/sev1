import { Environment } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, Color, Object3D, SRGBColorSpace, type DirectionalLight, type HemisphereLight, type PointLight } from "three";
import { assetPath } from "../assets/catalog.ts";
import { BUILDING } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { assetUrl } from "../assets/url.ts";

export type PanicRef = { readonly current: number };

type LightingProps = {
  panic: PanicRef;
  reduceMotion: boolean;
  hasShadows: boolean;
};

/** Image-based light from a scanned office does most of the work; the HDRI is never shown, only reflected. */
const ENVIRONMENT_INTENSITY = 0.55;
const FILL_INTENSITY = 0.45;
const KEY_INTENSITY = 1.6;
/** Covers the whole floor plate so one shadow map serves every room. */
const SHADOW_SPAN = { halfWidth: (BUILDING.maxX - BUILDING.minX) / 2 + 1, halfDepth: (BUILDING.maxZ - BUILDING.minZ) / 2 + 1 } as const;
const SHADOW_MAP_SIZE = 4096;
/** Overcast sky through the windows is brighter than the room; just enough over 1 to glare at the bright top. */
const DAYLIGHT_GAIN = 1.25;

/**
 * How the building is lit, and how that light sours as customers start failing:
 * the room drains toward the alarm colour and the ambient bounce dims.
 */
export function Lighting({ panic, reduceMotion, hasShadows }: LightingProps) {
  const ceiling = tokenColor("--color-world-ceiling");
  const floorBounce = tokenColor("--color-world-carpet");
  const alarm = tokenColor("--color-critical");
  const fill = useRef<HemisphereLight>(null);
  const key = useRef<DirectionalLight>(null);
  const [target] = useState(() => new Object3D());

  useLayoutEffect(() => {
    const light = key.current;
    if (!light) return;
    light.target = target;
    const camera = light.shadow.camera;
    camera.left = -SHADOW_SPAN.halfWidth;
    camera.right = SHADOW_SPAN.halfWidth;
    camera.top = SHADOW_SPAN.halfDepth;
    camera.bottom = -SHADOW_SPAN.halfDepth;
    camera.near = 1;
    camera.far = 40;
    camera.updateProjectionMatrix();
  }, [target]);

  useFrame(({ scene }) => {
    const level = panic.current;
    const tint = reduceMotion ? level * 0.15 : level * 0.3;
    scene.environmentIntensity = ENVIRONMENT_INTENSITY * (1 - 0.45 * level);
    if (fill.current) {
      fill.current.intensity = FILL_INTENSITY * (1 - 0.4 * level);
      fill.current.color.copy(ceiling).lerp(alarm, tint);
    }
    if (key.current) {
      key.current.intensity = KEY_INTENSITY * (1 - 0.35 * level);
      key.current.color.copy(ceiling).lerp(alarm, tint);
    }
  });

  return (
    <>
      <Environment files={assetUrl(assetPath.environment())} environmentIntensity={ENVIRONMENT_INTENSITY} />
      <hemisphereLight ref={fill} args={[ceiling, floorBounce, FILL_INTENSITY]} />
      {/* Overhead key light standing in for the ceiling troffers; nearly vertical so desks pool their own shadow. */}
      <directionalLight
        ref={key}
        position={[2, 14, 3]}
        intensity={KEY_INTENSITY}
        color={ceiling}
        castShadow={hasShadows}
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
      <primitive object={target} position={[0, 0, 0]} />
      <Daylight />
      {/* The data centre runs cooler and dimmer than the office. */}
      {[-6, 6].map((x) => (
        <pointLight key={x} position={[x, 3.2, -7]} intensity={6} distance={14} decay={1.5} color={tokenColor("--color-ink-2")} />
      ))}
      <CorridorAlarms panic={panic} reduceMotion={reduceMotion} />
    </>
  );
}

/** The overcast sky outside the dev floor's windows: bright overhead, greyer toward the horizon. Faces into the building. */
function Daylight() {
  const sky = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas unavailable");
    const styles = getComputedStyle(document.documentElement);
    const gradient = context.createLinearGradient(0, 0, 0, 128);
    gradient.addColorStop(0, styles.getPropertyValue("--color-world-ceiling").trim());
    gradient.addColorStop(1, styles.getPropertyValue("--color-world-glass").trim());
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4, 128);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }, []);
  useLayoutEffect(() => () => sky.dispose(), [sky]);
  const gain = useMemo(() => new Color(DAYLIGHT_GAIN, DAYLIGHT_GAIN, DAYLIGHT_GAIN), []);
  return (
    <mesh position={[0, BUILDING.ceiling / 2, BUILDING.maxZ + 0.6]} rotation={[0, Math.PI, 0]}>
      <planeGeometry args={[BUILDING.maxX - BUILDING.minX, BUILDING.ceiling]} />
      <meshBasicMaterial map={sky} color={gain} toneMapped={false} />
    </mesh>
  );
}

/** Red emergency lights down the corridor, pulsing once the incident is serious. */
function CorridorAlarms({ panic, reduceMotion }: { panic: PanicRef; reduceMotion: boolean }) {
  const lights = useRef<(PointLight | null)[]>([]);
  const color = tokenColor("--color-critical");
  const spots = [-16, -6, 4, 14] as const;
  useFrame(({ clock }) => {
    const level = Math.max(0, (panic.current - 0.35) / 0.65);
    lights.current.forEach((light, index) => {
      if (!light) return;
      const pulse = reduceMotion ? 0.6 : 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5 + index * 1.3);
      light.intensity = level * 9 * pulse;
    });
  });
  return (
    <>
      {spots.map((x, index) => (
        <group key={x} position={[x, BUILDING.ceiling - 0.15, 2.75]}>
          <pointLight ref={(light) => void (lights.current[index] = light)} color={color} intensity={0} distance={9} decay={1.6} />
          <mesh>
            <boxGeometry args={[0.3, 0.08, 0.12]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.2} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>
  );
}
