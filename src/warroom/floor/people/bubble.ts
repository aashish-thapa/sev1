import { CanvasTexture, SRGBColorSpace } from "three";

/** A rounded name-and-text card drawn from the design tokens, for bubbles and name tags. */
export function bubbleTexture(name: string, text: string): CanvasTexture {
  const scale = 2;
  const width = 420;
  const styles = getComputedStyle(document.documentElement);
  const token = (key: string) => styles.getPropertyValue(key).trim();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const body = `400 20px ${token("--font-body")}`;
  context.font = body;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const attempt = line ? `${line} ${word}` : word;
    if (context.measureText(attempt).width > width - 36 && line) {
      lines.push(line);
      line = word;
    } else {
      line = attempt;
    }
  }
  if (line) lines.push(line);
  const height = 56 + lines.length * 26;
  canvas.width = width * scale;
  canvas.height = height * scale;
  context.scale(scale, scale);
  context.fillStyle = token("--color-paper-2");
  context.beginPath();
  context.roundRect(0, 0, width, height, 14);
  context.fill();
  context.fillStyle = token("--color-accent");
  context.font = `600 18px ${token("--font-mono")}`;
  context.fillText(name, 18, 30);
  context.fillStyle = token("--color-ink");
  context.font = body;
  lines.forEach((text, index) => context.fillText(text, 18, 58 + index * 26));
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
