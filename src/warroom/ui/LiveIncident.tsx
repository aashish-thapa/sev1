import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { footstep, getAudio, keyClick, laptopOpen, notificationPing, pagerBuzz, useAudioUnlock, useSoundscape } from "../../audio/index.ts";
import type { Whereabouts } from "../floor/whereabouts.ts";
import type { CommsMessage } from "../scenario.ts";
import type { NodeId } from "../health.ts";
import type { Role } from "../../domain/incident.ts";
import type { Incident } from "../incident.ts";
import { clockAt, type Scenario } from "../scenario.ts";
import type { WallScreen } from "../floor/office.ts";
import { calmScenario, calmView, panicOf } from "./mood.ts";
import { IncidentHud } from "./IncidentHud.tsx";
import { InspectPanel } from "./InspectPanel.tsx";
import { LaptopScreen, type LaptopTab } from "./LaptopScreen.tsx";
import { ServiceMap } from "./ServiceMap.tsx";
import { Terminal } from "./Terminal.tsx";
import { loadFloor } from "./floorLoader.ts";
import { promptFor, suggestionsFor } from "./laptop-identity.ts";
import type { PlayerPresence } from "../floor/interactions/presence.ts";
import type { IncidentFeed, Teammate, TeamActivity } from "./feed.ts";
import { useIncident } from "./useIncident.ts";

type Props = {
  scenario: Scenario;
  role: Role;
  isPaged: boolean;
  onPage: () => void;
  onClosed: (incident: Incident) => void;
  onLeave: () => void;
  onUseScreen: (screen: WallScreen) => void;
  /** A full-screen layer over the floor (a discussion at a wall screen); it pauses walking. */
  overlay: React.ReactNode;
  feed: IncidentFeed;
  /** Present when playing in a shared room. */
  team?: TeamContext;
};

export type TeamContext = {
  readonly code: string;
  /** Your player id; teammates pick your avatar from it, so your own body must too. */
  readonly selfId: string;
  readonly teammates: readonly Teammate[];
  readonly activity: readonly TeamActivity[];
  onPresence(presence: PlayerPresence): void;
};

/** Solo play: the incident runs here, in the browser. */
export function SoloIncident(props: Omit<Props, "feed" | "team">) {
  const feed = useIncident(props.scenario, props.role, props.isPaged);
  return <LiveIncident {...props} feed={feed} />;
}

const FloorView = lazy(loadFloor);

/** Matches the laptop's raise animation, so focus lands once the screen is readable. */
const LAPTOP_SETTLE_MS = 560;

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export function LiveIncident({ scenario, role, isPaged, onPage, onClosed, onLeave, onUseScreen, overlay, feed, team }: Props) {
  const { incident: liveIncident, terminal, history, comms: liveComms, run, declare, complete } = feed;
  // Until the pager goes off the floor shows a healthy system and the channel is quiet.
  const incident = useMemo(() => (isPaged ? liveIncident : { ...liveIncident, cluster: calmView(liveIncident.cluster) }), [isPaged, liveIncident]);
  const watched = useMemo(() => (isPaged ? scenario : calmScenario(scenario)), [isPaged, scenario]);
  const comms = isPaged ? liveComms : [];
  const [selected, setSelected] = useState<NodeId | null>(null);
  const [draft, setDraft] = useState("");
  const isImmersive = useMemo(() => supportsWebGL(), []);
  const { cluster, phase } = incident;

  useEffect(() => {
    if (phase.name === "closed") onClosed(incident);
  }, [incident, onClosed, phase.name]);

  const deploymentName = cluster.deployments[0]?.name ?? scenario.service;
  const terminalProps = {
    lines: terminal,
    history,
    draft,
    onDraftChange: setDraft,
    onRun: run,
    onComplete: complete,
    isDisabled: phase.name === "monitoring",
    prompt: promptFor(role),
    suggestions: suggestionsFor(role, deploymentName),
  };
  const hud = <IncidentHud incident={incident} scenario={watched} isPaged={isPaged} onPage={onPage} onDeclare={declare} onLeave={onLeave} />;

  if (!isImmersive) {
    return (
      <main className="warroom" data-monitoring={phase.name === "monitoring"}>
        {hud}
        <div className="warroom__grid">
          <div className="warroom__left">
            <p className="warroom__hint">This device can’t draw the 3D office, so you get the map.</p>
            <ServiceMap cluster={cluster} scenario={watched} selected={selected} onSelect={setSelected} />
            {selected && <InspectPanel node={selected} cluster={cluster} scenario={scenario} onSuggest={setDraft} onClose={() => setSelected(null)} />}
            <Comms comms={comms} scenario={scenario} />
          </div>
          <Terminal {...terminalProps} />
        </div>
        {overlay}
      </main>
    );
  }

  return (
    <Immersive
      scenario={watched}
      incident={incident}
      comms={comms}
      hud={hud}
      selected={selected}
      onSelect={setSelected}
      terminalProps={terminalProps}
      onUseScreen={onUseScreen}
      overlay={overlay}
      isPaged={isPaged}
      team={team}
      role={role}
    />
  );
}

type ImmersiveProps = {
  scenario: Scenario;
  incident: Incident;
  comms: readonly CommsMessage[];
  hud: React.ReactNode;
  selected: NodeId | null;
  onSelect: (node: NodeId) => void;
  terminalProps: Parameters<typeof LaptopScreen>[0]["terminal"];
  onUseScreen: (screen: WallScreen) => void;
  overlay: React.ReactNode;
  isPaged: boolean;
  team?: TeamContext;
  role: Role;
};

/** "Maya Okonkwo · Support" → "Maya Okonkwo": one voice per person, whatever their title. */
const speakerOf = (message: CommsMessage) => message.from.split(" · ")[0];

