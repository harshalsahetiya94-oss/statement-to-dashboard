/**
 * parse.ts — bank-statement CSV reader.
 *
 * Text in, transactions out. No DOM, no network, no dependencies.
 *
 * What it handles:
 *  - delimiter sniffing (, ; tab |) by column-count consistency
 *  - quoted-cell CSV tokenising (RFC 4180 quotes, doubled quotes inside)
 *  - header alias mapping across bank-export dialects (date / debit / credit /
 *    amount / type / fee / state / currency / balance / description columns),
 *    with a positional guess over the first 60 rows when there is no header
 *  - day-first vs month-first date inference, with an explicit ambiguity flag
 *  - amount normalisation: 1.234,56 vs 1,234.56, (123.45), DR/CR markers, trailing minus
 *  - merchant cleaning: POS/VDP prefixes, card fragments, references, ALL CAPS → Title Case
 *  - own-money detection: top-ups and internal transfers are flagged, not counted as spend
 *  - pending rows (state != completed) are held, not counted
 *
 * Lineage: a phone-side CSV reader written for a household app in 2026,
 * rewritten here as a standalone library with absolute dates, multi-file
 * merge and de-duplication.
 */

export type Direction = "out" | "in";

export interface Transaction {
  /** Stable id: sha-ish hash of date|direction|amount|merchant|index. */
  id: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Cleaned merchant / counterparty name. */
  merchant: string;
  /** The raw description cell(s), joined. */
  description: string;
  /** Always positive; see `direction`. */
  amount: number;
  direction: Direction;
  currency: string | null;
  /** Fee folded into the amount (added on the way out, deducted on the way in). */
  fee: number;
  /** Looks like the account holder's own money moving (top-up, internal transfer). */
  isTransfer: boolean;
  /** "14:05" if the date cell carried a time. */
  time: string | null;
  /** Assigned by the categoriser; empty until then. */
  category: string;
  /** File the row came from, when parsing several. */
  source: string;
  rawDate: string;
}

export interface ParseMeta {
  delimiter: string;
  headerRow: number | null;
  columns: Record<string, string>;
  guessedColumns: boolean;
  dayFirst: boolean;
  ambiguousDates: boolean;
  rowsTotal: number;
  rowsParsed: number;
  rowsSkipped: number;
  rowsHeld: number;
  currency: string | null;
  dateRange: { from: string; to: string } | null;
}

export interface ParseResult {
  transactions: Transaction[];
  meta: ParseMeta | null;
  warnings: string[];
}

export interface ParseOptions {
  /** Assume day-first (European) when a date like 03/04/2026 cannot be decided. Default true. */
  dayFirstDefault?: boolean;
  /** Label stored on every transaction's `source`. */
  fileName?: string;
}

type ColKey = "date" | "desc" | "amt" | "deb" | "cred" | "type" | "fee" | "state" | "cur" | "bal";
type ColMap = Partial<Record<ColKey, number>> & { descs?: number[] };

// ── tokenising ────────────────────────────────────────────────────────────────

export function csvCells(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const t = String(text || "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === "") { quoted = true; cell = ""; continue; }
    if (c === delimiter) { row.push(cell); cell = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
      continue;
    }
    cell += c;
  }
  row.push(cell); rows.push(row);
  return rows.map((r) => r.map((x) => String(x).trim())).filter((r) => r.some((x) => x !== ""));
}

export function sniffDelimiter(text: string): string {
  const head = String(text || "").slice(0, 6000);
  let best = ",", score = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const rows = csvCells(head, d).slice(0, 12);
    if (rows.length < 2) continue;
    const tally: Record<number, number> = {};
    for (const r of rows) tally[r.length] = (tally[r.length] || 0) + 1;
    let n = 1, hits = 0;
    for (const k of Object.keys(tally)) {
      const v = tally[+k];
      if (v > hits || (v === hits && +k > n)) { hits = v; n = +k; }
    }
    const sc = n >= 2 ? n * hits : 0;
    if (sc > score) { score = sc; best = d; }
  }
  return best;
}

// ── dates ─────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function year4(y: string): number {
  let n = parseInt(y, 10);
  if (!isFinite(n)) return NaN;
  if (n < 100) n += n > 70 ? 1900 : 2000;
  return n;
}

