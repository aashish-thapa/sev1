import { describe, expect, it } from "vitest";
import { applyFrame, encodeFrame, IncidentFrameSchema } from "../multiplayer/frame.ts";
import { advance, debrief, declareResolved, openIncident, type Incident } from "./incident.ts";
import type { Scenario } from "./scenario.ts";
import { botFloodSingleIp, FLOOD_IP } from "./scenarios/bot-flood-single-ip.ts";
import { AUTO_CONTAIN_AT, CARD_TESTING_ALERT, cardTestingSoar, TESTER_RANGE } from "./scenarios/card-testing-soar.ts";
import { checkoutCommerce } from "./scenarios/checkout-commerce.ts";
import { credentialStuffingHosting, SIGN_IN_ALERT } from "./scenarios/credential-stuffing-hosting.ts";
import { unlockedWarRooms } from "./scenarios/index.ts";
import { BOT_JA4, PROXY_ALERT, residentialProxyStuffing } from "./scenarios/residential-proxy-stuffing.ts";
import { scaledToZero } from "./scenarios/scaled-to-zero.ts";
import { runLine } from "./shell/shell.ts";
import { attackLoad } from "./sim/attack.ts";
import type { Attack, Commerce, SiemAlert, WafRule } from "./sim/commerce.ts";
import {
  blockedAttackShare,
  blockedShare,
  cidrReach,
  containmentRule,
  DISTINCT_SOURCE_IPS,
  ja4Reach,
  parseCidr,
  rateLimitReach,
  topReach,
  topSources,
  topTalkerShare,
} from "./sim/edge.ts";

const PYTHON_JA4 = "t13d4312h1_c7886603b240_b26ce05bbdd6";
const CHROMIUM_JA4 = "t13d1517h2_8daaf6152771_cb7bf5808d99";

function attack(sources: Attack["sources"], requestsPerSecond: number, growthPerSecond = 0): Attack {
  return { label: "test attack", path: "/checkout", requestsPerSecond, growthPerSecond, sources, ja4: PYTHON_JA4, userAgent: "python-requests/2.32.3" };
}

/** A calm shop taking 120 checkout POSTs a second, under `threat`. */
function shopUnder(threat?: Attack, wafRules: readonly WafRule[] = []): Commerce {
  const commerce = checkoutCommerce({ attack: threat, wafRules });
  return { ...commerce, pulse: { ...commerce.pulse, checkoutAttemptsPerSecond: 120 } };
}

const singleIp = attack({ kind: "ranges", ranges: [{ cidr: "167.99.7.204/32", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 1 }] }, 150, 0.3);
const cardTesters = attack({ kind: "ranges", ranges: [{ cidr: "5.161.0.0/16", asn: 213230, network: "HETZNER-CLOUD2-AS", ips: 4000 }] }, 200);
const proxies = attack({ kind: "residential-proxies", ips: 40_000 }, (40_000 * 0.5) / 60);

function cidr(text: string) {
  const parsed = parseCidr(text);
  if (!parsed) throw new Error(`bad cidr ${text}`);
  return parsed;
}

function rule(attackShare: number, action: WafRule["action"] = "block"): WafRule {
  return { id: "r-0009", action, expression: "test", createdAt: 0, createdBy: "test", customerShare: 0, attackShare };
}

