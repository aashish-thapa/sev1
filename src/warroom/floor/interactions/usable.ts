import type { Footprint } from "../layout.ts";

/**
 * Something in the office you can face and press E on. Each kind of thing builds its own,
 * so adding one never touches the code that finds, labels or triggers them.
 */
export type Usable = {
  readonly key: string;
  readonly footprint: Footprint;
  /** Shown on the prompt: "Sit at", "Make coffee", "Chat with". */
  readonly verb: string;
  readonly label: string;
  use(): void;
};
