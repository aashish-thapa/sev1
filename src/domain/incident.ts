import { z } from "zod";

export const TOPICS = [
  "database",
  "network",
  "dns-tls",
  "kubernetes",
  "deploys",
  "caching",
  "queues",
  "cloud",
  "runtime",
  "frontend",
  "web-performance",
  "mobile",
  "security",
  "data-pipelines",
  "machine-learning",
] as const;
export type Topic = (typeof TOPICS)[number];

/** A role is the job a player plays; each topic belongs to exactly one role. */
export const ROLES = {
  infrastructure: ["database", "network", "dns-tls", "kubernetes", "deploys", "caching", "queues", "cloud", "runtime"],
  frontend: ["frontend", "web-performance"],
  mobile: ["mobile"],
  security: ["security"],
  data: ["data-pipelines", "machine-learning"],
} as const satisfies Record<string, readonly Topic[]>;
export type Role = keyof typeof ROLES;
export const ROLE_IDS = Object.keys(ROLES) as Role[];

export function roleOf(topic: Topic): Role {
  const role = ROLE_IDS.find((id) => (ROLES[id] as readonly Topic[]).includes(topic));
  if (!role) throw new Error(`topic ${topic} belongs to no role`);
  return role;
}

const MetricEvidence = z.object({
  type: z.literal("metric"),
  label: z.string().min(1).max(48),
  unit: z.string().max(12),
  points: z.array(z.number()).min(8).max(60),
  markAt: z.int().nonnegative().optional(),
});

const LogLine = z.object({
  ts: z.string().min(1).max(24),
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]),
  source: z.string().max(32).optional(),
  text: z.string().min(1).max(220),
});

const LogEvidence = z.object({
  type: z.literal("log"),
  label: z.string().min(1).max(48),
  lines: z.array(LogLine).min(2).max(14),
});

const FactsEvidence = z.object({
  type: z.literal("facts"),
  label: z.string().min(1).max(48),
  items: z
    .array(z.object({ key: z.string().min(1).max(32), value: z.string().min(1).max(80) }))
    .min(1)
    .max(6),
});

const CODE_LANGUAGES = ["ts", "tsx", "js", "jsx", "css", "html", "swift", "kotlin", "java", "python", "sql", "go", "rust", "yaml", "json", "bash", "diff"] as const;

const CodeEvidence = z.object({
  type: z.literal("code"),
  label: z.string().min(1).max(48),
  language: z.enum(CODE_LANGUAGES),
  /** Line number of the first line, so snippets can show where they sit in the file. */
  startLine: z.int().positive().default(1),
  lines: z.array(z.string().max(100)).min(2).max(24),
});

const Evidence = z.discriminatedUnion("type", [MetricEvidence, LogEvidence, FactsEvidence, CodeEvidence]);

const Alert = z.object({
  service: z.string().min(1).max(32),
  title: z.string().min(1).max(72),
  severity: z.enum(["SEV1", "SEV2", "SEV3"]),
  firedAt: z.string().regex(/^\d{2}:\d{2}$/),
});

const Explanation = z.object({
  cause: z.string().min(1).max(90),
  why: z.string().min(1).max(340),
  tell: z.string().min(1).max(200),
});

const Source = z.object({ title: z.string().min(1).max(120), url: z.url() });

const CardBase = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  topic: z.enum(TOPICS),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  alert: Alert,
  evidence: z.array(Evidence).min(1).max(3),
  question: z.string().min(1).max(80),
  explanation: Explanation,
  source: Source.optional(),
});

const DiagnoseCard = CardBase.extend({
  kind: z.literal("diagnose"),
  options: z.array(z.string().min(1).max(64)).length(4),
  answer: z.int().min(0).max(3),
});

const FindLineCard = CardBase.extend({
  kind: z.literal("find-line"),
  answer: z.object({ evidence: z.int().nonnegative(), line: z.int().nonnegative() }),
});

export const IncidentCardSchema = z
  .discriminatedUnion("kind", [DiagnoseCard, FindLineCard])
  .superRefine((card, ctx) => {
    card.evidence.forEach((item, index) => {
      if (item.type === "metric" && item.markAt !== undefined && item.markAt >= item.points.length) {
        ctx.addIssue({ code: "custom", path: ["evidence", index, "markAt"], message: "markAt is past the last point" });
      }
    });
    if (card.kind === "diagnose" && new Set(card.options).size !== card.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "options must be distinct" });
    }
    if (card.kind === "find-line") {
      const target = card.evidence[card.answer.evidence];
      if (target?.type !== "log" && target?.type !== "code") {
        ctx.addIssue({ code: "custom", path: ["answer", "evidence"], message: "answer must point at a log or code evidence block" });
      } else if (card.answer.line >= target.lines.length) {
        ctx.addIssue({ code: "custom", path: ["answer", "line"], message: "answer line is out of range" });
      }
    }
  });

export const IncidentPackSchema = z.array(IncidentCardSchema).min(1);

export type IncidentCard = z.infer<typeof IncidentCardSchema>;
export type DiagnoseIncident = Extract<IncidentCard, { kind: "diagnose" }>;
export type FindLineIncident = Extract<IncidentCard, { kind: "find-line" }>;
export type EvidenceItem = IncidentCard["evidence"][number];
export type MetricEvidenceItem = Extract<EvidenceItem, { type: "metric" }>;
export type LogEvidenceItem = Extract<EvidenceItem, { type: "log" }>;
export type FactsEvidenceItem = Extract<EvidenceItem, { type: "facts" }>;
export type CodeEvidenceItem = Extract<EvidenceItem, { type: "code" }>;