describe("attack traffic at the edge", () => {
  it("sends its base rate plus growth over time, less what the rules stop between them", () => {
    expect(attackLoad(shopUnder(), 100).requestsPerSecond).toBe(0);
    expect(attackLoad(shopUnder(singleIp), 0).requestsPerSecond).toBe(150);
    expect(attackLoad(shopUnder(singleIp), 100).requestsPerSecond).toBeCloseTo(180, 9);
    expect(attackLoad(shopUnder(singleIp, [rule(1)]), 100).requestsPerSecond).toBe(0);
  });

  it("adds up blocks, which pick out different attackers, and thins what they let through by each rate limit", () => {
    // Blocking two ranges that hold 60% and 40% of the attackers stops all of them.
    expect(attackLoad(shopUnder(singleIp, [rule(0.6), rule(0.4)]), 100).requestsPerSecond).toBeCloseTo(0, 9);
    expect(attackLoad(shopUnder(singleIp, [rule(1), rule(1)]), 100).requestsPerSecond).toBe(0);
    expect(attackLoad(shopUnder(singleIp, [rule(0.5), rule(0.5, "rate_limit")]), 100).requestsPerSecond).toBeCloseTo(45, 9);
    expect(attackLoad(shopUnder(singleIp, [rule(0.5, "rate_limit"), rule(0.5, "rate_limit")]), 100).requestsPerSecond).toBeCloseTo(45, 9);
  });

  it("ranks attacker addresses among the customers by how much each one sends", () => {
    const [first] = topSources(shopUnder(singleIp), 0, 3);
    expect(first).toMatchObject({ ip: "167.99.7.204", asn: 14061, kind: "hosting", requestsPerMinute: 9000 });

    // Card testers at 3 a minute each sit below every customer address busier than that.
    const ranked = topSources(shopUnder(cardTesters), 0, 400);
    const firstTester = ranked.findIndex((source) => source.kind === "hosting");
    expect(firstTester).toBeGreaterThan(350);
    expect(ranked.slice(0, firstTester).every((source) => source.requestsPerMinute > 3)).toBe(true);
    expect(ranked[firstTester].ip.startsWith("5.161.")).toBe(true);
  });

  it("blocks the top N of the merged ranking: one flooding address costs one slot, testers below hundreds of customers barely any", () => {
    expect(topReach(shopUnder(singleIp), 0, 500)).toEqual({ customerShare: topTalkerShare(499), attackShare: 1 });
    expect(topReach(shopUnder(singleIp), 0, 500).customerShare).toBeCloseTo(0.39, 2);

    const testers = topReach(shopUnder(cardTesters), 0, 500);
    expect(testers.customerShare).toBeGreaterThan(0.34);
    expect(testers.customerShare).toBeLessThan(0.39);
    expect(testers.attackShare).toBeCloseTo(124 / 4000, 9);

    // Residential proxies at half a request a minute rank below ~840 customer addresses.
    expect(topReach(shopUnder(proxies), 0, 500)).toEqual({ customerShare: topTalkerShare(500), attackShare: 0 });
    // Past the attackers, the ranking carries on into the rest of the customers.
    expect(topReach(shopUnder(singleIp), 0, DISTINCT_SOURCE_IPS + 1)).toEqual({ customerShare: topTalkerShare(DISTINCT_SOURCE_IPS), attackShare: 1 });
  });

  it("catches attackers by CIDR in proportion to the address space it covers", () => {
    expect(cidrReach(shopUnder(singleIp), cidr("167.99.7.204"))).toEqual({ customerShare: 0, attackShare: 1 });
    expect(cidrReach(shopUnder(cardTesters), cidr("5.161.0.0/16"))).toEqual({ customerShare: 0, attackShare: 1 });
    expect(cidrReach(shopUnder(cardTesters), cidr("5.161.128.0/17")).attackShare).toBeCloseTo(0.5, 9);
    expect(cidrReach(shopUnder(cardTesters), cidr("5.0.0.0/8")).attackShare).toBe(1);
    expect(cidrReach(shopUnder(cardTesters), cidr("5.162.0.0/16")).attackShare).toBe(0);
    // Proxies hide in the customers' own ISPs: a /8 of Comcast takes a quarter of them and a tenth of the customers.
    const comcast = cidrReach(shopUnder(proxies), cidr("73.0.0.0/8"));
    expect(comcast.attackShare).toBeCloseTo(0.25, 9);
    expect(comcast.customerShare).toBeGreaterThan(0.05);
  });

  it("rate-limits each address to the limit, so only addresses sending more lose anything", () => {
    const stuffers = attack({ kind: "ranges", ranges: [{ cidr: "159.89.128.0/20", asn: 14061, network: "DIGITALOCEAN-ASN", ips: 120 }] }, 200);
    expect(rateLimitReach(shopUnder(stuffers), 0, 20)).toEqual({ customerShare: 0, attackShare: 0.8 });
    expect(rateLimitReach(shopUnder(cardTesters), 0, 20).attackShare).toBe(0);
    expect(rateLimitReach(shopUnder(proxies), 0, 1)).toMatchObject({ attackShare: 0 });
    expect(rateLimitReach(shopUnder(proxies), 0, 1).customerShare).toBeGreaterThan(0.3);
    expect(rateLimitReach(shopUnder(attack({ kind: "ranges", ranges: [] }, 200)), 0, 20).attackShare).toBe(0);
  });

  it("blocks by JA4 only the TLS client that matches, and customers only by the browsers that present it", () => {
    expect(ja4Reach(shopUnder(proxies), PYTHON_JA4)).toEqual({ customerShare: 0, attackShare: 1 });
    expect(ja4Reach(shopUnder(proxies), CHROMIUM_JA4)).toEqual({ customerShare: 0.31, attackShare: 0 });
  });

  it("leaves rules in a shop without an attack exactly as they were: no attack share at all", () => {
    expect(topReach(shopUnder(), 0, 500)).toEqual({ customerShare: topTalkerShare(500) });
    expect(cidrReach(shopUnder(), cidr("172.32.0.0/11"))).not.toHaveProperty("attackShare");
    expect(rateLimitReach(shopUnder(), 0, 20)).not.toHaveProperty("attackShare");
    expect(ja4Reach(shopUnder(), PYTHON_JA4)).toEqual({ customerShare: 0 });
  });

  it("aims the SOAR playbook's top-N block at the merged ranking", () => {
    const alert: SiemAlert = { id: "SEC-1", title: "t", rule: "r", severity: "high", openedAt: 0, autoContainAt: 300, containTopIps: 500, resolution: null };
    const contained = containmentRule(shopUnder(cardTesters), alert, 0);
    expect(contained.customerShare).toBeCloseTo(topReach(shopUnder(cardTesters), 0, 500).customerShare, 12);
    expect(contained.attackShare).toBeCloseTo(0.031, 9);
    expect(containmentRule(shopUnder(), alert, 0)).not.toHaveProperty("attackShare");
  });
});

