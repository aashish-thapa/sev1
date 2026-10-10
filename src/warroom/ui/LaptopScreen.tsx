import type { NodeId } from "../health.ts";
import { clockAt, type CommsMessage, type Scenario } from "../scenario.ts";
import type { ClusterState } from "../sim/model.ts";
import { HelpPanel } from "./HelpPanel.tsx";
import { useIncidentHelp } from "./incident-help.ts";
import { InspectPanel } from "./InspectPanel.tsx";
import { Terminal } from "./Terminal.tsx";
import { useLaptopApps } from "./laptop-apps.ts";
import type { TerminalLine } from "./useIncident.ts";

/** The shell, what you last plugged into, help, or one of the place's apps. */
export type LaptopTab = "terminal" | "inspect" | "help" | `app:${string}`;

type Props = {
  tab: LaptopTab;
  onTab: (tab: LaptopTab) => void;
  inspected: NodeId | null;
  cluster: ClusterState;
  scenario: Scenario;
  terminal: {
    lines: readonly TerminalLine[];
    history: readonly string[];
    draft: string;
    onDraftChange: (draft: string) => void;
    onRun: (line: string) => void;
    onComplete: (line: string) => { line: string; candidates: readonly string[] };
    suggestions: readonly string[];
    isDisabled: boolean;
    prompt: string;
  };
  focusSignal: number;
  /** The newest channel message, shown like a desktop notification on the screen. */
  notification: CommsMessage | null;
  onClose: () => void;
};

const inspectTitle = (node: NodeId) => (node.kind === "pod" ? `…${node.name.slice(-5)}` : node.kind === "external" ? node.id : node.kind === "edge" ? "edge-lb" : "orders-db");

/** What's on your laptop: the bastion shell, and the last thing you plugged into. */
export function LaptopScreen({ tab, onTab, inspected, cluster, scenario, terminal, focusSignal, notification, onClose }: Props) {
  const help = useIncidentHelp();
  const apps = useLaptopApps();
  const app = apps.find((candidate) => tab === `app:${candidate.id}`) ?? null;
  const suggest = (command: string) => {
    terminal.onDraftChange(command);
    onTab("terminal");
  };
  return (
    <div className="laptop">
      <div className="laptop__bar" role="tablist" aria-label="Laptop">
        {apps.map((candidate) => (
          <button key={candidate.id} type="button" role="tab" className="laptop__tab" aria-selected={app === candidate} onClick={() => onTab(`app:${candidate.id}`)}>
            {candidate.title}
          </button>
        ))}
        <button type="button" role="tab" className="laptop__tab" aria-selected={tab === "terminal"} onClick={() => onTab("terminal")}>
          Terminal
        </button>
        {inspected && (
          <button type="button" role="tab" className="laptop__tab" aria-selected={tab === "inspect"} onClick={() => onTab("inspect")}>
            {inspectTitle(inspected)}
          </button>
        )}
        {help && (
          <button type="button" role="tab" className="laptop__tab" aria-selected={tab === "help"} onClick={() => onTab("help")}>
            Help
          </button>
        )}
        <button type="button" className="laptop__close" onClick={onClose}>
          <kbd>Esc</kbd> Lower
        </button>
      </div>
      {notification && cluster.t - notification.at < 30 && (
        <p key={`${notification.at}-${notification.from}`} className="laptop__notification" role="status">
          <span className="comms__meta">
            {clockAt(scenario, notification.at)} · {notification.from}
          </span>
          {notification.text}
        </p>
      )}
      <div className="laptop__body" role="tabpanel">
        {app ? (
          app.render()
        ) : tab === "help" && help ? (
          <HelpPanel help={help} onSuggest={suggest} />
        ) : tab === "inspect" && inspected ? (
          <InspectPanel
            node={inspected}
            cluster={cluster}
            scenario={scenario}
            onSuggest={suggest}
            onClose={() => onTab("terminal")}
          />
        ) : (
          <Terminal {...terminal} onEscape={onClose} focusSignal={focusSignal} />
        )}
      </div>
    </div>
  );
}
