import type { KeyboardEvent } from "react";
import {
  databaseHealth as databaseHealthOf,
  deploymentHealth,
  edgeHealth as edgeHealthOf,
  HEALTH_GLYPH as GLYPH,
  HEALTH_WORD as WORD,
  podHealth,
  sameNode,
  visiblePods,
  type Health,
  type NodeId,
} from "../health.ts";
import type { Scenario } from "../scenario.ts";
import { openConnections } from "../sim/engine.ts";
import { isLive, type ClusterState } from "../sim/model.ts";

export type { NodeId } from "../health.ts";

const VIEW_WIDTH = 360;
const VIEW_HEIGHT = 196;
const EDGE = { x: 46, y: 76 };
const API = { x: 168, y: 86 };
const DATABASE = { x: 300, y: 124 };
const EXTERNAL = { x: 300, y: 26 };

type Props = {
  cluster: ClusterState;
  scenario: Scenario;
  selected: NodeId | null;
  onSelect: (node: NodeId) => void;
};

export function ServiceMap({ cluster, scenario, selected, onSelect }: Props) {
  const { externals } = scenario;
  const deployment = cluster.deployments[0];
  const pods = visiblePods(cluster);
  const connections = openConnections(cluster.deployments);
  const edgeHealth = edgeHealthOf(cluster, scenario);
  const databaseHealth = databaseHealthOf(cluster);
  const isSelected = (node: NodeId) => sameNode(node, selected);

  return (
    <svg className="map" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="group" aria-label="Service map — select a component to inspect it">
      <Link from={EDGE} to={API} state={edgeHealth} />
      <Link from={API} to={DATABASE} state={databaseHealth} />
      {externals.map((external) => (
        <Link key={external.id} from={API} to={EXTERNAL} state={external.status === "degraded" ? "warn" : "ok"} isDashed />
      ))}

      <Block
        node={{ kind: "edge" }}
        at={EDGE}
        size={22}
        height={16}
        label="edge-lb"
        detail={`${Math.round(cluster.errorRate * 100)}% 5xx`}
        health={edgeHealth}
        isSelected={isSelected({ kind: "edge" })}
        onSelect={onSelect}
      />

      {pods.map((pod, index) => {
        const offset = (index - (pods.length - 1) / 2) * 26;
        return (
          <Block
            key={pod.name}
            node={{ kind: "pod", name: pod.name }}
            at={{ x: API.x + offset, y: API.y + offset * 0.5 }}
            size={13}
            height={14}
            label=""
            detail=""
            health={podHealth(pod, deployment?.poolSize ?? 1)}
            isFading={pod.phase === "Terminating"}
            isSelected={isSelected({ kind: "pod", name: pod.name })}
            ariaLabel={`Pod ${pod.name}, ${WORD[podHealth(pod, deployment?.poolSize ?? 1)]}`}
            onSelect={onSelect}
          />
        );
      })}

      {deployment && (
        <g aria-hidden="true">
          <text className="map__label" data-health={deploymentHealth(pods, deployment.poolSize)} x={API.x} y={API.y + pods.length * 7 + 40} textAnchor="middle">
            {GLYPH[deploymentHealth(pods, deployment.poolSize)]} {deployment.name}
          </text>
          <text className="map__detail" x={API.x} y={API.y + pods.length * 7 + 52} textAnchor="middle">
            {pods.filter((pod) => pod.phase === "Running" && pod.leaked >= deployment.poolSize).length}/{pods.filter(isLive).length} pods starved
          </text>
        </g>
      )}

      <Block
        node={{ kind: "database" }}
        at={DATABASE}
        size={26}
        height={26}
        label={cluster.database.name}
        detail={`${connections}/${cluster.database.maxConnections} conn`}
        health={databaseHealth}
        isSelected={isSelected({ kind: "database" })}
        onSelect={onSelect}
      />

      {externals.map((external) => (
        <Block
          key={external.id}
          node={{ kind: "external", id: external.id }}
          at={EXTERNAL}
          size={20}
          height={12}
          label={external.id}
          detail="external"
          health={external.status === "degraded" ? "warn" : "ok"}
          isExternal
          isSelected={isSelected({ kind: "external", id: external.id })}
          onSelect={onSelect}
        />
      ))}
    </svg>
  );
}

type Point = { x: number; y: number };

function Link({ from, to, state, isDashed = false }: { from: Point; to: Point; state: Health; isDashed?: boolean }) {
  return (
    <g aria-hidden="true">
      <line className="map__link" data-dashed={isDashed} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
      <line className="map__flow" data-state={state} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
    </g>
  );
}

type BlockProps = {
  node: NodeId;
  at: Point;
  size: number;
  height: number;
  label: string;
  detail: string;
  health: Health;
  isSelected: boolean;
  isExternal?: boolean;
  isFading?: boolean;
  ariaLabel?: string;
  onSelect: (node: NodeId) => void;
};

/** An isometric block: top rhombus plus two shaded side faces. */
function Block({ node, at, size, height, label, detail, health, isSelected, isExternal, isFading, ariaLabel, onSelect }: BlockProps) {
  const { x, y } = at;
  const half = size / 2;
  const top = `${x},${y - half} ${x + size},${y} ${x},${y + half} ${x - size},${y}`;
  const left = `${x - size},${y} ${x},${y + half} ${x},${y + half + height} ${x - size},${y + height}`;
  const right = `${x + size},${y} ${x},${y + half} ${x},${y + half + height} ${x + size},${y + height}`;
  const select = () => onSelect(node);
  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  };

  return (
    <g
      className="map__node"
      data-health={health}
      data-selected={isSelected}
      data-external={isExternal}
      data-fading={isFading}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={ariaLabel ?? `${label}, ${WORD[health]}${detail ? `, ${detail}` : ""}`}
      onClick={select}
      onKeyDown={onKeyDown}
    >
      <rect className="map__hit" x={x - size - 8} y={y - half - 8} width={size * 2 + 16} height={half + height + size + 24} />
      <polygon className="map__face map__face--left" points={left} />
      <polygon className="map__face map__face--right" points={right} />
      <polygon className="map__face map__face--top" points={top} />
      <ellipse className="map__led" cx={x} cy={y} rx={size * 0.32} ry={size * 0.16} />
      {!label && (
        <text className="map__glyph" x={x} y={y - half - 3} textAnchor="middle" aria-hidden="true">
          {GLYPH[health]}
        </text>
      )}
      {label && (
        <text className="map__label" x={x} y={y + half + height + 14} textAnchor="middle">
          {GLYPH[health]} {label}
        </text>
      )}
      {detail && (
        <text className="map__detail" x={x} y={y + half + height + 26} textAnchor="middle">
          {detail}
        </text>
      )}
    </g>
  );
}