/** Runs `line` on a security laptop in a cluster wrapped in `commerce`. */
function securityShell(commerce: Commerce, line: string) {
  const cluster = { ...openIncident(scaledToZero).cluster, commerce };
  const result = runLine(line, { cluster, scenario: scaledToZero, history: [], role: "security" });
  return { text: result.output.map((output) => output.text).join("\n"), commerce: result.cluster?.commerce };
}

describe("waf top --by asn", () => {
  it("totals customers and attackers per origin network, busiest first, with the prefixes seen", () => {
    const { text } = securityShell(shopUnder(cardTesters), "waf top --by asn");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Top source networks · POST /checkout · last 5 min");
    expect(lines[2]).toMatch(/^AS213230\s+HETZNER-CLOUD2-AS\s+hosting \/ datacenter\s+4,000\s+12,000\s+\S+%\s+5\.161\.0\.0\/16$/);
    expect(text).toMatch(/AS7922\s+COMCAST-7922\s+residential ISP/);
    expect(lines.at(-1)).toBe("7,140 distinct source IPs across 5 networks");
  });

  it("refuses a ranking it doesn't know", () => {
    expect(securityShell(shopUnder(cardTesters), "waf top --by country").text).toContain('cannot rank by "country"');
  });
});

describe("waf block --ja4", () => {
  const loginStuffing: Attack = { ...proxies, path: "/session" };

  it("blocks one TLS client fingerprint on checkout and the attacked path", () => {
    const { text, commerce } = securityShell(shopUnder(loginStuffing), `waf block --ja4 ${PYTHON_JA4}`);
    expect(text).toContain(`rule r-0001 created (block): cf.bot_management.ja4 eq "${PYTHON_JA4}" and http.request.uri.path in {"/checkout" "/session"}`);
    expect(commerce?.wafRules.at(-1)).toMatchObject({ customerShare: 0, attackShare: 1 });
  });

  it("turns away every customer whose browser presents a fingerprint it blocks", () => {
    expect(securityShell(shopUnder(loginStuffing), `waf block --ja4 ${CHROMIUM_JA4}`).commerce?.wafRules.at(-1)).toMatchObject({ customerShare: 0.31, attackShare: 0 });
  });

  it("refuses anything that isn't a fingerprint", () => {
    const { text, commerce } = securityShell(shopUnder(loginStuffing), "waf block --ja4 771,4865-4866,0-23");
    expect(text).toContain('"771,4865-4866,0-23" is not a JA4 fingerprint');
    expect(commerce).toBeUndefined();
  });
});

