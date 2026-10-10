import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { CanvasTexture, type Sprite } from "three";

type Props = {
  origin: readonly [number, number, number];
  /** Sideways wander of each puff, metres. */
  spread: number;
  /** How high a puff climbs before it's gone, metres. */
  rise: number;
  puffs: number;
  size: number;
  reduceMotion: boolean;
};

const LIFE_SECONDS = 2.2;

function puffTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--color-world-ceiling").trim();
  gradient.addColorStop(0, ink);
  gradient.addColorStop(1, "transparent");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new CanvasTexture(canvas);
}

/** Wisps of steam rising and fading; still and faint for people who prefer reduced motion. */
export function Steam({ origin, spread, rise, puffs, size, reduceMotion }: Props) {
  const texture = useMemo(() => puffTexture(), []);
  useEffect(() => () => texture.dispose(), [texture]);
  const sprites = useRef<(Sprite | null)[]>([]);

  useFrame(({ clock }) => {
    sprites.current.forEach((sprite, index) => {
      if (!sprite) return;
      const phase = reduceMotion ? 0.35 : ((clock.elapsedTime / LIFE_SECONDS + index / puffs) % 1);
      sprite.position.set(origin[0] + Math.sin(index * 2.4 + phase * 3) * spread, origin[1] + phase * rise, origin[2] + Math.cos(index * 1.7 + phase * 2) * spread);
      sprite.scale.setScalar(size * (0.6 + phase));
      const material = sprite.material;
      material.opacity = (reduceMotion ? 0.12 : 0.28) * Math.sin(phase * Math.PI);
    });
  });

  return (
    <>
      {Array.from({ length: puffs }, (_, index) => (
        <sprite
          key={index}
          ref={(sprite) => {
            sprites.current[index] = sprite;
          }}
        >
          <spriteMaterial map={texture} transparent depthWrite={false} opacity={0} />
        </sprite>
      ))}
    </>
  );
}
