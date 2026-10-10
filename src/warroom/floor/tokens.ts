import { CanvasTexture, Color, SRGBColorSpace } from "three";
import { HEALTH_GLYPH, type Health } from "../health.ts";

const colorCache = new Map<string, Color>();

/**
 * Reads a design token (e.g. `--color-critical`) and converts it to a three.js colour.
 * Tokens are OKLCH, which three can't parse, so the browser paints one pixel and we read it back.
 */
export function tokenColor(name: string): Color {
  const cached = colorCache.get(name);
  if (cached) return cached;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !value) throw new Error(`design token ${name} is not defined`);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  const color = new Color().setRGB(red / 255, green / 255, blue / 255, SRGBColorSpace);
  colorCache.set(name, color);
  return color;
}

export const HEALTH_TOKEN: Record<Health, string> = {
  ok: "--color-good",
  warn: "--color-accent",
  critical: "--color-critical",
  pending: "--color-muted",
};

/** A sign texture drawn with the page's own fonts, so 3D labels match the 2D UI. */
export function signTexture(title: string, caption: string, health: Health | null): CanvasTexture {
  const scale = 2;
  const width = 320;
  const height = caption ? 96 : 64;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  context.scale(scale, scale);

  const styles = getComputedStyle(document.documentElement);
  const mono = styles.getPropertyValue("--font-mono").trim();
  context.fillStyle = styles.getPropertyValue("--color-paper-2").trim();
  context.beginPath();
  context.roundRect(0, 0, width, height, 10);
  context.fill();

  context.textBaseline = "middle";
  context.font = `600 26px ${mono}`;
  context.fillStyle = styles.getPropertyValue(health ? `--color-${health === "critical" ? "critical" : "ink"}` : "--color-ink").trim();
  context.fillText(`${health ? `${HEALTH_GLYPH[health]} ` : ""}${title}`, 16, caption ? 32 : height / 2);
  if (caption) {
    context.font = `400 20px ${mono}`;
    context.fillStyle = styles.getPropertyValue("--color-muted").trim();
    context.fillText(caption, 16, 68);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