describe("siem resolve --contained-by", () => {
  const playbook: SiemAlert = { id: "SEC-1", title: "Card testing", rule: "test", severity: "high", openedAt: -60, autoContainAt: 300, containTopIps: 500, resolution: null };
  const blocked = (alerts: readonly SiemAlert[]) => {
    const shop = { ...shopUnder(cardTesters), alerts };
    const commerce = securityShell(shop, "waf block 5.161.0.0/16").commerce;
    if (!commerce) throw new Error("block failed");
    return commerce;
  };

  it("closes a true positive on the analyst's own rule, and the playbook's block never runs", () => {
    const { text, commerce } = securityShell(blocked([playbook]), 'siem resolve SEC-1 --disposition true-positive --contained-by r-0001 --note "card testers"');
    expect(text).toContain("Containment recorded: r-0001 (block: ip.src in {5.161.0.0/16}");
    expect(commerce?.wafRules.map((rule) => rule.id)).toEqual(["r-0001"]);
    expect(commerce?.alerts[0]).toMatchObject({ autoContainAt: null, resolution: { disposition: "true-positive", note: "card testers (contained by r-0001)" } });
  });

  it("refuses a rule that doesn't exist, a disposition that isn't true-positive, or no rule at all", () => {
    expect(securityShell(blocked([playbook]), "siem resolve SEC-1 --disposition true-positive --contained-by r-0042").text).toContain("rule r-0042 not found");
    expect(securityShell(blocked([playbook]), "siem resolve SEC-1 --disposition benign --contained-by r-0001").text).toContain("goes with a true-positive");
    const bare = securityShell(blocked([playbook]), "siem resolve SEC-1 --disposition true-positive --contained-by");
    expect(bare.text).toContain("usage: siem resolve");
    expect(bare.commerce).toBeUndefined();
  });

  it("still runs the playbook on a plain true positive, and blocks nothing for an alert that has none", () => {
    expect(securityShell(blocked([playbook]), "siem resolve SEC-1 --disposition true-positive").commerce?.wafRules).toHaveLength(2);
    const noPlaybook = { ...playbook, autoContainAt: null, containTopIps: 0 };
    const { text, commerce } = securityShell(blocked([noPlaybook]), "siem resolve SEC-1 --disposition true-positive");
    expect(commerce?.wafRules).toHaveLength(1);
    expect(text).toContain("no SOAR containment playbook");
  });
});

// ── The security ladder ─────────────────────────────────────────────────────────

const LADDER: readonly Scenario[] = [botFloodSingleIp, credentialStuffingHosting, cardTestingSoar, residentialProxyStuffing];
/** Paced like solutions.test.ts: first move 20 s in, a command every 8 s, then time for the edge to settle. */
const FIRST_MOVE_AT = 20;
const THINKING_SECONDS = 8;
const SETTLE_SECONDS = 180;
/** A trap played at this second, the way a hurried analyst would. */
const TRAP_AT = 40;

function play(scenario: Scenario, incident: Incident, seconds: number): Incident {
  let current = incident;
  for (let index = 0; index < seconds; index += 1) current = advance(current, scenario).incident;
  return current;
}

function playTo(scenario: Scenario, t: number, incident: Incident): Incident {
  return play(scenario, incident, Math.max(0, t - incident.cluster.t));
}

/** Runs one line on the security laptop and applies whatever it changed; fails on anything the tool turns down. */
function as(scenario: Scenario, line: string, incident: Incident): Incident {
  const result = runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" });
  const errors = result.output.filter((output) => output.tone === "err").map((output) => output.text);
  if (errors.length > 0) throw new Error(`${line}: ${errors.join("\n")}`);
  return result.cluster ? { ...incident, cluster: result.cluster } : incident;
}

