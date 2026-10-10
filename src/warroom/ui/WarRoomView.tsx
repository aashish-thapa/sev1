import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../../app/wallet-context.ts";
import { INCIDENT_MIN_POINTS } from "../../domain/economy.ts";
import { AnswerPad } from "../../ui/AnswerPad.tsx";
import { Payslip } from "../../ui/Payslip.tsx";
import { debrief, type Debrief, type Incident } from "../incident.ts";
import type { Role } from "../../domain/incident.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import type { Scenario } from "../scenario.ts";
import type { WallScreen } from "../floor/office.ts";
import type { useRoom } from "../../multiplayer/useRoom.ts";
import { SoloIncident } from "./LiveIncident.tsx";
import { TeamIncident } from "./TeamIncident.tsx";

/** One stint in the office: when it began (names the incident's bonus) and where its payslip starts in the ledger. */
type Visit = { readonly startedAt: number; readonly paidFromSeq: number };

type Stage =
  | { readonly name: "office"; readonly isPaged: boolean; readonly run: number; readonly visit: Visit }
  | { readonly name: "postmortem"; readonly incident: Incident; readonly picked: number | null; readonly visit: Visit }
  | { readonly name: "debrief"; readonly result: Debrief; readonly visit: Visit };

type Props = {
  scenario: Scenario;
  role: Role;
  /** `startedAt`: epoch ms this incident run began — a stable name for its bonus. */
  onFinish: (result: Debrief, startedAt: number) => void;
  onLeave: () => void;
  onUseScreen: (screen: WallScreen) => void;
  /** Called when the pager goes off, so whatever the player was doing can be interrupted. */
  onPaged: () => void;
  overlay: React.ReactNode;
  /** Present when this office is a shared room on the server. */
  room?: ReturnType<typeof useRoom>;
};

const countFormat = new Intl.NumberFormat("en");

/** Quiet time before the pager goes off on its own: one to two minutes. */
const AUTO_PAGE_MS = { min: 60_000, spread: 60_000 } as const;

/** The office: quiet until the pager goes off, then the live incident, postmortem and debrief. */
export function WarRoomView({ scenario, role, onFinish, onLeave, onUseScreen, onPaged, overlay, room }: Props) {
  const wallet = useWallet();
  const [stage, setStage] = useState<Stage>(() => ({ name: "office", isPaged: false, run: 0, visit: { startedAt: Date.now(), paidFromSeq: wallet.nextSeq } }));
  const onClosed = useCallback((incident: Incident) => setStage((current) => ({ name: "postmortem", incident, picked: null, visit: current.visit })), []);
  const isQuiet = stage.name === "office" && !stage.isPaged;
  const run = stage.name === "office" ? stage.run : 0;

  const page = useCallback(() => {
    setStage((current) => (current.name === "office" ? { ...current, isPaged: true } : current));
    onPaged();
  }, [onPaged]);

  useEffect(() => {
    if (!isQuiet || room) return;
    const timer = window.setTimeout(page, AUTO_PAGE_MS.min + Math.random() * AUTO_PAGE_MS.spread);
    return () => window.clearTimeout(timer);
  }, [isQuiet, page, room, run]);

  if (stage.name === "office" && room) {
    return <TeamIncident room={room} scenario={scenario} role={role} overlay={overlay} onUseScreen={onUseScreen} onClosed={onClosed} onLeave={onLeave} />;
  }

  if (stage.name === "office") {
    return (
      <SoloIncident
        key={stage.run}
        scenario={scenario}
        role={role}
        isPaged={stage.isPaged}
        onPage={page}
        onClosed={onClosed}
        onLeave={onLeave}
        onUseScreen={onUseScreen}
        overlay={overlay}
      />
    );
  }

  if (stage.name === "postmortem") {
    const { postmortem } = scenario;
    const pick = (index: number) => setStage({ ...stage, picked: index });
    return (
      <main className="postmortem">
        <p className="paged__source">Incident closed · postmortem</p>
        <h1 className="postmortem__question">{postmortem.question}</h1>
        <AnswerPad options={postmortem.options} answerIndex={postmortem.answerIndex} pickedIndex={stage.picked} onPick={pick} />
        {stage.picked !== null && (
          <section className="reveal" aria-live="polite">
            <h2 className="reveal__cause">{postmortem.explanation.cause}</h2>
            <p className="reveal__why">{postmortem.explanation.why}</p>
            <p className="reveal__tell">
              <strong>The tell</strong> {postmortem.explanation.tell}
            </p>
            <button
              type="button"
              className="button button--primary reveal__next"
              onClick={() => {
                const result = debrief(stage.incident, scenario, stage.picked === postmortem.answerIndex);
                onFinish(result, stage.visit.startedAt);
                setStage({ name: "debrief", result, visit: stage.visit });
              }}
            >
              See your grade
            </button>
          </section>
        )}
      </main>
    );
  }

  const { result } = stage;
  const earnings = wallet.ledger.filter((entry) => entry.seq >= stage.visit.paidFromSeq);
  return (
    <main className="debrief">
      <p className="paged__source">{scenario.title} · debrief</p>
      <h1 className="debrief__grade" data-grade={result.grade}>
        {result.grade}
        <span className="debrief__points">{result.points} / 100</span>
      </h1>
      <dl className="debrief__figures">
        <div>
          <dt>Failed checkouts</dt>
          <dd>{countFormat.format(result.failedCheckouts)}</dd>
        </div>
        <div>
          <dt>Declared resolved after</dt>
          <dd>{result.minutesToResolve} min</dd>
        </div>
        <div>
          <dt>Re-pages</dt>
          <dd>{result.reopenCount}</dd>
        </div>
        <div>
          <dt>Crash loops you caused</dt>
          <dd>{result.crashLoopsCaused}</dd>
        </div>
      </dl>
      <ul className="debrief__notes">
        <li>{result.isRootCauseFixed ? "✓ Root cause removed from production." : "✗ The faulty build was still running when the incident closed."}</li>
        <li>{result.isPostmortemCorrect ? "✓ Postmortem named the real cause." : "✗ Postmortem named the wrong cause."}</li>
        {result.objectives?.map((objective) => (
          <li key={objective.label}>
            {objective.isMet ? "✓" : "✗"} {ROLE_INFO[objective.role].label}: {objective.label}
          </li>
        ))}
      </ul>
      <Payslip entries={earnings} emptyNote={`No resolution bonus below ${INCIDENT_MIN_POINTS} points — the fix did more harm than good.`} />
      <div className="paged__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => (room ? onLeave() : setStage({ name: "office", isPaged: false, run: Date.now(), visit: { startedAt: Date.now(), paidFromSeq: wallet.nextSeq } }))}
        >
          {room ? "Leave the room" : "Back to the office"}
        </button>
        <button type="button" className="button button--ghost" onClick={onLeave}>
          Leave for today
        </button>
      </div>
    </main>
  );
}
