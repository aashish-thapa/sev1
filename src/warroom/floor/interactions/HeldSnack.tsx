import type { SnackId } from "../../../domain/pantry.ts";
import { SnackModel } from "../pantry/Items.tsx";
import { HeldInHand } from "./HeldInHand.tsx";

type Props = {
  item: SnackId | null;
  bitesTaken: number;
  isHandsBusy: boolean;
  reduceMotion: boolean;
};

/** The snack in your hand, a little smaller after every bite. */
export function HeldSnack({ item, bitesTaken, isHandsBusy, reduceMotion }: Props) {
  return (
    <HeldInHand isHeld={item !== null} uses={bitesTaken} isHandsBusy={isHandsBusy} reduceMotion={reduceMotion}>
      <group position={[0, -0.05, 0]} rotation={[0, 0.5, 0]}>
        {item && <SnackModel item={item} bitesTaken={bitesTaken} />}
      </group>
    </HeldInHand>
  );
}