function shellText(scenario: Scenario, line: string, incident: Incident): string {
  return runLine(line, { cluster: incident.cluster, scenario, history: [], role: "security" })
    .output.map((output) => output.text)
    .join("\n");
}

function commerceOf(incident: Incident): Commerce {
  const { commerce } = incident.cluster;
  if (!commerce) throw new Error("no commerce");
  return commerce;
}

const customersBlocked = (incident: Incident) => blockedShare(commerceOf(incident).wafRules);
const attackBlocked = (incident: Incident) => blockedAttackShare(commerceOf(incident).wafRules);

/** Every command of the worked solution a few seconds apart, as solutions.test.ts plays them. */
function solved(scenario: Scenario): Incident {
  let incident = play(scenario, openIncident(scenario), FIRST_MOVE_AT);
  for (const step of scenario.solution.security ?? []) {
    incident = play(scenario, as(scenario, step.command, incident), THINKING_SECONDS);
  }
  return play(scenario, incident, SETTLE_SECONDS);
}

/** Lines played at TRAP_AT, then time to settle. */
function trapped(scenario: Scenario, ...lines: readonly string[]): Incident {
  let incident = playTo(scenario, TRAP_AT, openIncident(scenario));
  for (const line of lines) incident = as(scenario, line, incident);
  return play(scenario, incident, SETTLE_SECONDS);
}

/** Declares resolved (when the pager allows it) and plays out the monitoring window. */
function closeOut(scenario: Scenario, incident: Incident) {
  const declared = declareResolved(incident, scenario);
  const closed = play(scenario, declared.incident, 700);
  return { refused: declared.notice?.kind === "refused", closed, result: debrief(closed, scenario, true) };
}

/** Checkouts lost over the minute that ends at `t`, nobody acting. */
function lostInMinuteTo(scenario: Scenario, t: number): number {
  const before = playTo(scenario, t - 60, openIncident(scenario));
  return playTo(scenario, t, before).cluster.failedCheckouts - before.cluster.failedCheckouts;
}

const securityObjective = (result: ReturnType<typeof closeOut>["result"]) => result.objectives?.find((objective) => objective.label.includes("customers"));

describe("the security ladder", () => {
  it("climbs one tier per rung, security only, and opens by career level", () => {
    expect(LADDER.map((scenario) => scenario.tier)).toEqual(LADDER.map((_, index) => index + 1));
    for (const scenario of LADDER) expect(scenario.roles).toEqual(["security"]);
    for (const level of [0, 1, 2, 3] as const) expect(unlockedWarRooms("security", level)).toEqual(LADDER.slice(0, level + 1).toReversed());
  });
});

