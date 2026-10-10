import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IncidentPackSchema } from "../src/domain/incident.ts";

const packsDir = join(import.meta.dirname, "..", "src", "content", "packs");
/** A visibly longer correct option is a tell; small differences are invisible on screen. */
const MAX_ANSWER_LENGTH_LEAD = 4;
const seenIds = new Map<string, string>();
let failures = 0;
let total = 0;

for (const file of readdirSync(packsDir).filter((name) => name.endsWith(".json")).sort()) {
  const raw: unknown = JSON.parse(readFileSync(join(packsDir, file), "utf8"));
  const parsed = IncidentPackSchema.safeParse(raw);
  if (!parsed.success) {
    failures += 1;
    console.error(`✗ ${file}\n${z.prettifyError(parsed.error)}\n`);
    continue;
  }
  for (const card of parsed.data) {
    if (card.kind === "diagnose") {
      const answerLength = card.options[card.answer].length;
      const longestOther = Math.max(...card.options.filter((_, index) => index !== card.answer).map((option) => option.length));
      if (answerLength - longestOther > MAX_ANSWER_LENGTH_LEAD) {
        failures += 1;
        console.error(`✗ ${card.id}: answer is ${answerLength - longestOther} chars longer than every distractor — length gives it away`);
      }
    }
    const owner = seenIds.get(card.id);
    if (owner) {
      failures += 1;
      console.error(`✗ duplicate id "${card.id}" in ${file} (first seen in ${owner})`);
    }
    seenIds.set(card.id, file);
  }
  total += parsed.data.length;
  console.log(`✓ ${file} — ${parsed.data.length} cards`);
}

console.log(`\n${total} cards total`);
if (failures > 0) process.exit(1);
