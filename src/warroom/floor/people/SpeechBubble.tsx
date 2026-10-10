import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Sprite } from "three";
import { bubbleTexture } from "./bubble.ts";

export function SpeechBubble({ name, text, isShown, y }: { name: string; text: string | null; isShown: () => boolean; y: number }) {
  const sprite = useRef<Sprite>(null);
  const texture = useMemo(() => (text ? bubbleTexture(name, text) : null), [name, text]);
  useEffect(() => () => texture?.dispose(), [texture]);
  useFrame(() => {
    if (sprite.current) sprite.current.visible = isShown() && texture !== null;
  });
  if (!texture) return null;
  const aspect = texture.image.width / texture.image.height;
  return (
    <sprite ref={sprite} position={[0, y, 0]} scale={[0.38 * aspect, 0.38, 1]} visible={false}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}