describe.each(LADDER.map((scenario) => [scenario.id, scenario] as const))("%s", (_id, scenario) => {
  it("gets worse if nobody acts: the pager refuses, and more checkouts are lost each minute", () => {
    const opened = openIncident(scenario);
    expect(opened.cluster.errorRate).toBeGreaterThan(0.1);
    expect(declareResolved(opened, scenario).notice?.kind).toBe("refused");
    expect(lostInMinuteTo(scenario, 600)).toBeGreaterThan(lostInMinuteTo(scenario, 60) * 1.1);
    expect(declareResolved(playTo(scenario, 600, opened), scenario).notice?.kind).toBe("refused");
  });

  it("closes at S or A when the worked solution is followed, with no customer blocked", () => {
    const incident = solved(scenario);
    expect(incident.cluster.errorRate).toBe(0);
    expect(customersBlocked(incident)).toBe(0);
    const { refused, closed, result } = closeOut(scenario, incident);
    expect(refused).toBe(false);
    expect(closed.phase.name).toBe("closed");
    expect(result.isRootCauseFixed).toBe(true);
    expect(result.objectives?.every((objective) => objective.isMet)).toBe(true);
    expect(["S", "A"]).toContain(result.grade);
  });

  it("is deterministic", () => {
    expect(solved(scenario).cluster).toEqual(solved(scenario).cluster);
    expect(playTo(scenario, 120, openIncident(scenario)).cluster).toEqual(playTo(scenario, 120, openIncident(scenario)).cluster);
  });

  it("round-trips its attack, rules and alerts through multiplayer frames", () => {
    const roundTrip = (previous: Incident | null, next: Incident) =>
      applyFrame(previous, IncidentFrameSchema.parse(JSON.parse(JSON.stringify(encodeFrame(previous, next)))));
    const steps = scenario.solution.security ?? [];
    let server = openIncident(scenario);
    let client = roundTrip(null, server);
    for (let second = 0; second < 90; second += 1) {
      let next = advance(server, scenario).incident;
      const step = steps[(second - FIRST_MOVE_AT) / THINKING_SECONDS];
      if (step) next = as(scenario, step.command, next);
      client = roundTrip(client, next);
      server = next;
    }
    expect(attackBlocked(server)).toBeGreaterThan(0.5);
    expect(client).toEqual(server);
    expect(commerceOf(client).attack).toEqual(commerceOf(openIncident(scenario)).attack);
  });

  it("follows the content rules: hints, a postmortem with one answer, SIEM evidence", () => {
    expect(scenario.hints.length).toBeGreaterThanOrEqual(2);
    expect(scenario.hints.length).toBeLessThanOrEqual(4);
    const { options, answerIndex, explanation } = scenario.postmortem;
    expect(options).toHaveLength(4);
    for (const option of options) expect(option.length).toBeLessThanOrEqual(64);
    const longestDistractor = Math.max(...options.filter((_, index) => index !== answerIndex).map((option) => option.length));
    expect(options[answerIndex].length - longestDistractor).toBeLessThanOrEqual(4);
    expect(explanation.cause.length).toBeLessThanOrEqual(90);
    expect(explanation.why.length).toBeLessThanOrEqual(340);
    expect(explanation.tell.length).toBeLessThanOrEqual(200);
    expect(scenario.releasedAt).toBeUndefined();
    expect(scenario.suggestions?.security?.length).toBeGreaterThan(0);
    const opened = openIncident(scenario);
    expect(scenario.evidence?.length).toBeGreaterThan(0);
    for (const view of scenario.evidence ?? []) {
      expect(view.tool).toBe("siem");
      expect(shellText(scenario, `siem search ${view.name}`, opened)).not.toMatch(/NaN|Infinity|undefined|unknown saved search/);
    }
  });
});

describe("bot-flood-single-ip", () => {
  const scenario = botFloodSingleIp;

  it("shows one hosting address far above every customer, and the script behind it", () => {
    const opened = openIncident(scenario);
    expect(shellText(scenario, "waf top 3", opened)).toMatch(new RegExp(`^1\\s+${FLOOD_IP}\\s+9,000\\s+14061\\s+DIGITALOCEAN-ASN\\s+hosting`, "m"));
    expect(shellText(scenario, "siem search edge-requests", opened)).toContain("python-requests/2.32.3");
  });

  it("blocking the top 500 clears the 5xx but turns away 39% of customers", () => {
    const correct = closeOut(scenario, solved(scenario)).result;
    const blunt = trapped(scenario, "waf block --top 500");
    expect(customersBlocked(blunt)).toBeCloseTo(0.393, 3);
    expect(attackBlocked(blunt)).toBe(1);
    expect(blunt.cluster.errorRate).toBe(0);
    const { refused, result } = closeOut(scenario, blunt);
    expect(refused).toBe(false);
    expect(securityObjective(result)?.isMet).toBe(false);
    expect(result.points).toBeLessThan(correct.points - 50);
  });
});

