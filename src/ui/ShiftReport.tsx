import { useState } from "react";
import type { Run } from "../app/useShiftGame.ts";
import type { Topic } from "../domain/incident.ts";
import { liveStreak, type Progress } from "../domain/progress.ts";
import { overallRating, STARTING_RATING } from "../domain/rating.ts";
import type { LedgerEntry } from "../domain/economy.ts";
import { shareText } from "../domain/share.ts";
import { Payslip } from "./Payslip.tsx";

type Props = {
  run: Run;
  progress: Progress;
  /** What this discussion paid: one line per correct call. */
  earnings: readonly LedgerEntry[];
  shareUrl: string;
  onDone: () => void;
};

const TOPIC_LABEL: Record<Topic, string> = {
  database: "Databases",
  network: "Networking",
  "dns-tls": "DNS & TLS",
  kubernetes: "Kubernetes",
  deploys: "Deploys",
  caching: "Caching",
  queues: "Queues",
  cloud: "Cloud",
  runtime: "Runtimes",
  frontend: "Frontend",
  "web-performance": "Web performance",
  mobile: "Mobile",
  security: "Security",
  "data-pipelines": "Data pipelines",
  "machine-learning": "Machine learning",
};

export function ShiftReport({ run, progress, earnings, shareUrl, onDone }: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const results = run.attempts.map((attempt) => attempt.isCorrect);
  const correct = results.filter(Boolean).length;
  const isRated = run.mode === "rated";
  const ratingAfter = overallRating(progress.ratings);
  const ratingDelta = ratingAfter - run.ratingBefore;
  const medianSeconds = median(run.attempts.map((attempt) => attempt.elapsedMs)) / 1000;
  const topics = [...new Set(run.attempts.map((attempt) => attempt.topic))];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareText(run.day, results, liveStreak(progress, run.day), shareUrl));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2500);
    } catch (error) {
      if (!(error instanceof DOMException) && !(error instanceof TypeError)) throw error;
      setCopyState("failed");
    }
  };

  return (
    <main className="report">
      <h1 className="report__display">
        {correct} of {results.length}
        <span className="report__display-sub">{isRated ? "resolved on tonight’s shift" : "resolved in practice"}</span>
      </h1>

      <ol className="report__marks" aria-label="Page by page">
        {results.map((isCorrect, index) => (
          <li key={index} data-state={isCorrect ? "resolved" : "missed"}>
            <span aria-hidden="true">{isCorrect ? "✓" : "✗"}</span>
            <span className="visually-hidden">Page {index + 1}: {isCorrect ? "resolved" : "missed"}</span>
          </li>
        ))}
      </ol>

      <dl className="report__figures">
        <div>
          <dt>Median call</dt>
          <dd>{medianSeconds.toFixed(1)} s</dd>
        </div>
        {isRated && (
          <div>
            <dt>Rating</dt>
            <dd>
              {ratingAfter}
              <span className="report__delta">{ratingDelta >= 0 ? `+${ratingDelta}` : `−${Math.abs(ratingDelta)}`}</span>
            </dd>
          </div>
        )}
      </dl>

      {isRated && (
        <table className="report__topics">
          <caption>Rating by area</caption>
          <tbody>
            {topics.map((topic) => (
              <tr key={topic}>
                <th scope="row">{TOPIC_LABEL[topic]}</th>
                <td>{progress.ratings[topic] ?? STARTING_RATING}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Payslip entries={earnings} emptyNote="No correct calls this round — nothing to pay." />

      <div className="report__actions">
        {isRated && (
          <button type="button" className="button button--primary" data-state={copyState} onClick={copy}>
            {copyState === "copied" ? "Copied ✓" : copyState === "failed" ? "Copy blocked" : "Copy result"}
          </button>
        )}
        <button type="button" className="button button--ghost" onClick={onDone}>
          Back to the office
        </button>
      </div>
      {copyState === "failed" && (
        <p className="report__note" role="status">
          Your browser blocked clipboard access. Select the marks above and copy them by hand.
        </p>
      )}
    </main>
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