function iso(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 && y < 2200)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31 Feb etc.
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Parse one date cell to ISO. Handles 2026-03-04, 04/03/2026, 4 Mar 2026, Mar 4, 2026, 04.03.26. */
export function parseDate(value: unknown, dayFirst = true): string | null {
  const s = String(value == null ? "" : value).trim();
  if (s.length < 6) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\s\-/.]+([a-z]{3,9})[\s\-/.,]+(\d{2,4})/i))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return iso(year4(m[3]), mo, +m[1]);
  }
  if ((m = s.match(/^([a-z]{3,9})[\s\-/.]+(\d{1,2})[\s\-/.,]+(\d{2,4})/i))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return iso(year4(m[3]), mo, +m[2]);
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    const a = +m[1], b = +m[2];
    let d: number, mo: number;
    if (a > 12) { d = a; mo = b; }
    else if (b > 12) { d = b; mo = a; }
    else if (dayFirst) { d = a; mo = b; }
    else { d = b; mo = a; }
    return iso(year4(m[3]), mo, d);
  }
  return null;
}

// ── amounts ───────────────────────────────────────────────────────────────────

/** "1.234,56" → 1234.56; "(45.00)" → -45; "45.00 DR" → -45; "45,00 CR" → 45. */
export function parseAmount(value: unknown): { value: number; negative: boolean } | null {
  let s = String(value == null ? "" : value).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /\b(dr|db)\b/i.test(s);
  const positive = /\b(cr)\b/i.test(s);
  s = s.replace(/[^0-9.,]/g, "");
  if (!/\d/.test(s)) return null;
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc >= 0 && ld >= 0) s = lc > ld ? s.replace(/\./g, "").replace(/,/g, ".") : s.replace(/,/g, "");
  else if (lc >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(/,/g, ".");
  else if (ld >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return { value: Math.abs(n), negative: negative && !positive };
}

export function parseCurrency(value: unknown): string | null {
  const s = String(value || "");
  const m = s.match(/\b(EUR|GBP|USD|INR|CHF|AUD|CAD|JPY|SEK|NOK|DKK|PLN|CZK|HUF|AED|SAR|SGD|NZD|ZAR|TRY|THB|MXN|BRL)\b/i);
  if (m) return m[1].toUpperCase();
  if (s.includes("€")) return "EUR";
  if (s.includes("£")) return "GBP";
  if (s.includes("₹")) return "INR";
  if (s.includes("¥")) return "JPY";
  if (s.includes("$")) return "USD";
  return null;
}

// ── merchant cleaning ─────────────────────────────────────────────────────────

function titleCase(m: string): string {
  return String(m).toLowerCase().replace(/(^|[\s\-/&'(])([a-z])/g, (_x, a, b) => a + b.toUpperCase());
}

/** "POS TESCO STORES 4321 12MAR26" → "Tesco Stores". */
export function cleanMerchant(raw: unknown): string {
  let v = String(raw || "").replace(/\s+/g, " ").trim();
  v = v.replace(/^(pos|vdp|vdc|dd|d\/d|sto|atm|chq|crd|tfr|ref|card payment to|card payment|card purchase|debit card|contactless|visa|mastercard|purchase|payment to|direct debit|to|from)\b[\s\-:*.]*/i, "");
  v = v.replace(/\b\d{2}[a-z]{3}\d{2,4}\b/gi, " ").replace(/[x*]{3,}\d{2,}/gi, " ").replace(/\b\d{3,}\b/g, " ").replace(/#\S+/g, " ");
  v = v.replace(/\s{2,}/g, " ").replace(/^[\s\-,*|:;.]+|[\s\-,*|:;.]+$/g, "").trim();
  if (v && !/[a-zà-öø-þ]/.test(v)) v = titleCase(v); // ALL CAPS statement line → Title Case
  else v = v
    .replace(/\b[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'&.]{1,}(?:\s+[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'&.]*)+\b/g, (m) => titleCase(m))
    .replace(/\b[A-ZÀ-ÖØ-Þ]{6,}\b/g, (m) => titleCase(m));
  return v || "Unknown";
}

// ── header detection ──────────────────────────────────────────────────────────

const HEAD = {
  date: /^(date|txn.?date|trans(action)?.?date|posting.?date|posted.?(on|date|transactions?.?date)|value.?date|book(ing)?.?date|started.?date|completed.?date|date.?completed|entry.?date|settled.?date|buchungstag|datum|fecha|data)$/i,
  dateLoose: /date|datum|fecha/i,
  bal: /(balance|running.?total|saldo)/i,
  cur: /^(currency|ccy|curr|iso.?code|währung|waehrung|posted.?currency|local.?currency)$/i,
  fee: /^(fee|fees|charge|charges|commission)$/i,
  state: /^(state|status)$/i,
  deb: /^(debit|debits|debit.?amount|withdrawal|withdrawals|withdrawal.?amount|paid.?out|money.?out|out|dr|amount.?out|spent|soll)$/i,
  cred: /^(credit|credits|credit.?amount|deposit|deposits|deposit.?amount|paid.?in|money.?in|in|cr|amount.?in|received|haben)$/i,
  amt: /^(amount|amt|value|transaction.?amount|local.?amount|sum|net.?amount|betrag|importe|importo|amount.?\(?[a-z]{3}\)?)$/i,
  type: /^(type|dr\/cr|debit\/credit|indicator|transaction.?type)$/i,
};
const DESC_WORDS = ["description", "details", "narrative", "particulars", "payee", "merchant", "counterparty", "to/from", "name", "memo", "verwendungszweck", "concepto", "payment reference", "reference", "transaction", "notes"];
const NOT_DESC = /\bid\b|identifier|number|address|emoji|receipt|iban|bic|sort code|card holder|last four/i;

function descRank(h: string): number {
  const s = h.toLowerCase();
  if (NOT_DESC.test(s)) return 0;
  for (let k = 0; k < DESC_WORDS.length; k++) if (s.includes(DESC_WORDS[k])) return DESC_WORDS.length - k;
  return 0;
}

export function detectHeader(grid: string[][]): { row: number; map: ColMap; names: Record<string, string> } | null {
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const r = grid[i];
    if (r.length < 2) continue;
    const map: ColMap = { descs: [] }, names: Record<string, string> = {};
    const descCands: { j: number; rank: number; h: string }[] = [];
    let dateScore = 0;
    const put = (k: ColKey, j: number, h: string) => { if (map[k] == null) { map[k] = j; names[k] = h; } };
    r.forEach((cell, j) => {
      const h = String(cell || "").replace(/\s+/g, " ").trim();
      if (!h) return;
      if (HEAD.date.test(h)) {
        const sc = /^(completed|posted|settled|value|book)/i.test(h) ? 1 : 2;
        if (map.date == null || sc > dateScore) { map.date = j; names.date = h; dateScore = sc; }
        return;
      }
      if (HEAD.bal.test(h)) { put("bal", j, h); return; }
      if (HEAD.fee.test(h)) { put("fee", j, h); return; }
      if (HEAD.state.test(h)) { put("state", j, h); return; }
      if (HEAD.cur.test(h)) { put("cur", j, h); return; }
      if (HEAD.deb.test(h)) { put("deb", j, h); return; }
      if (HEAD.cred.test(h)) { put("cred", j, h); return; }
      if (HEAD.amt.test(h)) { put("amt", j, h); return; }
      if (HEAD.type.test(h)) { put("type", j, h); return; }
      const rk = descRank(h);
      if (rk > 0) descCands.push({ j, rank: rk, h });
    });
    descCands.sort((a, b) => b.rank - a.rank);
    map.descs = descCands.map((c) => c.j);
    if (descCands.length) { map.desc = descCands[0].j; names.desc = descCands[0].h; }
    if (map.date == null) {
      // loose fallback: any header containing "date" that is not the balance column
      r.forEach((cell, j) => { if (map.date == null && HEAD.dateLoose.test(cell) && map.bal !== j) { map.date = j; names.date = cell; } });
    }
    if (map.date != null && (map.amt != null || map.deb != null || map.cred != null)) return { row: i, map, names };
  }
  return null;
}

export function guessColumns(grid: string[][]): { map: ColMap } | null {
  const n = grid.reduce((a, r) => Math.max(a, r.length), 0);
  if (n < 2) return null;
  const rows = grid.slice(0, 60);
  const dh: number[] = [], nh: number[] = [], tx: number[] = [];
  for (let j = 0; j < n; j++) {
    let a = 0, b = 0, c = 0;
    for (const r of rows) {
      const v = String(r[j] || "");
      if (!v) continue;
      if (parseDate(v, true)) a++;
      else if (parseAmount(v)) b++;
      if (/[a-z]{3,}/i.test(v) && !/^\d/.test(v)) c += v.length;
    }
    dh[j] = a; nh[j] = b; tx[j] = c;
  }
  let dcol = -1;
  for (let j = 0; j < n; j++) if (dh[j] > (dcol < 0 ? 0 : dh[dcol])) dcol = j;
  if (dcol < 0 || dh[dcol] < Math.max(2, rows.length * 0.5)) return null;
  const cands: number[] = [];
  for (let j = 0; j < n; j++) if (j !== dcol && nh[j] >= Math.max(2, rows.length * 0.5)) cands.push(j);
  if (!cands.length) return null;
  const map: ColMap = { date: dcol, descs: [] };
  if (cands.length >= 2) {
    const a = cands[0], b = cands[1];
    const excl = rows.filter((r) => !!parseAmount(r[a]) !== !!parseAmount(r[b])).length;
    if (excl >= rows.length * 0.7) { map.deb = a; map.cred = b; }
  }
  if (map.deb == null) map.amt = cands[0];
  let tcol = -1;
  for (let j = 0; j < n; j++) {
    if (j === dcol || j === map.amt || j === map.deb || j === map.cred) continue;
    if (tx[j] > (tcol < 0 ? 0 : tx[tcol])) tcol = j;
  }
  if (tcol >= 0) { map.desc = tcol; map.descs = [tcol]; }
  return { map };
}

// ── rows ──────────────────────────────────────────────────────────────────────

function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function readRow(r: string[], map: ColMap, dayFirst: boolean, source: string, index: number): Transaction | "held" | null {
  const cell = (k: ColKey): string => (map[k] != null ? String(r[map[k]!] || "") : "");
  const st = cell("state");
  if (st && !/^(completed|complete|posted|settled|ok|booked|cleared|success|done)/i.test(st)) return "held";
  const date = parseDate(cell("date"), dayFirst);
  if (!date) return null;
  let amount: number | null = null, direction: Direction | null = null;
  const deb = map.deb != null ? parseAmount(cell("deb")) : null;
  const cred = map.cred != null ? parseAmount(cell("cred")) : null;
  if (deb && deb.value) { amount = deb.value; direction = "out"; }
  else if (cred && cred.value) { amount = cred.value; direction = "in"; }
  if (amount == null && map.amt != null) {
    const a = parseAmount(cell("amt"));
    if (a && a.value) {
      amount = a.value;
      direction = a.negative ? "out" : "in";
      const ty = cell("type");
      if (/^(dr|debit|card payment|payment|purchase|withdrawal|direct debit|standing order)\b/i.test(ty) && !a.negative && !/\+/.test(cell("amt"))) direction = "out";
      if (/^(cr|credit|deposit|refund|top.?up|salary|interest)\b/i.test(ty)) direction = "in";
    }
  }
  if (amount == null || !isFinite(amount) || amount < 0.005 || direction == null) return null;
  const feeParsed = map.fee != null ? parseAmount(cell("fee")) : null;
  const fee = feeParsed && feeParsed.value ? feeParsed.value : 0;
  if (fee) amount = direction === "out" ? amount + fee : Math.max(0, amount - fee);
  const descCells = (map.descs && map.descs.length ? map.descs : map.desc != null ? [map.desc] : []).map((j) => String(r[j] || "").trim()).filter(Boolean);
  const description = descCells.length ? descCells.join(" · ") : cell("type");
  const merchant = cleanMerchant(descCells[0] || cell("type"));
  if (/^(opening|closing|brought forward|carried forward|balance|total|subtotal|statement)\b/i.test(merchant)) return null;
  const currency = parseCurrency(cell("cur")) || parseCurrency(cell("amt")) || parseCurrency(cell("deb")) || parseCurrency(cell("cred"));
  const tm = String(cell("date")).match(/(\d{1,2}):(\d{2})/);
  const time = tm && +tm[1] < 24 ? `${tm[1].padStart(2, "0")}:${tm[2]}` : null;
  const blob = (description + " " + cell("type")).toLowerCase();
  const isTransfer = /top.?up|transfer (from|to)|own account|from savings|to savings|internal transfer|between accounts|\bself\b|revolut|n26|wise|monzo|paypal transfer/i.test(blob) && !/refund/i.test(blob);
  const amt = Math.round(amount * 100) / 100;
  return {
    id: hashId(`${date}|${direction}|${amt}|${merchant.toLowerCase()}|${index}`),
    date, merchant, description, amount: amt, direction, currency, fee, isTransfer, time,
    category: "", source, rawDate: cell("date"),
  };
}

// ── the whole read ────────────────────────────────────────────────────────────

export function parseStatement(text: string, opts: ParseOptions = {}): ParseResult {
  const source = opts.fileName || "";
  const warnings: string[] = [];
  const s = String(text || "").replace(/^﻿/, "");
  const none: ParseResult = { transactions: [], meta: null, warnings };
  if (!s.trim()) { warnings.push("The file is empty."); return none; }
  const delimiter = sniffDelimiter(s);
  const grid = csvCells(s, delimiter);
  if (!grid.length) { warnings.push("No rows found."); return none; }
  const head = detectHeader(grid);
  let map: ColMap, body: string[][], headerRow: number | null = null, names: Record<string, string> = {};
  if (head) { map = head.map; body = grid.slice(head.row + 1); headerRow = head.row; names = head.names; }
  else {
    const g = guessColumns(grid);
    if (!g) { warnings.push("Could not find date and amount columns. Is this a bank statement export?"); return none; }
    map = g.map; body = grid;
    warnings.push("No header row recognised; columns were guessed from the data.");
  }
  let dayFirst = opts.dayFirstDefault ?? true;
  let e1 = 0, e2 = 0, amb = 0;
  for (const r of body) {
    const m = String(r[map.date!] || "").match(/^(\d{1,2})[-/.](\d{1,2})[-/.]/);
    if (!m) continue;
    if (+m[1] > 12) e1++;
    else if (+m[2] > 12) e2++;
    else if (m[1] !== m[2]) amb++;
  }
  if (e1 > e2) dayFirst = true;
  else if (e2 > e1) dayFirst = false;
  const ambiguous = amb > 0 && !e1 && !e2;
  if (ambiguous) warnings.push(`Dates like ${body.find((r) => /^(\d{1,2})[-/.](\d{1,2})[-/.]/.test(String(r[map.date!] || "")))?.[map.date!]} could be day-first or month-first; assumed ${dayFirst ? "day-first" : "month-first"}.`);
  const transactions: Transaction[] = [];
  let skipped = 0, held = 0;
  body.forEach((r, i) => {
    if (!r.join("").trim()) return;
    const rec = readRow(r, map, dayFirst, source, i);
    if (rec === "held") { held++; return; }
    if (!rec) { skipped++; return; }
    transactions.push(rec);
  });
  if (!transactions.length) { warnings.push("Found the columns but no readable transaction rows."); return { transactions: [], meta: null, warnings }; }
  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const curTally: Record<string, number> = {};
  for (const t of transactions) if (t.currency) curTally[t.currency] = (curTally[t.currency] || 0) + 1;
  const currency = Object.keys(curTally).sort((a, b) => curTally[b] - curTally[a])[0] || null;
  if (skipped) warnings.push(`${skipped} row${skipped === 1 ? "" : "s"} skipped (no date or amount, or a balance line).`);
  if (held) warnings.push(`${held} pending row${held === 1 ? "" : "s"} held back (not completed).`);
  return {
    transactions,
    meta: {
      delimiter: delimiter === "\t" ? "tab" : delimiter,
      headerRow, columns: names, guessedColumns: !head, dayFirst, ambiguousDates: ambiguous,
      rowsTotal: body.length, rowsParsed: transactions.length, rowsSkipped: skipped, rowsHeld: held,
      currency,
      dateRange: { from: transactions[0].date, to: transactions[transactions.length - 1].date },
    },
    warnings,
  };
}

/**
 * Merge several parsed files. Rows that appear in more than one file with the
 * same date, direction, amount and merchant are kept once (overlapping exports).
 * Identical rows inside the same file are kept (two coffees on one day are real).
 */
export function mergeStatements(results: ParseResult[]): { transactions: Transaction[]; duplicatesRemoved: number } {
  const seen = new Map<string, string>();
  const out: Transaction[] = [];
  let dup = 0;
  for (const r of results) {
    const local = new Map<string, number>();
    for (const t of r.transactions) {
      const base = `${t.date}|${t.direction}|${t.amount}|${t.merchant.toLowerCase()}`;
      const n = (local.get(base) || 0) + 1; local.set(base, n);
      const key = `${base}|${n}`;
      const owner = seen.get(key);
      if (owner && owner !== t.source) { dup++; continue; }
      seen.set(key, t.source);
      out.push(t);
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { transactions: out, duplicatesRemoved: dup };
}