describe("credential-stuffing-hosting", () => {
  const scenario = credentialStuffingHosting;

  it("puts 120 hosting addresses in two networks above every customer", () => {
    const opened = openIncident(scenario);
    const networks = shellText(scenario, "waf top --by asn", opened);
    expect(networks).toMatch(/^AS14061\s+DIGITALOCEAN-ASN\s+hosting \/ datacenter\s+72\s/m);
    expect(networks).toMatch(/^AS16276\s+OVH\s+hosting \/ datacenter\s+48\s/m);
    expect(shellText(scenario, "siem search auth-summary", opened)).toMatch(/distinct usernames per source IP \(p99\)\s+1,500\s+3/);
  });

  it("a false-positive disposition closes the alert while the stuffing goes on, and the pager stays refused", () => {
    const dismissed = trapped(scenario, `siem resolve ${SIGN_IN_ALERT} --disposition false-positive`);
    expect(commerceOf(dismissed).alerts[0].resolution?.disposition).toBe("false-positive");
    expect(customersBlocked(dismissed)).toBe(0);
    expect(attackBlocked(dismissed)).toBe(0);
    expect(dismissed.cluster.errorRate).toBeGreaterThan(0.2);
    const { refused, result } = closeOut(scenario, dismissed);
    expect(refused).toBe(true);
    expect(result.objectives?.find((objective) => objective.label.startsWith(SIGN_IN_ALERT))?.isMet).toBe(false);
  });

  it("blocking the top 500 stops the stuffing but turns away 35% of customers", () => {
    const blunt = trapped(scenario, "waf block --top 500");
    expect(customersBlocked(blunt)).toBeCloseTo(0.353, 3);
    expect(attackBlocked(blunt)).toBe(1);
    expect(securityObjective(closeOut(scenario, blunt).result)?.isMet).toBe(false);
  });

  it("blocking both hosting ranges works as well as the rate limit", () => {
    const blocked = trapped(
      scenario,
      "waf block 159.89.128.0/20",
      "waf block 51.75.0.0/16",
      `siem resolve ${SIGN_IN_ALERT} --disposition true-positive --contained-by r-0004`,
    );
    expect(attackBlocked(blocked)).toBe(1);
    expect(customersBlocked(blocked)).toBe(0);
    expect(["S", "A"]).toContain(closeOut(scenario, blocked).result.grade);
  });

  it("a rate limit too loose for the stuffing leaves the 5xx up", () => {
    const loose = trapped(scenario, "waf ratelimit 60/1m");
    expect(attackBlocked(loose)).toBeCloseTo(0.42, 2);
    expect(loose.cluster.errorRate).toBeGreaterThan(0.05);
  });
});

describe("card-testing-soar", () => {
  const scenario = cardTestingSoar;
  /** What the playbook's (or anyone's) top-500 block does here: a third of the customers, a few percent of the testers. */
  const expectTop500 = (incident: Incident) => {
    expect(customersBlocked(incident)).toBeGreaterThan(0.35);
    expect(customersBlocked(incident)).toBeLessThan(0.36);
    expect(attackBlocked(incident)).toBeLessThan(0.035);
  };
  const correct = () => closeOut(scenario, solved(scenario)).result;

  it("hides the testers below hundreds of customer addresses, and in one hosting /16 by network", () => {
    const opened = openIncident(scenario);
    expect(shellText(scenario, "waf top 100", opened)).not.toContain("hosting");
    expect(shellText(scenario, "waf top --by asn", opened)).toMatch(/^AS213230\s+HETZNER-CLOUD2-AS\s+hosting \/ datacenter\s+4,000\s+[\d,]+\s+\S+%\s+5\.161\.0\.0\/16$/m);
    expect(shellText(scenario, `siem show ${CARD_TESTING_ALERT}`, opened)).toContain("Searches:  siem search card-velocity");
  });

  it("blocking the top 500 by hand turns away 35% of customers and barely touches the testers", () => {
    const blunt = trapped(scenario, "waf block --top 500");
    expectTop500(blunt);
    const { result } = closeOut(scenario, blunt);
    expect(securityObjective(result)?.isMet).toBe(false);
    expect(result.points).toBeLessThan(correct().points - 50);
  });

  it("a plain true positive runs the playbook's top-500 block at once", () => {
    const plain = trapped(scenario, `siem resolve ${CARD_TESTING_ALERT} --disposition true-positive`);
    expect(commerceOf(plain).wafRules.at(-1)?.createdBy).toContain("soar:playbook");
    expectTop500(plain);
    expect(plain.cluster.errorRate).toBeLessThan(0.05);
    expect(securityObjective(closeOut(scenario, plain).result)?.isMet).toBe(false);
  });

  it("even after the right block, a plain true positive still runs the playbook", () => {
    const both = trapped(scenario, `waf block ${TESTER_RANGE}`, `siem resolve ${CARD_TESTING_ALERT} --disposition true-positive`);
    expect(attackBlocked(both)).toBe(1);
    expect(customersBlocked(both)).toBeGreaterThan(0.35);
  });

  it("waiting past the timer lets the playbook block the top 500 by itself", () => {
    const before = playTo(scenario, AUTO_CONTAIN_AT - 1, openIncident(scenario));
    expect(customersBlocked(before)).toBe(0);
    const after = playTo(scenario, AUTO_CONTAIN_AT + 1, before);
    expectTop500(after);
    expect(after.cluster.logs.waf?.at(-1)?.text).toContain("soar:playbook/auto-contain");
  });
});

