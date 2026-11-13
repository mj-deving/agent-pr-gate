// Runs the detector over the benchmark and writes results/<date>-<set>.{json,md}.
// Usage: bun bench/run.ts [--set dev|heldout|all]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DETECTOR_VERSION, detect, type DefectClass } from "../src/detect.ts";

interface Case {
  id: string;
  set: "dev" | "heldout";
  planted: boolean;
  expected: { class: DefectClass; file: string }[];
  also_acceptable?: DefectClass[];
}

const CLASSES: DefectClass[] = [
  "skip", "only", "type-suppress", "lint-suppress", "assert-removed", "test-deleted", "threshold-lowered",
];

const root = join(import.meta.dir, "..");
const setArg = process.argv.indexOf("--set");
const set = setArg >= 0 ? process.argv[setArg + 1] : "all";
if (!["dev", "heldout", "all"].includes(set ?? "")) throw new Error(`--set must be dev, heldout or all, got ${set}`);

const manifestText = readFileSync(join(root, "bench/manifest.jsonl"), "utf8");
const datasetVersion = createHash("sha256").update(manifestText).digest("hex").slice(0, 12);
const cases: Case[] = manifestText
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Case)
  .filter((c) => set === "all" || c.set === set);

const tally = Object.fromEntries(CLASSES.map((k) => [k, { tp: 0, fn: 0, fp: 0 }]));
const failures: { id: string; kind: "missed" | "false-alarm"; class: string; file: string; text?: string }[] = [];
let cleanFlagged = 0;
let cleanTotal = 0;

for (const c of cases) {
  const findings = detect(readFileSync(join(root, "bench/diffs", `${c.id}.diff`), "utf8"))
    .filter((f) => f.class !== "out-of-scope" && !f.allowed);
  const used = new Set<number>();
  for (const e of c.expected) {
    const i = findings.findIndex((f, j) => !used.has(j) && f.class === e.class && f.file === e.file);
    if (i >= 0) {
      tally[e.class]!.tp++;
      // Further findings of the same class in the same file belong to the same planted defect.
      findings.forEach((f, j) => { if (f.class === e.class && f.file === e.file) used.add(j); });
    } else {
      tally[e.class]!.fn++;
      failures.push({ id: c.id, kind: "missed", class: e.class, file: e.file });
    }
  }
  let extra = 0;
  findings.forEach((f, j) => {
    if (used.has(j) || c.also_acceptable?.includes(f.class)) return;
    tally[f.class]!.fp++;
    extra++;
    failures.push({ id: c.id, kind: "false-alarm", class: f.class, file: f.file, text: f.text.trim().slice(0, 120) });
  });
  if (!c.planted) {
    cleanTotal++;
    if (extra > 0) cleanFlagged++;
  }
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
const perClass = CLASSES.map((k) => {
  const t = tally[k]!;
  return { class: k, ...t, recall: pct(t.tp, t.tp + t.fn), precision: pct(t.tp, t.tp + t.fp) };
});
const sum = (key: "tp" | "fn" | "fp") => perClass.reduce((a, r) => a + r[key], 0);
const result = {
  date: new Date().toISOString().slice(0, 10),
  set,
  detectorVersion: DETECTOR_VERSION,
  datasetVersion,
  cases: cases.length,
  overall: { recall: pct(sum("tp"), sum("tp") + sum("fn")), precision: pct(sum("tp"), sum("tp") + sum("fp")) },
  cleanFalseAlarmRate: pct(cleanFlagged, cleanTotal),
  cleanFlagged,
  cleanTotal,
  perClass,
  failures,
};

const fmt = (v: number | null) => (v === null ? "–" : `${v} %`);
const md = [
  `# Bench ${result.date} · set ${set}`,
  "",
  `Detector ${DETECTOR_VERSION} · dataset ${datasetVersion} · ${cases.length} cases`,
  "",
  `Overall recall ${fmt(result.overall.recall)}, precision ${fmt(result.overall.precision)}, clean diffs flagged ${cleanFlagged}/${cleanTotal} (${fmt(result.cleanFalseAlarmRate)}).`,
  "",
  "| class | TP | FN | FP | recall | precision |",
  "|---|---|---|---|---|---|",
  ...perClass.map((r) => `| ${r.class} | ${r.tp} | ${r.fn} | ${r.fp} | ${fmt(r.recall)} | ${fmt(r.precision)} |`),
  "",
  "## Failures",
  "",
  ...(failures.length ? failures.map((f) => `- ${f.id}: ${f.kind} \`${f.class}\` in \`${f.file}\`${f.text ? ` — \`${f.text}\`` : ""}`) : ["none"]),
  "",
].join("\n");

mkdirSync(join(root, "results"), { recursive: true });
const base = join(root, "results", `${result.date}-${set}`);
writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(`${base}.md`, md);
console.log(md);
