import { Suspense, useLayoutEffect, useMemo, useRef } from "react";
import { CanvasTexture, SRGBColorSpace } from "three";
import { Fittings } from "./environment/Fittings.tsx";
import { Lighting } from "./environment/Lighting.tsx";
import { Props } from "./environment/Props.tsx";
import type { FinishMaterials } from "./environment/finishes.ts";
import { flatFinishes } from "./environment/flatFinishes.ts";
import { Shell } from "./environment/Shell.tsx";
import { useFinishes } from "./environment/useFinishes.ts";
import { Workstations } from "./environment/Workstations.tsx";
import { SCREEN_SIZE, WALL_SCREENS, type WallScreen } from "./office.ts";
import { signTexture, tokenColor } from "./tokens.ts";

type OfficeProps = {
  /** 0 = a normal day, 1 = everything is on fire. Drives lighting, flicker and alarms. */
  panic: number;
  reduceMotion: boolean;
  hasShadows: boolean;
};

/** The building: lighting, the scanned shell and furniture, desks and fittings, signage and the role rooms' screens. */
export function Office({ panic, reduceMotion, hasShadows }: OfficeProps) {
  const panicRef = useRef(panic);
  useLayoutEffect(() => {
    panicRef.current = panic;
  }, [panic]);
  const fallback = useMemo(() => flatFinishes(), []);
  return (
    <>
      <Lighting panic={panicRef} reduceMotion={reduceMotion} hasShadows={hasShadows} />
      <Suspense fallback={<Interior finishes={fallback} panic={panicRef} reduceMotion={reduceMotion} />}>
        <ScannedInterior panic={panicRef} reduceMotion={reduceMotion} />
      </Suspense>
      <Suspense fallback={null}>
        <Props hasShadows={hasShadows} />
      </Suspense>
      <Sign text="Data centre" caption="infra · authorised staff" x={8} z={1.2} y={2.75} />
      <Sign text="Library" caption="discussions" x={10.75} z={4.3} y={2.75} />
      <Sign text="Data lab" caption="data & ML" x={18.25} z={4.3} y={2.75} />
      <Sign text="Device lab" caption="mobile" x={-19.25} z={1.2} y={2.75} />
      <Sign text="SOC" caption="security" x={-13.75} z={1.2} y={2.75} />
      <Sign text="Web studio" caption="frontend" x={-20.4} z={6} y={2.75} />
      <Sign text="Kitchen" caption="" x={14} z={1.4} y={2.75} />
      {WALL_SCREENS.map((screen) => (
        <ScreenModel key={screen.id} screen={screen} />
      ))}
    </>
  );
}

type InteriorProps = { panic: { readonly current: number }; reduceMotion: boolean };

function ScannedInterior(props: InteriorProps) {
  return <Interior finishes={useFinishes()} {...props} />;
}

function Interior({ finishes, panic, reduceMotion }: InteriorProps & { finishes: FinishMaterials }) {
  return (
    <>
      <Shell materials={finishes} panic={panic} reduceMotion={reduceMotion} />
      <Workstations finishes={finishes} />
      <Fittings finishes={finishes} />
    </>
  );
}

/** A wall-mounted TV: bezel plus a lit panel showing the room's name. */
function ScreenModel({ screen }: { screen: WallScreen }) {
  const texture = useMemo(() => screenTexture(screen.title), [screen.title]);
  const [nx, nz] = screen.normal;
  const yaw = Math.atan2(nx, nz);
  return (
    <group position={[screen.x, SCREEN_SIZE.y, screen.z]} rotation={[0, yaw, 0]}>
      <mesh>
        <boxGeometry args={[SCREEN_SIZE.width + 0.08, SCREEN_SIZE.height + 0.08, 0.06]} />
        <meshStandardMaterial color={tokenColor("--color-world-plastic")} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0, 0.032]}>
        <planeGeometry args={[SCREEN_SIZE.width, SCREEN_SIZE.height]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

function screenTexture(title: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 704;
  canvas.height = 400;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  context.fillStyle = token("--color-terminal");
  context.fillRect(0, 0, 704, 400);
  context.fillStyle = token("--color-accent");
  context.font = `600 26px ${token("--font-mono")}`;
  context.fillText("sev1 ·", 40, 64);
  context.fillStyle = token("--color-ink");
  context.font = `800 64px ${token("--font-display")}`;
  context.fillText(title.split(" · ")[0], 40, 170);
  context.fillStyle = token("--color-muted");
  context.font = `400 26px ${token("--font-mono")}`;
  context.fillText(title.includes(" · ") ? title.split(" · ")[1] : "problems on this screen", 40, 220);
  context.fillStyle = token("--color-ink-2");
  context.fillText("walk up · press E to discuss", 40, 340);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function Sign({ text, caption, x, y, z }: { text: string; caption: string; x: number; y: number; z: number }) {
  const texture = useMemo(() => signTexture(text, caption, null), [text, caption]);
  const aspect = texture.image.width / texture.image.height;
  return (
    <sprite position={[x, y, z]} scale={[0.5 * aspect, 0.5, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}
