/**
 * categorise.ts — keyword rules → category. No model, no network.
 *
 * Rules are matched as case-insensitive substrings against merchant and
 * description. User rules win over built-in rules; longer keywords win over
 * shorter ones. Money in is "Income" unless it looks like the account
 * holder's own money moving, which is "Transfers".
 */
import type { Transaction } from "./parse";

export interface Rule {
  keyword: string;
  category: string;
  source: "builtin" | "user";
}

export const CATEGORIES = [
  "Groceries", "Dining & coffee", "Transport", "Fuel", "Housing", "Utilities", "Phone & internet",
  "Subscriptions", "Shopping", "Health", "Fitness", "Entertainment", "Travel", "Education", "Kids",
  "Insurance", "Fees & charges", "Cash", "Charity", "Gifts", "Income", "Transfers", "Other",
] as const;

const B = (keyword: string, category: string): Rule => ({ keyword, category, source: "builtin" });

export const DEFAULT_RULES: Rule[] = [
  // groceries (IE / UK / EU / general)
  ...["tesco", "supervalu", "lidl", "aldi", "dunnes", "spar", "centra", "grocer", "sainsbury", "asda", "morrisons", "waitrose", "marks & spencer", "m&s", "co-op", "iceland", "eurospar", "carrefour", "rewe", "edeka", "mercadona", "whole foods", "trader joe", "costco", "walmart", "kroger", "safeway", "big bazaar", "dmart", "reliance fresh", "blinkit", "zepto", "instamart", "fresh market"].map((k) => B(k, "Groceries")),
  // dining
  ...["nero", "starbucks", "costa", "cafe", "café", "coffee", "deliveroo", "just eat", "uber eats", "doordash", "grubhub", "zomato", "swiggy", "restaurant", "trattoria", "pizza", "bakery", "burger", "mcdonald", "kfc", "subway", "nando", "wagamama", "pret", "greggs", "dominos", "domino's", "chipotle", "bistro", "kitchen", "diner", "sushi", "noodle", "takeaway", "bar ", "pub "].map((k) => B(k, "Dining & coffee")),
  // transport
  ...["leap", "irish rail", "dublin bus", "bus eireann", "bus éireann", "luas", "dart ", "uber", "bolt", "freenow", "free now", "taxi", "lyft", "tfl", "oyster", "trainline", "national rail", "ryanair", "aer lingus", "easyjet", "british airways", "lufthansa", "klm", "air france", "emirates", "etihad", "flight", "parking", "toll", "eflow", "ola", "rapido", "irctc", "metro"].map((k) => B(k, "Transport")),
  ...["circle k", "applegreen", "maxol", "top oil", "petrol", "fuel", "shell", "esso", "bp ", "texaco", "diesel", "chevron", "exxon", "hpcl", "bharat petroleum", "indian oil"].map((k) => B(k, "Fuel")),
  // housing & utilities
  ...["rent", "mortgage", "landlord", "letting", "property management", "management fee", "airbnb"].map((k) => B(k, "Housing")),
  ...["electric ireland", "energia", "bord gais", "bord gáis", "sse", "pinergy", "flogas", "irish water", "uisce", "british gas", "edf", "octopus energy", "e.on", "eon", "ovo", "bin charge", "panda", "greyhound", "council tax", "property tax", "lpt", "water", "electric", "energy", "gas ", "bescom", "tata power"].map((k) => B(k, "Utilities")),
  ...["vodafone", "three ", "3 ireland", "eir ", "virgin media", "sky ", "tesco mobile", "gomo", "48 ", "o2 ", "ee ", "giffgaff", "bt ", "broadband", "airtel", "jio", "bsnl", "verizon", "at&t", "t-mobile", "comcast", "xfinity"].map((k) => B(k, "Phone & internet")),
  // subscriptions
  ...["netflix", "spotify", "apple.com", "apple music", "itunes", "icloud", "youtube", "disney", "prime video", "amazon prime", "now tv", "hbo", "paramount", "audible", "kindle", "google one", "google storage", "google workspace", "microsoft 365", "office 365", "adobe", "dropbox", "notion", "openai", "chatgpt", "anthropic", "claude", "midjourney", "supabase", "github", "vercel", "figma", "canva", "zoom", "slack", "linkedin premium", "duolingo", "headspace", "calm", "patreon", "substack", "medium", "subscription", "membership"].map((k) => B(k, "Subscriptions")),
  // shopping
  ...["amazon", "amzn", "ebay", "argos", "ikea", "penneys", "primark", "zara", "h&m", "next ", "boots", "harvey norman", "currys", "pc world", "din", "smyths", "decathlon", "jd sports", "lifestyle", "brown thomas", "arnotts", "tk maxx", "zalando", "asos", "shein", "temu", "aliexpress", "etsy", "flipkart", "myntra", "apple store", "samsung", "best buy", "target", "home depot", "b&q", "woodies", "screwfix"].map((k) => B(k, "Shopping")),
  // health & fitness
  ...["pharmacy", "chemist", "lloyds", "hickey", "mccabes", "clinic", "doctor", "gp ", "dental", "dentist", "optician", "specsavers", "hospital", "vhi", "laya", "irish life health", "medical", "physio", "apollo", "1mg", "pharmeasy"].map((k) => B(k, "Health")),
  ...["gym", "fitness", "flyefit", "westwood", "puregym", "anytime fitness", "peloton", "strava", "yoga", "pilates", "swim", "leisure centre", "cult.fit"].map((k) => B(k, "Fitness")),
  // entertainment
  ...["cinema", "odeon", "vue", "imc", "concert", "theatre", "theater", "dice", "ticketmaster", "eventbrite", "steam", "playstation", "xbox", "nintendo", "bookmakers", "paddy power", "boylesports", "lotto", "bookstore", "easons", "waterstones", "bookshop"].map((k) => B(k, "Entertainment")),
  // travel
  ...["hotel", "hostel", "booking.com", "expedia", "hotels.com", "trivago", "agoda", "makemytrip", "oyo", "airline", "airport", "duty free", "travel"].map((k) => B(k, "Travel")),
  // education, kids, insurance, fees, cash, charity, gifts
  ...["udemy", "coursera", "simplilearn", "college", "university", "school", "tuition", "course", "tutor", "byju"].map((k) => B(k, "Education")),
  ...["creche", "crèche", "childcare", "nursery", "montessori", "toys", "kids"].map((k) => B(k, "Kids")),
  ...["insurance", "axa", "allianz", "aviva", "zurich", "liberty", "fbd", "an post insurance", "lic ", "hdfc ergo"].map((k) => B(k, "Insurance")),
  ...["fee", "charge", "interest", "overdraft", "stamp duty", "govt stamp", "maintenance fee", "annual fee", "fx fee", "late payment"].map((k) => B(k, "Fees & charges")),
  ...["atm", "cash withdrawal", "cashback", "cash out"].map((k) => B(k, "Cash")),
  ...["charity", "donation", "trocaire", "trócaire", "concern", "unicef", "red cross", "gofundme", "justgiving"].map((k) => B(k, "Charity")),
  ...["gift", "flowers", "interflora", "hallmark"].map((k) => B(k, "Gifts")),
  // income
  ...["salary", "payroll", "wages", "dividend", "refund", "reimbursement", "tax refund", "revenue", "hmrc", "social welfare", "child benefit", "pension"].map((k) => B(k, "Income")),
];