function Immersive({ scenario, incident, comms, hud, selected, onSelect, terminalProps, onUseScreen, overlay, isPaged, team, role }: ImmersiveProps) {
  const { engine, voice } = getAudio();
  useAudioUnlock(engine);
  const [where, setWhere] = useState<Whereabouts>({ zone: "desk", surface: "carpet", rackProximity: 0 });
  const screenRef = useRef<HTMLDivElement>(null);
  const [isLaptopOpen, setLaptopOpen] = useState(false);
  const [tab, setTab] = useState<LaptopTab>("terminal");
  const [focusSignal, setFocusSignal] = useState(0);
  const settleTimer = useRef<number | undefined>(undefined);

  const openLaptop = useCallback((nextTab: LaptopTab) => {
    setTab(nextTab);
    setLaptopOpen(true);
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setFocusSignal((value) => value + 1), LAPTOP_SETTLE_MS);
  }, []);
  const closeLaptop = useCallback(() => setLaptopOpen(false), []);
  const toggleLaptop = useCallback(() => (isLaptopOpen ? closeLaptop() : openLaptop("terminal")), [closeLaptop, isLaptopOpen, openLaptop]);
  const inspect = useCallback(
    (node: NodeId) => {
      onSelect(node);
      openLaptop("inspect");
    },
    [onSelect, openLaptop],
  );

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  useSoundscape(engine, { panic: panicOf(incident, scenario), zone: where.zone, isLaptopOpen, rackProximity: where.rackProximity });

  // The page itself: phone buzzing on the desk, then the robot voice reading the alert.
  useEffect(() => {
    if (!isPaged) return;
    pagerBuzz(engine);
    void voice.speak(`${scenario.severity}. ${scenario.title}. ${scenario.service}, assigned to you.`, "PagerDuty", { priority: "urgent" });
  }, [engine, isPaged, scenario, voice]);

  // Every new message in the channel knocks, and the person says it out loud.
  const spoken = useRef(0);
  useEffect(() => {
    for (const message of comms.slice(spoken.current)) {
      notificationPing(engine);
      // The opening page is already read out by the pager above.
      if (message.from === "PagerDuty" && message.at === 0) continue;
      void voice.speak(message.text, speakerOf(message), { priority: message.from === "PagerDuty" ? "urgent" : "normal" });
    }
    spoken.current = comms.length;
  }, [comms, engine, voice]);

  useEffect(() => {
    if (isLaptopOpen) laptopOpen(engine);
  }, [engine, isLaptopOpen]);

  // Typing on the laptop sounds like typing.
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.length === 1 || event.key === "Backspace" || event.key === "Enter") keyClick(engine);
    };
    screen.addEventListener("keydown", onKey, { capture: true });
    return () => screen.removeEventListener("keydown", onKey, { capture: true });
  }, [engine]);

  const onStep = useCallback((surface: Whereabouts["surface"]) => footstep(engine, surface), [engine]);

  return (
    <main className="warroom warroom--immersive" data-monitoring={incident.phase.name === "monitoring"} data-laptop={isLaptopOpen ? "open" : "closed"}>
      <Suspense fallback={<p className="floor floor--loading">Badging into the office…</p>}>
        <FloorView
          cluster={incident.cluster}
          scenario={scenario}
          role={role}
          selected={selected}
          comms={comms}
          isLaptopOpen={isLaptopOpen}
          isOverlayOpen={overlay !== null && overlay !== undefined && overlay !== false}
          panic={panicOf(incident, scenario)}
          laptopScreenRef={screenRef}
          onInspect={inspect}
          onUseScreen={onUseScreen}
          onWhereabouts={setWhere}
          onStep={onStep}
          teammates={team?.teammates ?? []}
          selfAvatarSeed={team?.selfId ?? role}
          isPaged={isPaged}
          onPresence={team?.onPresence}
          onToggleLaptop={toggleLaptop}
        />
      </Suspense>
      {hud}
      <Comms comms={comms} scenario={scenario} isToast />
      {team && <TeamPanel team={team} />}
      <div ref={screenRef} className="laptop-screen" data-visible="false" aria-hidden={!isLaptopOpen}>
        {isLaptopOpen && (
          <LaptopScreen
            tab={tab}
            onTab={setTab}
            inspected={selected}
            cluster={incident.cluster}
            scenario={scenario}
            terminal={terminalProps}
            focusSignal={focusSignal}
            notification={comms.at(-1) ?? null}
            onClose={closeLaptop}
          />
        )}
      </div>
      {overlay}
      <p className="warroom__rotate">Turn your phone sideways for the office.</p>
    </main>
  );
}

function Comms({ comms, scenario, isToast = false }: { comms: readonly CommsMessage[]; scenario: Scenario; isToast?: boolean }) {
  return (
    <ol className={isToast ? "comms comms--toast" : "comms"} aria-label="#inc-checkout" aria-live="polite">
      {comms.slice(isToast ? -2 : -3).map((message) => (
        <li key={`${message.at}-${message.from}`} className="comms__message">
          <span className="comms__meta">
            {clockAt(scenario, message.at)} · {message.from}
          </span>
          <span>{message.text}</span>
        </li>
      ))}
    </ol>
  );
}

function TeamPanel({ team }: { team: TeamContext }) {
  return (
    <aside className="team" aria-label={`Room ${team.code}`}>
      <p className="team__code">
        Room <strong>{team.code}</strong> · {team.teammates.length + 1} on the bridge
      </p>
      <ol className="team__activity" aria-live="polite">
        {team.activity.slice(-4).map((item) => (
          <li key={item.key} data-change={item.isChange}>
            {item.text}
          </li>
        ))}
      </ol>
    </aside>
  );
}
