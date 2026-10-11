import { describe, expect, it } from "vitest";
import { seededRandom } from "../domain/random.ts";
import { crewTurn, planCrew } from "./bot-crew.ts";
import { advance, debrief, openIncident } from "./incident.ts";
import { SCENARIOS } from "./scenarios/index.ts";

/** A crew that hasn't closed by then is stuck. */
const LIMIT_SECONDS = 3_600;

describe.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))("%s: bot crew", (_id, scenario) => {
  it("closes the incident on its own, well but not instantly", () => {
    let plan = planCrew(scenario, seededRandom(scenario.seed));
    let incident = openIncident(scenario);
    while (incident.phase.name !== "closed" && incident.cluster.t < LIMIT_SECONDS) {
      incident = advance(incident, scenario).incident;
      ({ plan, incident } = crewTurn(plan, incident, scenario));
    }
    expect(incident.phase.name).toBe("closed");
    const result = debrief(incident, scenario, true);
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.points).toBeGreaterThanOrEqual(35);
    expect(incident.declaredAt ?? 0).toBeGreaterThan(60);
  });
});

describe("a bot crew's plan", () => {
  it("plays data's steps last, after the retry storm in a cross-team incident", () => {
    const meltdown = SCENARIOS.find((scenario) => scenario.id === "checkout-meltdown");
    if (!meltdown) throw new Error("no meltdown");
    const { moves } = planCrew(meltdown, seededRandom("x"));
    const firstData = moves.findIndex((move) => move.role === "data");
    expect(moves.slice(firstData).every((move) => move.role === "data")).toBe(true);
    expect(moves[firstData]?.at).toBeGreaterThanOrEqual(420);
  });
});
