import { CanvasTexture, SRGBColorSpace } from "three";

type Card = {
  readonly lines: readonly string[];
  readonly background: string;
  readonly ink: string;
  /** Canvas pixels; the mesh sets the real size. */
  readonly width: number;
  readonly height: number;
  readonly font: "body" | "mono" | "display";
  readonly size: number;
};

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Short text on a flat card (name plates, sticky notes, a terminal) drawn from the design tokens. */
export function cardTexture({ lines, background, ink, width, height, font, size }: Card): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  context.fillStyle = token(background);
  context.fillRect(0, 0, width, height);
  context.fillStyle = token(ink);
  context.font = `500 ${size}px ${token(`--font-${font}`)}`;
  context.textBaseline = "top";
  const padding = Math.round(size * 0.7);
  const wrapped = lines.flatMap((line) => wrap(context, line, width - padding * 2));
  wrapped.forEach((line, index) => context.fillText(line, padding, padding + index * size * 1.3));
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const attempt = line ? `${line} ${word}` : word;
    if (context.measureText(attempt).width > width && line) {
      out.push(line);
      line = word;
    } else line = attempt;
  }
  if (line) out.push(line);
  return out;
}
