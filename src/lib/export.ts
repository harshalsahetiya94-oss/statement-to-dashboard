/** export.ts — clean CSV and JSON out. */
import type { Transaction } from "./parse";

export const CLEAN_HEADER = ["date", "merchant", "category", "direction", "amount", "currency", "transfer", "description", "source"] as const;

export function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCleanCsv(txs: Transaction[]): string {
  const body = txs.map((t) => [
    t.date, t.merchant, t.category || "Uncategorised", t.direction, t.amount.toFixed(2), t.currency || "",
    t.isTransfer ? "yes" : "", t.description, t.source,
  ].map(csvCell).join(","));
  return [CLEAN_HEADER.join(","), ...body].join("\n") + "\n";
}

export function toJson(txs: Transaction[]): string {
  return JSON.stringify(txs, null, 2);
}
