import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStatement, mergeStatements, parseAmount, parseDate, cleanMerchant, categoriseAll, DEFAULT_RULES, mergeRules, monthly, byCategory, recurring, summary, toCleanCsv, CLEAN_HEADER } from "../src/lib";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const parse = (name: string, opts = {}) => parseStatement(fx(name), { fileName: name, ...opts });

describe("primitives", () => {
  it("parses amounts in every notation", () => {
    expect(parseAmount("1.234,56")).toEqual({ value: 1234.56, negative: false });
    expect(parseAmount("1,234.56")).toEqual({ value: 1234.56, negative: false });
    expect(parseAmount("(45.00)")).toEqual({ value: 45, negative: true });
    expect(parseAmount("-$84.12")).toEqual({ value: 84.12, negative: true });
    expect(parseAmount("45.00 DR")).toEqual({ value: 45, negative: true });
    expect(parseAmount("45,00 CR")).toEqual({ value: 45, negative: false });
    expect(parseAmount("12.50-")).toEqual({ value: 12.5, negative: true });
    expect(parseAmount("")).toBeNull();
  });
  it("parses dates in every notation", () => {
    expect(parseDate("2026-08-03 04:11:02")).toBe("2026-08-03");
    expect(parseDate("03/08/2026", true)).toBe("2026-08-03");
    expect(parseDate("03/08/2026", false)).toBe("2026-03-08");
    expect(parseDate("15/08/2026", false)).toBe("2026-08-15");
    expect(parseDate("4 Mar 2026")).toBe("2026-03-04");
    expect(parseDate("Mar 4, 2026")).toBe("2026-03-04");
    expect(parseDate("01.08.26")).toBe("2026-08-01");
    expect(parseDate("31/02/2026")).toBeNull();
  });
  it("cleans merchants", () => {
    expect(cleanMerchant("POS DUNNES STORES 6781 12AUG26")).toBe("Dunnes Stores");
    expect(cleanMerchant("VDP-SUPERVALU")).toBe("Supervalu");
    expect(cleanMerchant("Card payment to CAFFE NERO")).toBe("Caffe Nero");
    expect(cleanMerchant("DD VODAFONE IRELAND")).toBe("Vodafone Ireland");
  });
});

