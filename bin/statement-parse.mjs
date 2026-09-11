#!/usr/bin/env node
/**
 * statement-parse — bank CSV in, clean transactions out.
 *   statement-parse statement.csv [more.csv ...] [--csv | --json] [--rules rules.json] [--month-first]
 * Prints a summary table by default; --csv writes clean CSV to stdout; --json writes JSON.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const libPath = join(here, "..", "dist", "lib", "index.js");
if (!existsSync(libPath)) { console.error("Library not built. Run: npm run build:lib"); process.exit(1); }
const lib = await import(libPath);

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--") && !(args[args.indexOf(a) - 1] === "--rules"));
const wantCsv = args.includes("--csv"), wantJson = args.includes("--json");
const rulesIdx = args.indexOf("--rules");
const monthFirst = args.includes("--month-first");
if (!files.length) { console.error("Usage: statement-parse <file.csv> [...] [--csv|--json] [--rules rules.json] [--month-first]"); process.exit(1); }

let rules = lib.DEFAULT_RULES;
if (rulesIdx >= 0) {
  const user = JSON.parse(readFileSync(args[rulesIdx + 1], "utf8"));
  rules = lib.mergeRules(user, lib.DEFAULT_RULES);
}
const results = files.map((f) => lib.parseStatement(readFileSync(f, "utf8"), { fileName: f, dayFirstDefault: !monthFirst }));
for (const r of results) for (const w of r.warnings) console.error(`[${r.transactions[0]?.source || "?"}] ${w}`);
const merged = lib.mergeStatements(results);
const txs = lib.categoriseAll(merged.transactions, rules, false);

if (wantCsv) { process.stdout.write(lib.toCleanCsv(txs)); process.exit(0); }
if (wantJson) { process.stdout.write(lib.toJson(txs) + "\n"); process.exit(0); }

const s = lib.summary(txs);
const cur = s.currency || "";
const money = (n) => `${cur ? cur + " " : ""}${n.toFixed(2)}`;
console.log(`\n${txs.length} transactions  ${s.from} → ${s.to}  (${merged.duplicatesRemoved} duplicates removed across files)`);
console.log(`Money out ${money(s.totalOut)}   Money in ${money(s.totalIn)}   Net ${money(s.net)}   Transfers ${s.transfers}   Uncategorised ${s.uncategorised}\n`);
console.log("By month");
for (const m of lib.monthly(txs)) console.log(`  ${m.month}  out ${money(m.out).padStart(14)}  in ${money(m.in).padStart(14)}  net ${money(m.net).padStart(14)}`);
console.log("\nBy category");
for (const c of lib.byCategory(txs)) console.log(`  ${c.category.padEnd(18)} ${money(c.total).padStart(14)}  ${String(c.share).padStart(5)}%  (${c.count})`);
const rec = lib.recurring(txs);
if (rec.length) { console.log("\nRecurring"); for (const r of rec) console.log(`  ${r.merchant.padEnd(18)} ${money(r.amount).padStart(12)}  ${r.cadence.padEnd(8)} ×${r.count}  next ~${r.nextExpected}  ≈${money(r.annualised)}/yr`); }
console.log("");
