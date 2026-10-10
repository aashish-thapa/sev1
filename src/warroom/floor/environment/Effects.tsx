import { Bloom, EffectComposer, SMAA, SSAO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";

/**
 * The camera's response on capable machines: contact shadows where furniture meets the floor,
 * a soft glow on the things that emit light (LEDs, troffers, screens' brightest pixels), filmic tone mapping.
 */
export function Effects() {
  return (
    <EffectComposer enableNormalPass multisampling={0}>
      <SSAO samples={16} rings={5} radius={0.08} intensity={18} luminanceInfluence={0.6} worldDistanceThreshold={20} worldDistanceFalloff={5} worldProximityThreshold={0.4} worldProximityFalloff={0.1} />
      <Bloom mipmapBlur luminanceThreshold={1.1} luminanceSmoothing={0.15} intensity={0.4} />
      <ToneMapping mode={ToneMappingMode.AGX} />
      <SMAA />
      <Vignette offset={0.32} darkness={0.42} />
    </EffectComposer>
  );
}