describe("residential-proxy-stuffing", () => {
  const scenario = residentialProxyStuffing;
  /** A wrong fix measured: the share of customers it turns away, of the stuffing it stops, and whether 5xx stay up. */
  const measure = (...lines: readonly string[]) => {
    const incident = trapped(scenario, ...lines);
    return { customers: customersBlocked(incident), attack: attackBlocked(incident), errorRate: incident.cluster.errorRate };
  };

  it("gives no address away: every proxy sends less than the busiest customers, and one JA4 sends most sign-ins", () => {
    const opened = openIncident(scenario);
    expect(shellText(scenario, "waf top 100", opened)).not.toMatch(/hosting/);
    expect(shellText(scenario, "waf top", opened)).toContain("43,140 distinct source IPs");
    const fingerprints = shellText(scenario, "siem search tls-fingerprints", opened);
    expect(fingerprints).toMatch(new RegExp(`^${BOT_JA4}\\s+Python\\s+Chrome/114\\.0\\.0\\.0 \\(Windows\\)\\s+19,800\\s+40,000`, "m"));
    expect(fingerprints).toContain("t13d1517h2_8daaf6152771_cb7bf5808d99   Chromium Browser");
  });

  it("a rate limit any customer would pass misses every bot", () => {
    expect(measure("waf ratelimit 20/1m")).toEqual({ customers: 0, attack: 0, errorRate: expect.closeTo(0.4, 1) });
  });

  it("a rate limit tight enough to touch the bots turns customers away first", () => {
    const perMinute = measure("waf ratelimit 1/1m");
    expect(perMinute.customers).toBeCloseTo(0.332, 3);
    expect(perMinute.attack).toBe(0);
    expect(perMinute.errorRate).toBeGreaterThan(0.2);
    const perTenMinutes = measure("waf ratelimit 1/10m");
    expect(perTenMinutes.customers).toBeCloseTo(0.439, 3);
    expect(perTenMinutes.attack).toBeCloseTo(0.8, 2);
  });

  it("CIDR and top-N blocks mostly hit customers and leave the 5xx up", () => {
    const comcast = measure("waf block 73.0.0.0/8");
    expect(comcast.customers).toBeCloseTo(0.099, 3);
    expect(comcast.attack).toBeCloseTo(0.25, 9);
    expect(comcast.errorRate).toBeGreaterThan(0.2);
    expect(measure("waf block --top 500")).toEqual({ customers: expect.closeTo(0.393, 3), attack: 0, errorRate: expect.closeTo(0.27, 2) });
  });

  it("blocking the fingerprint the User-Agent claims, Chrome's, blocks Chrome's customers instead", () => {
    expect(measure("waf block --ja4 t13d1517h2_8daaf6152771_cb7bf5808d99")).toEqual({ customers: expect.closeTo(0.31, 9), attack: 0, errorRate: expect.closeTo(0.3, 1) });
  });

  it("the JA4 block alone stops every bot; the alert still wants closing", () => {
    const blocked = trapped(scenario, `waf block --ja4 ${BOT_JA4}`);
    expect(attackBlocked(blocked)).toBe(1);
    expect(shellText(scenario, "siem search tls-fingerprints", blocked)).toMatch(new RegExp(`^${BOT_JA4}\\s+Python\\s+Chrome/114\\.0\\.0\\.0 \\(Windows\\)\\s+0\\s+40,000`, "m"));
    expect(blocked.cluster.errorRate).toBe(0);
    const { result } = closeOut(scenario, blocked);
    expect(result.objectives?.find((objective) => objective.label.startsWith(PROXY_ALERT))?.isMet).toBe(false);
  });
});
