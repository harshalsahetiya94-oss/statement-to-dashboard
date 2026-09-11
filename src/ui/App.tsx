import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell } from "recharts";
import {
  parseStatement, mergeStatements, categoriseAll, categoriseOne, mergeRules, DEFAULT_RULES, CATEGORIES,
  monthly, byCategory, topMerchants, recurring, summary, toCleanCsv, toJson,
  type Transaction, type ParseResult, type Rule,
} from "../lib";
import "./styles.css";

const RULES_KEY = "std.rules.v1";
const PALETTE = ["#1f5eff", "#0f8a5f", "#d9480f", "#7c3aed", "#0891b2", "#b45309", "#be185d", "#4d7c0f", "#475569", "#9333ea", "#0369a1", "#c2410c"];

function loadRules(): Rule[] {
  try { const raw = localStorage.getItem(RULES_KEY); return raw ? (JSON.parse(raw) as Rule[]) : []; } catch { return []; }
}
function saveRules(rules: Rule[]) { try { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); } catch { /* private mode */ } }

function money(n: number, cur: string | null) { return `${cur ? cur + " " : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function download(name: string, text: string, type: string) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

interface FileEntry { name: string; result: ParseResult }

export default function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [userRules, setUserRules] = useState<Rule[]>(() => loadRules());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [month, setMonth] = useState<string>("all");
  const [filter, setFilter] = useState("");
  const [onlyUncat, setOnlyUncat] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => saveRules(userRules), [userRules]);

  const rules = useMemo(() => mergeRules(userRules, DEFAULT_RULES), [userRules]);
  const merged = useMemo(() => mergeStatements(files.map((f) => f.result)), [files]);
  const txs = useMemo<Transaction[]>(() => categoriseAll(merged.transactions, rules, false).map((t) => (overrides[t.id] ? { ...t, category: overrides[t.id] } : t)), [merged, rules, overrides]);
  const currency = useMemo(() => files.map((f) => f.result.meta?.currency).find(Boolean) || null, [files]);
  const months = useMemo(() => monthly(txs), [txs]);
  const scoped = useMemo(() => (month === "all" ? txs : txs.filter((t) => t.date.startsWith(month))), [txs, month]);
  const sum = useMemo(() => summary(scoped, currency), [scoped, currency]);
  const cats = useMemo(() => byCategory(scoped), [scoped]);
  const merchants = useMemo(() => topMerchants(scoped, 8), [scoped]);
  const recur = useMemo(() => recurring(txs), [txs]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return scoped.filter((t) => (!onlyUncat || (!t.category && t.direction === "out" && !t.isTransfer)) && (!q || `${t.merchant} ${t.description} ${t.category}`.toLowerCase().includes(q)));
  }, [scoped, filter, onlyUncat]);

  async function addFiles(list: FileList | File[]) {
    const entries: FileEntry[] = [];
    for (const f of Array.from(list)) {
      const text = await f.text();
      entries.push({ name: f.name, result: parseStatement(text, { fileName: f.name }) });
    }
    setFiles((prev) => [...prev, ...entries]);
  }
  async function loadSample() {
    const r = await fetch("sample.csv"); const text = await r.text();
    setFiles([{ name: "sample.csv", result: parseStatement(text, { fileName: "sample.csv" }) }]);
  }
  function setCategory(t: Transaction, category: string, remember: boolean) {
    setOverrides((o) => ({ ...o, [t.id]: category }));
    if (remember && t.merchant) {
      const keyword = t.merchant.toLowerCase();
      setUserRules((rs) => [{ keyword, category, source: "user" }, ...rs.filter((r) => r.keyword !== keyword)]);
      setOverrides((o) => { const n = { ...o }; for (const x of txs) if (x.merchant.toLowerCase() === keyword) delete n[x.id]; return n; });
    }
  }

  const empty = files.length === 0;

  return (
    <div className="wrap">
      <header>
        <div>
          <h1>Statement to Dashboard</h1>
          <p className="sub">Drop your bank's CSV export. Get clean, categorised transactions and a spending picture.</p>
        </div>
        <div className="privacy">Runs entirely in your browser. Nothing is uploaded, ever. Open the Network tab if you'd like to check.</div>
      </header>

      <div className={`drop${over ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}>
        <input ref={inputRef} type="file" accept=".csv,text/csv,text/plain" multiple onChange={(e) => e.target.files && addFiles(e.target.files)} />
        <div className="big">{empty ? "Drop CSV files here, or click to choose" : "Add more files (overlapping rows are de-duplicated)"}</div>
        <div className="small">Revolut, AIB, Bank of Ireland, N26, Monzo, Wise, most US and EU exports. Several files at once is fine.</div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={(e) => { e.stopPropagation(); loadSample(); }}>Try it with sample data</button>
        {!empty && <button className="btn" onClick={() => { setFiles([]); setOverrides({}); setMonth("all"); }}>Clear</button>}
        {!empty && <button className="btn" onClick={() => download("transactions-clean.csv", toCleanCsv(txs), "text/csv")}>Export clean CSV</button>}
        {!empty && <button className="btn" onClick={() => download("transactions.json", toJson(txs), "application/json")}>Export JSON</button>}
        {userRules.length > 0 && <span className="muted" style={{ fontSize: 13 }}>{userRules.length} saved rule{userRules.length === 1 ? "" : "s"} <button className="btn link" onClick={() => { if (confirm("Forget all saved category rules?")) setUserRules([]); }}>forget</button></span>}
      </div>

      {!empty && (
        <>
          <div className="panel" style={{ marginTop: 14 }}>
            <h2>What was read</h2>
            <ul className="meta">
              {files.map((f, i) => {
                const m = f.result.meta;
                return (
                  <li key={i}><strong>{f.name}</strong>: {m ? <>{m.rowsParsed} transactions, {m.dateRange?.from} to {m.dateRange?.to}, delimiter “{m.delimiter}”, dates read {m.dayFirst ? "day-first" : "month-first"}{m.guessedColumns ? ", columns guessed (no header)" : ""}{m.rowsHeld ? `, ${m.rowsHeld} pending held` : ""}{m.rowsSkipped ? `, ${m.rowsSkipped} skipped` : ""}.</> : "nothing readable."}
                    {f.result.warnings.filter((w) => /could be day-first|guessed|Could not|empty|no readable/i.test(w)).map((w, k) => <div key={k} className="warn">⚠ {w}</div>)}
                  </li>
                );
              })}
              {merged.duplicatesRemoved > 0 && <li>{merged.duplicatesRemoved} duplicate row{merged.duplicatesRemoved === 1 ? "" : "s"} removed across files.</li>}
            </ul>
          </div>

          <div className="toolbar">
            <label>Period <select value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">All ({months.length} month{months.length === 1 ? "" : "s"})</option>
              {months.map((m) => <option key={m.month} value={m.month}>{m.month}</option>)}
            </select></label>
          </div>

          <div className="cards">
            <div className="card"><div className="k">Money out</div><div className="v out">{money(sum.totalOut, sum.currency)}</div></div>
            <div className="card"><div className="k">Money in</div><div className="v in">{money(sum.totalIn, sum.currency)}</div></div>
            <div className="card"><div className="k">Net</div><div className={`v ${sum.net < 0 ? "out" : "in"}`}>{money(sum.net, sum.currency)}</div></div>
            <div className="card"><div className="k">Transactions</div><div className="v">{sum.count}</div></div>
            <div className="card"><div className="k">Transfers (excluded)</div><div className="v">{sum.transfers}</div></div>
            <div className="card"><div className="k">Uncategorised</div><div className="v">{sum.uncategorised}</div></div>
          </div>

          <div className="grid2">
            <div className="panel">
              <h2>By month</h2>
              {months.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={months} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <XAxis dataKey="month" fontSize={12} /><YAxis fontSize={12} width={60} />
                    <Tooltip formatter={(v: number) => money(v, sum.currency)} /><Legend />
                    <Bar dataKey="out" name="Out" fill="#d9480f" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="in" name="In" fill="#0f8a5f" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <div className="empty">No months.</div>}
            </div>
            <div className="panel">
              <h2>Where it went {month !== "all" && <span className="tag">{month}</span>}</h2>
              {cats.length ? (
                <ResponsiveContainer width="100%" height={Math.max(220, cats.length * 26)}>
                  <BarChart data={cats} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
                    <XAxis type="number" fontSize={12} /><YAxis type="category" dataKey="category" width={120} fontSize={12} />
                    <Tooltip formatter={(v: number, _n, p) => [`${money(v, sum.currency)} (${p.payload.share}%)`, "Spend"]} />
                    <Bar dataKey="total" radius={[0, 3, 3, 0]}>{cats.map((_c, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <div className="empty">No spending in this period.</div>}
            </div>
          </div>

          <div className="grid2">
            <div className="panel">
              <h2>Recurring payments <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>same merchant, steady amount, steady rhythm</span></h2>
              {recur.length ? (
                <table><thead><tr><th>Merchant</th><th>Every</th><th className="num">Amount</th><th className="num">Per year</th><th>Next</th></tr></thead>
                  <tbody>{recur.map((r) => <tr key={r.merchant}><td>{r.merchant}{r.category && <span className="tag">{r.category}</span>}</td><td>{r.cadence === "weekly" ? "week" : r.cadence === "monthly" ? "month" : "year"} ×{r.count}</td><td className="num">{money(r.amount, sum.currency)}</td><td className="num">{money(r.annualised, sum.currency)}</td><td>{r.nextExpected}</td></tr>)}</tbody></table>
              ) : <div className="empty">Nothing recurring found yet. Three or more months of statements make this useful.</div>}
            </div>
            <div className="panel">
              <h2>Top merchants {month !== "all" && <span className="tag">{month}</span>}</h2>
              {merchants.length ? (
                <table><thead><tr><th>Merchant</th><th>Category</th><th className="num">Visits</th><th className="num">Total</th></tr></thead>
                  <tbody>{merchants.map((m) => <tr key={m.merchant}><td>{m.merchant}</td><td>{m.category || <span className="muted">—</span>}</td><td className="num">{m.count}</td><td className="num">{money(m.total, sum.currency)}</td></tr>)}</tbody></table>
              ) : <div className="empty">No spending in this period.</div>}
            </div>
          </div>

          <div className="panel">
            <h2>Transactions <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>change a category and tick “remember” to teach it the merchant</span></h2>
            <div className="toolbar">
              <input type="text" placeholder="Search merchant, description, category" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ minWidth: 260 }} />
              <label style={{ fontSize: 13 }}><input type="checkbox" checked={onlyUncat} onChange={(e) => setOnlyUncat(e.target.checked)} /> uncategorised only</label>
              <span className="muted" style={{ fontSize: 13 }}>{visible.length} of {scoped.length}</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th className="num">Amount</th><th>From</th></tr></thead>
                <tbody>
                  {visible.slice(0, 400).map((t) => <Row key={t.id} t={t} cur={sum.currency} rules={rules} onSet={setCategory} />)}
                </tbody>
              </table>
              {visible.length > 400 && <div className="empty">Showing the first 400. Narrow the search or pick a month.</div>}
            </div>
          </div>
        </>
      )}
      <footer>Open source, MIT. Built by Harshal Sahetiya. Categories come from keyword rules and your own corrections, which stay in this browser only.</footer>
    </div>
  );
}

function Row({ t, cur, rules, onSet }: { t: Transaction; cur: string | null; rules: Rule[]; onSet: (t: Transaction, c: string, remember: boolean) => void }) {
  const [remember, setRemember] = useState(true);
  const hit = useMemo(() => categoriseOne(t, rules).rule, [t, rules]);
  return (
    <tr>
      <td>{t.date}{t.time && <span className="muted"> {t.time}</span>}</td>
      <td title={t.description}>{t.merchant}{t.isTransfer && <span className="tag tr">transfer</span>}{t.fee > 0 && <span className="tag">fee {t.fee.toFixed(2)}</span>}</td>
      <td>
        <select value={t.category} onChange={(e) => onSet(t, e.target.value, remember)}>
          <option value="">— uncategorised —</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label title="Save a rule for this merchant" style={{ marginLeft: 6, fontSize: 11 }} className="muted"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> remember</label>
        {hit?.source === "user" && <span className="tag" title={`your rule: “${hit.keyword}”`}>yours</span>}
      </td>
      <td className={`num ${t.direction}`}>{t.direction === "out" ? "−" : "+"}{money(t.amount, cur)}</td>
      <td className="muted" style={{ fontSize: 12 }}>{t.source}</td>
    </tr>
  );
}
