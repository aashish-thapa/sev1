import { PaperCup } from "../pantry/Items.tsx";
import { HeldInHand } from "./HeldInHand.tsx";
import { Steam } from "./Steam.tsx";

type Props = {
  isHeld: boolean;
  /** Increments on every sip; each change plays one sip. */
  sips: number;
  isHandsBusy: boolean;
  reduceMotion: boolean;
};

/** A paper cup of office coffee in your hand, steaming, lifted to your mouth on each sip. */
export function HeldCup({ isHeld, sips, isHandsBusy, reduceMotion }: Props) {
  return (
    <HeldInHand isHeld={isHeld} uses={sips} isHandsBusy={isHandsBusy} reduceMotion={reduceMotion}>
      <group position={[0, -0.06, 0]}>
        <PaperCup />
        <Steam origin={[0, 0.12, 0]} spread={0.012} rise={0.16} puffs={5} size={0.04} reduceMotion={reduceMotion} />
      </group>
    </HeldInHand>
  );
}
