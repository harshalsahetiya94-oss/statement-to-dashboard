/**
 * analyse.ts — the numbers behind the dashboard. Pure functions over transactions.
 */
import type { Transaction } from "./parse";

export interface MonthRow { month: string; out: number; in: number; net: number; count: number }
export interface CategoryRow { category: string; total: number; count: number; share: number }
export interface MerchantRow { merchant: string; total: number; count: number; category: string }
export interface RecurringRow { merchant: string; category: string; amount: number; cadence: "weekly" | "monthly" | "yearly"; count: number; lastDate: string; nextExpected: string; annualised: number }
export interface Summary { totalOut: number; totalIn: number; net: number; count: number; uncategorised: number; transfers: number; from: string | null; to: string | null; currency: string | null }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Spending rows only: money out, not transfers. */
export function spends(txs: Transaction[]): Transaction[] {
  return txs.filter((t) => t.direction === "out" && !t.isTransfer);
}

export function monthly(txs: Transaction[]): MonthRow[] {
  const m = new Map<string, MonthRow>();
  for (const t of txs) {
    if (t.isTransfer) continue;
    const k = t.date.slice(0, 7);
    const row = m.get(k) || { month: k, out: 0, in: 0, net: 0, count: 0 };
    if (t.direction === "out") row.out += t.amount; else row.in += t.amount;
    row.count++;
    m.set(k, row);
  }
  return [...m.values()].map((x) => ({ ...x, out: r2(x.out), in: r2(x.in), net: r2(x.in - x.out) })).sort((a, b) => (a.month < b.month ? -1 : 1));
}

export function byCategory(txs: Transaction[], month?: string): CategoryRow[] {
  const rows = spends(txs).filter((t) => !month || t.date.startsWith(month));
  const total = rows.reduce((a, t) => a + t.amount, 0);
  const m = new Map<string, CategoryRow>();
  for (const t of rows) {
    const k = t.category || "Uncategorised";
    const row = m.get(k) || { category: k, total: 0, count: 0, share: 0 };
    row.total += t.amount; row.count++;
    m.set(k, row);
  }
  return [...m.values()].map((x) => ({ ...x, total: r2(x.total), share: total ? r2((x.total / total) * 100) : 0 })).sort((a, b) => b.total - a.total);
}

export function topMerchants(txs: Transaction[], n = 10): MerchantRow[] {
  const m = new Map<string, MerchantRow>();
  for (const t of spends(txs)) {
    const k = t.merchant.toLowerCase();
    const row = m.get(k) || { merchant: t.merchant, total: 0, count: 0, category: t.category };
    row.total += t.amount; row.count++;
    m.set(k, row);
  }
  return [...m.values()].map((x) => ({ ...x, total: r2(x.total) })).sort((a, b) => b.total - a.total).slice(0, n);
}

export function largest(txs: Transaction[], n = 10): Transaction[] {
  return [...spends(txs)].sort((a, b) => b.amount - a.amount).slice(0, n);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
}
function addDays(d: string, n: number): string {
  const x = new Date(Date.parse(d) + n * 864e5);
  return x.toISOString().slice(0, 10);
}

/**
 * Recurring payments: the same merchant, amounts within 15% of each other,
 * three or more times, at a steady weekly / monthly / yearly interval.
 */
export function recurring(txs: Transaction[]): RecurringRow[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of spends(txs)) {
    const k = t.merchant.toLowerCase();
    (groups.get(k) || groups.set(k, []).get(k)!).push(t);
  }
  const out: RecurringRow[] = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    g.sort((a, b) => (a.date < b.date ? -1 : 1));
    const amounts = g.map((t) => t.amount);
    const median = [...amounts].sort((a, b) => a - b)[Math.floor(amounts.length / 2)];
    const steady = g.filter((t) => Math.abs(t.amount - median) <= Math.max(1, median * 0.15));
    if (steady.length < 3) continue;
    const gaps: number[] = [];
    for (let i = 1; i < steady.length; i++) gaps.push(daysBetween(steady[i - 1].date, steady[i].date));
    const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    let cadence: RecurringRow["cadence"] | null = null;
    if (med >= 6 && med <= 8) cadence = "weekly";
    else if (med >= 26 && med <= 35) cadence = "monthly";
    else if (med >= 355 && med <= 375) cadence = "yearly";
    if (!cadence) continue;
    const regular = gaps.filter((x) => Math.abs(x - med) <= (cadence === "weekly" ? 2 : cadence === "monthly" ? 6 : 20)).length;
    if (regular < gaps.length * 0.6) continue;
    const last = steady[steady.length - 1];
    const perYear = cadence === "weekly" ? 52 : cadence === "monthly" ? 12 : 1;
    out.push({
      merchant: last.merchant, category: last.category, amount: r2(median), cadence, count: steady.length,
      lastDate: last.date, nextExpected: addDays(last.date, med), annualised: r2(median * perYear),
    });
  }
  return out.sort((a, b) => b.annualised - a.annualised);
}

export function summary(txs: Transaction[], currency: string | null = null): Summary {
  let totalOut = 0, totalIn = 0, unc = 0, tr = 0;
  for (const t of txs) {
    if (t.isTransfer) { tr++; continue; }
    if (t.direction === "out") { totalOut += t.amount; if (!t.category) unc++; } else totalIn += t.amount;
  }
  const dates = txs.map((t) => t.date).sort();
  return {
    totalOut: r2(totalOut), totalIn: r2(totalIn), net: r2(totalIn - totalOut), count: txs.length,
    uncategorised: unc, transfers: tr, from: dates[0] || null, to: dates[dates.length - 1] || null,
    currency: currency || txs.find((t) => t.currency)?.currency || null,
  };
}
