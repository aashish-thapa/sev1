import { CanvasTexture, SRGBColorSpace } from "three";
import { formatCents } from "../../../domain/economy.ts";
import type { BoardFigures } from "./plan.ts";

const WIDTH = 768;
const HEIGHT = 432;
const PADDING = 44;

/** The company's board: its name, the bank balance large (left blank for a visitor), and a bar of today's traffic its servers can take. */
export function boardTexture({ name, fundsCents, trafficPercent }: BoardFigures): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const styles = getComputedStyle(document.documentElement);
  const token = (tokenName: string) => styles.getPropertyValue(tokenName).trim();

  context.fillStyle = token("--color-terminal");
  context.fillRect(0, 0, WIDTH, HEIGHT);

  context.textBaseline = "alphabetic";
  context.fillStyle = token("--color-muted");
  context.font = `600 30px ${token("--font-mono")}`;
  context.fillText(fit(context, name, WIDTH - PADDING * 2), PADDING, 74);

  if (fundsCents !== null) {
    context.fillStyle = token(fundsCents < 0 ? "--color-critical" : "--color-ink");
    context.font = `800 92px ${token("--font-display")}`;
    context.fillText(fit(context, formatCents(fundsCents), WIDTH - PADDING * 2), PADDING, 210);
  }

  // Traffic: a bar that fills as servers are bought, green once every request is served.
  const barY = 300;
  const barWidth = WIDTH - PADDING * 2;
  context.fillStyle = token("--color-rule-strong");
  context.fillRect(PADDING, barY, barWidth, 22);
  context.fillStyle = token(trafficPercent >= 100 ? "--color-good" : trafficPercent >= 50 ? "--color-accent" : "--color-critical");
  context.fillRect(PADDING, barY, Math.round((barWidth * Math.min(100, trafficPercent)) / 100), 22);
  context.fillStyle = token("--color-ink-2");
  context.font = `500 34px ${token("--font-mono")}`;
  context.fillText(`${trafficPercent}%`, PADDING, barY + 80);
  context.textAlign = "right";
  context.fillStyle = token("--color-muted");
  context.fillText("traffic", WIDTH - PADDING, barY + 80);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Trims a line with an ellipsis until it fits, so a long company name never runs off the screen. */
function fit(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  let trimmed = text;
  while (trimmed.length > 1 && context.measureText(`${trimmed}…`).width > width) trimmed = trimmed.slice(0, -1);
  return `${trimmed}…`;
}
