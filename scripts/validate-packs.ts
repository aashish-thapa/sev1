import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IncidentPackSchema } from "../src/domain/incident.ts";
import { TaskPackSchema } from "../src/domain/work/task.ts";

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

// Daily-work tasks: bug fixes and PR reviews.
const tasksDir = join(import.meta.dirname, "..", "src", "content", "tasks");
let taskTotal = 0;
for (const file of readdirSync(tasksDir).filter((name) => name.endsWith(".json")).sort()) {
  const raw: unknown = JSON.parse(readFileSync(join(tasksDir, file), "utf8"));
  const parsed = TaskPackSchema.safeParse(raw);
  if (!parsed.success) {
    failures += 1;
    console.error(`✗ tasks/${file}\n${z.prettifyError(parsed.error)}\n`);
    continue;
  }
  for (const task of parsed.data) {
    if (task.kind === "code-fix") {
      const answerLength = task.fixes[task.fixAnswer].length;
      const longestOther = Math.max(...task.fixes.filter((_, index) => index !== task.fixAnswer).map((fix) => fix.length));
      // Fixes are code, so the right one may need a few more characters; a wide lead still gives it away.
      if (answerLength - longestOther > MAX_ANSWER_LENGTH_LEAD * 4) {
        failures += 1;
        console.error(`✗ ${task.id}: the right fix is ${answerLength - longestOther} chars longer than every other — length gives it away`);
      }
    }
    const owner = seenIds.get(task.id);
    if (owner) {
      failures += 1;
      console.error(`✗ duplicate id "${task.id}" in tasks/${file} (first seen in ${owner})`);
    }
    seenIds.set(task.id, `tasks/${file}`);
  }
  taskTotal += parsed.data.length;
  console.log(`✓ tasks/${file} — ${parsed.data.length} tasks`);
}
console.log(`${taskTotal} tasks total`);
if (failures > 0) process.exit(1);