describe("bank dialects", () => {
  it("Revolut: ISO dates, negative amounts, fee folded, pending held, top-up flagged", () => {
    const r = parse("revolut.csv");
    expect(r.meta?.rowsParsed).toBe(6);
    expect(r.meta?.rowsHeld).toBe(1);
    expect(r.meta?.currency).toBe("EUR");
    const ryanair = r.transactions.find((t) => t.merchant === "Ryanair")!;
    expect(ryanair.amount).toBe(90.99);
    expect(ryanair.direction).toBe("out");
    const topup = r.transactions.find((t) => /Top-up/i.test(t.merchant))!;
    expect(topup.isTransfer).toBe(true);
    expect(topup.direction).toBe("in");
    expect(r.transactions.find((t) => t.merchant === "Caffe Nero")!.time).toBe("12:40");
  });
  it("AIB: debit/credit columns, dd/mm/yy, description columns joined", () => {
    const r = parse("aib.csv");
    expect(r.meta?.rowsParsed).toBe(5);
    expect(r.meta?.dayFirst).toBe(true);
    expect(r.transactions[0].date).toBe("2026-08-01");
    expect(r.transactions[0].merchant).toBe("Supervalu");
    expect(r.transactions[0].description).toContain("ENNIS");
    expect(r.transactions.find((t) => /Salary/i.test(t.merchant))!.direction).toBe("in");
  });
  it("BOI: dd/mm/yyyy, Debit/Credit, date fragments stripped from merchants", () => {
    const r = parse("boi.csv");
    expect(r.meta?.rowsParsed).toBe(5);
    expect(r.transactions.map((t) => t.merchant)).toContain("Dunnes Stores");
    expect(r.transactions.find((t) => t.direction === "in")!.amount).toBe(140);
  });
  it("N26: quoted header, Amount (EUR) column, ISO dates", () => {
    const r = parse("n26.csv");
    expect(r.meta?.rowsParsed).toBe(5);
    expect(r.transactions.find((t) => t.merchant === "Spotify")!.amount).toBe(10.99);
    expect(r.transactions.find((t) => /Employer/.test(t.merchant))!.direction).toBe("in");
  });
  it("Monzo: Money Out / Money In columns, GBP", () => {
    const r = parse("monzo.csv");
    expect(r.meta?.rowsParsed).toBe(5);
    expect(r.meta?.currency).toBe("GBP");
    expect(r.transactions.find((t) => /Acme/.test(t.merchant))!.direction).toBe("in");
    expect(r.transactions.find((t) => /Puregym/i.test(t.merchant))!.amount).toBe(24.99);
  });
  it("Wise: dd-mm-yyyy, savings transfer flagged", () => {
    const r = parse("wise.csv");
    expect(r.meta?.rowsParsed).toBe(4);
    expect(r.transactions.find((t) => /Savings/i.test(t.description))!.isTransfer).toBe(true);
  });
  it("US bank: month-first inferred from the data, $ and thousands separators", () => {
    const r = parse("us_bank.csv");
    expect(r.meta?.dayFirst).toBe(false);
    expect(r.meta?.ambiguousDates).toBe(false);
    expect(r.transactions[0].date).toBe("2026-01-15");
    expect(r.meta?.currency).toBe("USD");
    expect(r.transactions.find((t) => /Payroll/i.test(t.merchant))!.amount).toBe(3450);
    expect(r.transactions.find((t) => /Zelle/i.test(t.merchant))!.isTransfer).toBe(true);
  });
  it("German bank: semicolons, 1.250,00 amounts, dd.mm.yyyy", () => {
    const r = parse("de_bank.csv");
    expect(r.meta?.delimiter).toBe(";");
    expect(r.meta?.rowsParsed).toBe(4);
    expect(r.transactions.find((t) => /Miete/.test(t.description))!.amount).toBe(1250);
    expect(r.transactions.find((t) => /Gehalt/.test(t.description))!.direction).toBe("in");
  });
  it("No header: columns guessed, ambiguity flagged", () => {
    const r = parse("noheader.csv");
    expect(r.meta?.guessedColumns).toBe(true);
    expect(r.meta?.rowsParsed).toBe(4);
    expect(r.meta?.dayFirst).toBe(true);
    expect(r.meta?.ambiguousDates).toBe(false); // 14/03 and 28/03 settle it
  });
  it("Garbage in: empty result with a warning, no throw", () => {
    const r = parseStatement("hello\nworld\n");
    expect(r.transactions).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("merge", () => {
  it("drops rows repeated across files, keeps repeats inside one file", () => {
    const m = mergeStatements([parse("overlap_a.csv"), parse("overlap_b.csv")]);
    expect(m.duplicatesRemoved).toBe(1);
    expect(m.transactions.filter((t) => t.merchant === "Caffe Nero").length).toBe(2);
    expect(m.transactions.length).toBe(5);
  });
});

describe("categorise + analyse", () => {
  it("assigns categories from rules; user rules win", () => {
    const txs = categoriseAll(parse("boi.csv").transactions);
    const cat = (m: RegExp) => txs.find((t) => m.test(t.merchant))!.category;
    expect(cat(/Dunnes/)).toBe("Groceries");
    expect(cat(/Vodafone/)).toBe("Phone & internet");
    expect(cat(/Rent/)).toBe("Housing");
    expect(cat(/Child Benefit/i)).toBe("Income");
    const rules = mergeRules([{ keyword: "dunnes", category: "Shopping", source: "user" }], DEFAULT_RULES);
    expect(categoriseAll(parse("boi.csv").transactions, rules)[0].category).toBe("Shopping");
  });
  it("monthly totals exclude transfers", () => {
    const txs = categoriseAll(parse("revolut.csv").transactions);
    const m = monthly(txs);
    expect(m.length).toBe(1);
    expect(m[0].in).toBe(2500);
    expect(m[0].out).toBe(23.45 + 3.8 + 17.99 + 90.99);
  });
  it("category shares add up", () => {
    const rows = byCategory(categoriseAll(parse("aib.csv").transactions));
    expect(Math.round(rows.reduce((a, r) => a + r.share, 0))).toBe(100);
  });
  it("finds recurring payments and ignores irregular ones", () => {
    const rec = recurring(categoriseAll(parse("recurring.csv").transactions));
    const names = rec.map((r) => r.merchant);
    expect(names).toContain("Netflix.com");
    expect(names).toContain("Spotify");
    expect(names).toContain("Tesco");
    expect(names).not.toContain("Random Shop");
    expect(rec.find((r) => r.merchant === "Netflix.com")!.cadence).toBe("monthly");
    expect(rec.find((r) => r.merchant === "Tesco")!.cadence).toBe("weekly");
    expect(rec.find((r) => r.merchant === "Netflix.com")!.annualised).toBe(215.88);
  });
  it("summary and export", () => {
    const txs = categoriseAll(parse("monzo.csv").transactions);
    const s = summary(txs);
    expect(s.totalIn).toBe(2100);
    expect(s.currency).toBe("GBP");
    const csv = toCleanCsv(txs);
    expect(csv.split("\n")[0]).toBe(CLEAN_HEADER.join(","));
    expect(csv.split("\n").length).toBe(txs.length + 2);
  });
});