export function categoriseOne(t: Transaction, rules: Rule[] = DEFAULT_RULES): { category: string; rule: Rule | null } {
  const hay = `${t.merchant} ${t.description}`.toLowerCase();
  let best: Rule | null = null;
  for (const r of rules) {
    const k = r.keyword.toLowerCase();
    if (!k || !hay.includes(k)) continue;
    if (!best) { best = r; continue; }
    const userWins = r.source === "user" && best.source !== "user";
    const longer = r.source === best.source && k.length > best.keyword.length;
    if (userWins || longer) best = r;
  }
  if (best) return { category: best.category, rule: best };
  if (t.direction === "in") return { category: t.isTransfer ? "Transfers" : "Income", rule: null };
  if (t.isTransfer) return { category: "Transfers", rule: null };
  return { category: "", rule: null };
}

/** Returns new objects; input is not mutated. Existing user-set categories are kept when `keep` is true. */
export function categoriseAll(txs: Transaction[], rules: Rule[] = DEFAULT_RULES, keep = true): Transaction[] {
  return txs.map((t) => (keep && t.category ? t : { ...t, category: categoriseOne(t, rules).category }));
}

export function mergeRules(user: Rule[], builtin: Rule[] = DEFAULT_RULES): Rule[] {
  return [...user.map((r) => ({ ...r, source: "user" as const })), ...builtin];
}
