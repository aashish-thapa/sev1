import type { Scenario } from "../src/warroom/scenario.ts";
import { findScenario } from "../src/warroom/scenarios/index.ts";

export type ScenarioCatalog = (id: string) => Scenario | undefined;

export { findScenario };
