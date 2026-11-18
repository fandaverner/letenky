// Hlídač letenek – spouští ho GitHub Actions. Stáhne ceny, vyhodnotí chyby v cenách,
// uloží data pro web (site/data) a pošle push (ntfy) a e-mail (Resend).
// Bez závislostí, stačí Node 20+.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "site", "data");
const CACHE = path.join(ROOT, "cache");
const API = "https://api.travelpayouts.com";

const env = (k) => (process.env[k] || "").trim() || undefined;
const SECRETS = {
  tpToken: env("TRAVELPAYOUTS_TOKEN"),
  resendKey: env("RESEND_API_KEY"),
  email: env("ALERT_EMAIL"),
  ntfyTopic: env("NTFY_TOPIC"),
};
const SITE = env("SITE_URL") || "";

const DEFAULT_SETTINGS = {
  origin: "PRG",
  months: 6,
  superOneWay: 700,
  superReturn: 1500,
  shortKm: 2500, // do této vzdálenosti platí pevné hranice „super“ výše
  longhaulKm: 4000, // od této vzdálenosti je let dálkový
  superKcPerKmOneWay: 1.0, // dálkový let: super, když cena ≤ km × tato hodnota
  superKcPerKmReturn: 1.6,
  errorKcPerKmOneWay: 0.6, // dálkový let: chyba v ceně, když cena ≤ km × tato hodnota
  errorKcPerKmReturn: 1.0,
  dealDrop: 0.35,
  errorDrop: 0.55,
  maxTransfers: 2,
  notifyPush: true,
  notifyEmail: true,
  dailyDigest: true,
};

const EUROPE = new Set(
  ("AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SE CH UA GB VA " +
    "TR MA TN GE AM AZ IL JO EG").split(" ")
);

// ---------- soubory ----------
async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJSON(file, data, pretty = false) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, pretty ? 2 : 0));
}

// ---------- pomocné ----------
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const today = () => new Date().toISOString().slice(0, 10);

async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function eurRate() {
  const file = path.join(CACHE, "rate.json");
  const cached = await readJSON(file, null);
  if (cached && cached.day === today()) return cached.rate;
  try {
    const r = await fetch(
      "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt"
    );
    const txt = await r.text();
    const line = txt.split("\n").find((l) => l.includes("|EUR|"));
    const rate = line ? parseFloat(line.split("|")[4].replace(",", ".")) : NaN;
    if (rate > 15 && rate < 40) {
      await writeJSON(file, { rate, day: today() });
      return rate;
    }
  } catch {}
  return cached?.rate || 24.5;
}

async function dictionaries() {
  const file = path.join(CACHE, "dict.json");
  const cached = await readJSON(file, null);
  if (cached && cached.v === 3 && cached.day >= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)) return cached;
  const d = { v: 3, day: today(), cities: {}, countries: {}, airlines: {} };
  const tr = (o) => o?.name_translations?.cs || o?.name_translations?.en || o?.name || "";
  try {
    const [cities, countries, airlines] = await Promise.all([
      getJSON(`${API}/data/en/cities.json`, 60000),
      getJSON(`${API}/data/en/countries.json`, 60000),
      getJSON(`${API}/data/en/airlines.json`, 60000),
    ]);
    for (const c of cities)
      d.cities[c.code] = [tr(c), c.country_code, c.coordinates ? +(+c.coordinates.lat).toFixed(3) : null, c.coordinates ? +(+c.coordinates.lon).toFixed(3) : null];
    for (const c of countries) d.countries[c.code] = tr(c);
    for (const a of airlines) if (a.code) d.airlines[a.code] = tr(a) || a.code;
    await writeJSON(file, d);
    return d;
  } catch (e) {
    console.log("Nepodařilo se stáhnout číselníky:", String(e));
    return cached || d;
  }
}

async function pricesForMonth(token, origin, month, oneWay, market) {
  const p = new URLSearchParams({
    origin,
    departure_at: month,
    one_way: String(oneWay),
    sorting: "price",
    unique: "false",
    direct: "false",
    currency: "eur",
    limit: "1000",
    page: "1",
    token,
  });
  if (market) p.set("market", market);
  const j = await getJSON(`${API}/aviasales/v3/prices_for_dates?${p}`);
  if (j.success === false) throw new Error(j.error || "API chyba");
  return j.data || [];
}

async function specialOffers(token, origin, market) {
  const p = new URLSearchParams({ origin, currency: "eur", locale: "en", token });
  if (market) p.set("market", market);
  try {
    const j = await getJSON(`${API}/aviasales/v3/get_special_offers?${p}`);
    return j.data || [];
  } catch (e) {
    console.log("Akce:", String(e));
    return [];
  }
}

async function pickMarket(token, origin, month) {
  const file = path.join(CACHE, "market.json");
  const saved = await readJSON(file, null);
  if (saved && saved.day >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) return saved.m;
  const tries = await Promise.all(
    ["cz", "de", "at", null].map((m) =>
      pricesForMonth(token, origin, month, true, m)
        .then((d) => ({ m, n: d.length }))
        .catch(() => ({ m, n: -1 }))
    )
  );
  let best = { m: null, n: -1 };
  for (const t of tries) if (t.n > best.n) best = t;
  console.log("Trhy:", JSON.stringify(tries));
  await writeJSON(file, { m: best.m, day: today() });
  return best.m;
}

const gFlights = (o, d, dep, ret) =>
  "https://www.google.com/travel/flights?hl=cs&curr=CZK&q=" +
  encodeURIComponent(`Flights from ${o} to ${d} on ${dep}${ret ? ` through ${ret}` : " one way"}`);

const distKm = (a, b) => {
  if (!a || !b || a[2] == null || b[2] == null) return null;
  const R = 6371, r = Math.PI / 180;
  const dLat = (b[2] - a[2]) * r, dLon = (b[3] - a[3]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[2] * r) * Math.cos(b[2] * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
};

export const fmt = (n) => n.toLocaleString("cs-CZ").replace(/ /g, " ") + " Kč";

// ---------- hlavní sken ----------
async function runScan({ digest = false } = {}) {
  const started = Date.now();
  const settings = { ...DEFAULT_SETTINGS, ...(await readJSON(path.join(ROOT, "config.json"), {})) };
  const status = { hasToken: !!SECRETS.tpToken, hasPush: !!SECRETS.ntfyTopic, hasEmail: !!(SECRETS.resendKey && SECRETS.email) };
  const errors = [];

  if (!SECRETS.tpToken) {
    const res = {
      scannedAt: new Date().toISOString(),
      status,
      settings,
      offers: [],
      specials: [],
      errors: ["Chybí Travelpayouts token – přidej secret TRAVELPAYOUTS_TOKEN v nastavení repozitáře."],
    };
    await writeJSON(path.join(DATA, "latest.json"), res);
    console.log(res.errors[0]);
    return res;
  }
  const token = SECRETS.tpToken;
  const origin = String(settings.origin).toUpperCase();
  const [rate, dict] = await Promise.all([eurRate(), dictionaries()]);

  const now = new Date();
  const months = [];
  for (let i = 0; i < settings.months; i++) months.push(ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))));

  const market = await pickMarket(token, origin, months[0]);

  const jobs = [];
  for (const m of months)
    for (const ow of [true, false])
      jobs.push(
        pricesForMonth(token, origin, m, ow, market)
          .then((rows) => ({ type: ow ? "ow" : "rt", rows }))
          .catch((e) => {
            errors.push(`${m} ${ow ? "jedn." : "zpát."}: ${String(e).slice(0, 120)}`);
            return { type: ow ? "ow" : "rt", rows: [] };
          })
      );
  const [results, specialsRaw] = await Promise.all([Promise.all(jobs), specialOffers(token, origin, market)]);

  const all = [];
  const seen = new Set();
  for (const { type, rows } of results) {
    for (const r of rows) {
      if (!r.destination || !r.price) continue;
      if ((r.transfers ?? 0) > settings.maxTransfers) continue;
      if (type === "rt" && !r.return_at) continue;
      const dep = String(r.departure_at || "").slice(0, 10);
      const ret = type === "rt" ? String(r.return_at).slice(0, 10) : null;
      const id = `${type}|${r.destination}|${dep}|${ret || ""}|${r.airline}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const city = dict.cities[r.destination];
      const country = city?.[1] || "";
      const km = distKm(dict.cities[origin], city);
      const nights = ret ? Math.round((Date.parse(ret) - Date.parse(dep)) / 864e5) : null;
      if (nights !== null && nights < 0) continue;
      all.push({
        id,
        type,
        dest: r.destination,
        destName: city?.[0] || r.destination,
        country,
        countryName: dict.countries[country] || country,
        airport: r.destination_airport || r.destination,
        price: Math.round(r.price * rate),
        priceEur: r.price,
        departure: String(r.departure_at || ""),
        ret: type === "rt" ? String(r.return_at) : null,
        nights,
        airline: r.airline || "",
        airlineName: dict.airlines[r.airline] || r.airline || "",
        flightNumber: String(r.flight_number || ""),
        transfers: r.transfers ?? 0,
        returnTransfers: type === "rt" ? r.return_transfers ?? 0 : null,
        duration: r.duration ?? null,
        link: r.link ? `https://www.aviasales.com${r.link}` : "",
        gflink: gFlights(origin, r.destination_airport || r.destination, dep, ret),
        km,
        longhaul: km != null ? km >= settings.longhaulKm : country ? !EUROPE.has(country) : false,
        short: km != null ? km <= settings.shortKm : country ? EUROPE.has(country) : false,
        baseline: null,
        discount: null,
        tag: null,
        reason: null,
      });
    }
  }

  const historyFile = path.join(DATA, "history.json");
  const history = await readJSON(historyFile, {});
  const bestNow = {};
  const monthMins = {};
  for (const o of all) {
    const k = `${o.type}|${o.dest}`;
    bestNow[k] = Math.min(bestNow[k] ?? Infinity, o.price);
    const mk = o.departure.slice(0, 7);
    monthMins[k] = monthMins[k] || {};
    monthMins[k][mk] = Math.min(monthMins[k][mk] ?? Infinity, o.price);
  }

  for (const o of all) {
    const k = `${o.type}|${o.dest}`;
    const past = (history[k] || []).filter(([d]) => d !== today()).map(([, p]) => p);
    let baseline = null;
    if (past.length >= 5) baseline = median(past);
    else {
      const mm = Object.values(monthMins[k] || {});
      if (mm.length >= 3) baseline = median(mm);
    }
    o.baseline = baseline ? Math.round(baseline) : null;
    o.discount = baseline ? Math.max(0, 1 - o.price / baseline) : null;

    const isRt = o.type === "rt";
    const superMax = isRt ? settings.superReturn : settings.superOneWay;
    const km = o.km;
    const errKm = km && o.longhaul ? km * (isRt ? settings.errorKcPerKmReturn : settings.errorKcPerKmOneWay) : null;
    const supKm = km && o.longhaul ? km * (isRt ? settings.superKcPerKmReturn : settings.superKcPerKmOneWay) : null;
    // relativní sleva je spolehlivá jen s historií aspoň 5 dní
    const trusted = past.length >= 5;

    if (errKm && o.price <= errKm) {
      o.tag = "chyba";
      o.reason = `${fmt(o.price)} na ${km.toLocaleString("cs-CZ")} km – podezřele levné`;
    } else if (trusted && o.discount >= settings.errorDrop) {
      o.tag = "chyba";
      o.reason = `${Math.round(o.discount * 100)} % pod obvyklou cenou (${fmt(o.baseline)})`;
    } else if (o.short && o.price <= superMax) {
      o.tag = "super";
      o.reason = `Pod ${fmt(superMax)}`;
    } else if (supKm && o.price <= supKm) {
      o.tag = "super";
      o.reason = `Levný dálkový let (${km.toLocaleString("cs-CZ")} km)`;
    } else if (o.discount !== null && o.discount >= (trusted ? settings.dealDrop : settings.errorDrop)) {
      o.tag = "super";
      o.reason = `${Math.round(o.discount * 100)} % pod obvyklou cenou`;
    } else if (o.discount !== null && o.discount >= 0.2) {
      o.tag = "dobra";
      o.reason = `${Math.round(o.discount * 100)} % pod obvyklou cenou`;
    }
  }

  const cutoff = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  for (const [k, p] of Object.entries(bestNow)) {
    const arr = (history[k] || []).filter(([d]) => d >= cutoff && d !== today());
    const prevToday = (history[k] || []).find(([d]) => d === today());
    arr.push([today(), prevToday ? Math.min(prevToday[1], p) : p]);
    history[k] = arr;
  }

  const keep = new Map();
  for (const o of all) {
    const kk = `${o.type}|${o.dest}|${o.departure.slice(0, 7)}`;
    const cur = keep.get(kk);
    if (!cur || o.price < cur.price) keep.set(kk, o);
  }
  const tagged = all.filter((o) => o.tag === "chyba" || o.tag === "super");
  const final = new Map();
  for (const o of [...keep.values(), ...tagged]) final.set(o.id, o);
  const offers = [...final.values()].sort((a, b) => a.price - b.price);

  const specials = specialsRaw.map((x) => ({
    title: x.title || "",
    mini: x.mini_title || "",
    airline: x.airline,
    airlineName: x.airline_title || dict.airlines[x.airline] || x.airline,
    dest: x.destination,
    destName: x.destination_name || dict.cities[x.destination]?.[0] || x.destination,
    price: Math.round((x.price || 0) * rate),
    departure: x.departure_at || "",
    ret: x.return_at || null,
    link: x.link ? `https://www.aviasales.com${x.link}` : "",
    gflink: gFlights(origin, x.destination, String(x.departure_at || "").slice(0, 10), x.return_at ? String(x.return_at).slice(0, 10) : null),
  }));

  const latest = {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    origin,
    rate,
    market,
    months,
    status,
    settings,
    counts: {
      raw: all.length,
      offers: offers.length,
      chyba: new Set(offers.filter((o) => o.tag === "chyba").map((o) => o.type + o.dest)).size,
      super: new Set(offers.filter((o) => o.tag === "super").map((o) => o.type + o.dest)).size,
      destinations: new Set(offers.map((o) => o.dest)).size,
    },
    offers,
    specials,
    errors,
  };

  await writeJSON(historyFile, history);
  await writeJSON(path.join(DATA, "latest.json"), latest);

  const n = await notify(offers, settings, digest, latest);
  console.log("Hotovo:", JSON.stringify({ counts: latest.counts, market, rate, notify: n, errors, ms: latest.durationMs }));
  return latest;
}

// ---------- notifikace ----------
const fdate = (iso) => {
  const d = new Date(iso);
  return isNaN(+d) ? "" : d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", timeZone: "Europe/Prague" });
};
const flag = (cc) => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "✈️");
function line(o) {
  const when = o.ret ? `${fdate(o.departure)}–${fdate(o.ret)} (${o.nights} n.)` : `${fdate(o.departure)} jednosměrně`;
  const tr = o.transfers === 0 ? "přímý" : `${o.transfers} přestup${o.transfers > 1 ? "y" : ""}`;
  return `${flag(o.country)} ${o.destName} za ${fmt(o.price)} · ${when} · ${tr}`;
}

async function notify(offers, settings, digest, latest) {
  const file = path.join(CACHE, "notified.json");
  const sent = await readJSON(file, {});
  const week = Date.now() - 7 * 864e5;
  for (const k of Object.keys(sent)) if (sent[k].at < week) delete sent[k];

  const best = new Map();
  for (const o of offers) {
    if (o.tag !== "chyba" && o.tag !== "super") continue;
    const k = `${o.type}|${o.dest}`;
    const c = best.get(k);
    if (!c || o.price < c.price) best.set(k, o);
  }
  const fresh = [...best.values()]
    .filter((o) => {
      const p = sent[`${o.type}|${o.dest}`];
      return !p || o.price < p.p * 0.9;
    })
    .sort((a, b) => (a.tag === b.tag ? a.price - b.price : a.tag === "chyba" ? -1 : 1));

  const out = { fresh: fresh.length };

  if (fresh.length && settings.notifyPush && SECRETS.ntfyTopic) {
    const errs = fresh.filter((o) => o.tag === "chyba");
    const top = fresh.slice(0, 6);
    const title = errs.length
      ? `🔥 ${errs.length}× možná chyba v ceně z Prahy!`
      : `✈️ ${fresh.length} super levn${fresh.length === 1 ? "á letenka" : "é letenky"} z Prahy`;
    out.push = await sendPush({
      title,
      message: top.map(line).join("\n") + (fresh.length > top.length ? `\n… a dalších ${fresh.length - top.length}` : ""),
      priority: errs.length ? 5 : 4,
      tags: errs.length ? ["fire", "airplane"] : ["airplane"],
      click: SITE || top[0].gflink,
    });
  }

  const wantEmailNow = fresh.some((o) => o.tag === "chyba");
  if (settings.notifyEmail && SECRETS.resendKey && SECRETS.email && (wantEmailNow || (digest && settings.dailyDigest))) {
    const subject = wantEmailNow
      ? `🔥 Možná chyba v ceně: ${fresh
          .filter((o) => o.tag === "chyba")
          .slice(0, 2)
          .map((o) => `${o.destName} ${fmt(o.price)}`)
          .join(", ")}`
      : `✈️ Ranní přehled letenek z Prahy – od ${offers[0] ? fmt(offers[0].price) : "?"}`;
    out.email = await sendEmail(subject, emailHtml(fresh, offers, latest));
  }

  for (const o of fresh) sent[`${o.type}|${o.dest}`] = { p: o.price, at: Date.now() };
  await writeJSON(file, sent);
  return out;
}

async function sendPush(m) {
  try {
    const r = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: SECRETS.ntfyTopic, ...m }),
    });
    return r.ok ? "ok" : `HTTP ${r.status}`;
  } catch (e) {
    return String(e);
  }
}

async function sendEmail(subject, html) {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRETS.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Hlídač letenek <onboarding@resend.dev>", to: [SECRETS.email], subject, html }),
    });
    return r.ok ? "ok" : `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
  } catch (e) {
    return String(e);
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function row(o) {
  const badge =
    o.tag === "chyba"
      ? `<span style="background:#ff4d3d;color:#fff;border-radius:4px;padding:1px 6px;font-size:12px">CHYBA V CENĚ?</span> `
      : o.tag === "super"
      ? `<span style="background:#18a957;color:#fff;border-radius:4px;padding:1px 6px;font-size:12px">SUPER</span> `
      : "";
  return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${badge}<b>${esc(line(o))}</b><br>
  <span style="color:#666;font-size:13px">${esc(o.airlineName)}${o.reason ? " · " + esc(o.reason) : ""}</span><br>
  <a href="${o.gflink}">Google Flights</a>${o.link ? ` · <a href="${o.link}">Aviasales</a>` : ""}</td></tr>`;
}
function emailHtml(fresh, offers, latest) {
  const freshIds = new Set(fresh.map((o) => o.id));
  const perDest = new Map();
  for (const o of offers) if (!freshIds.has(o.id) && !perDest.has(o.dest)) perDest.set(o.dest, o);
  const cheapest = [...perDest.values()].slice(0, 15);
  return `<div style="font-family:system-ui,Segoe UI,Arial;max-width:620px;margin:auto;color:#111">
  <h2 style="margin:0 0 4px">✈️ Hlídač letenek z Prahy</h2>
  <div style="color:#666;font-size:13px;margin-bottom:16px">Prohledáno ${latest.counts?.destinations ?? "?"} destinací · kurz ${latest.rate} Kč/€</div>
  ${fresh.length ? `<h3>Nové super nabídky</h3><table style="width:100%;border-collapse:collapse">${fresh.slice(0, 20).map(row).join("")}</table>` : ""}
  <h3>Nejlevnější destinace teď</h3><table style="width:100%;border-collapse:collapse">${cheapest.map(row).join("")}</table>
  ${SITE ? `<p><a href="${SITE}" style="background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Otevřít přehled</a></p>` : ""}
  <p style="color:#999;font-size:12px">Ceny jsou z cache vyhledávání Aviasales (posledních 48 h) – před nákupem vždy ověř aktuální cenu.</p></div>`;
}

// ---------- spuštění ----------
if (process.argv.includes("--test-notify")) {
  console.log("Push:", SECRETS.ntfyTopic ? await sendPush({ title: "✈️ Test hlídače letenek", message: "Funguje to! Sem ti budou chodit super levné letenky z Prahy.", tags: ["airplane"], click: SITE || undefined }) : "chybí NTFY_TOPIC");
  console.log("E-mail:", SECRETS.resendKey && SECRETS.email ? await sendEmail("✈️ Test hlídače letenek", `<p>Funguje to! Sem ti budou chodit chyby v cenách a ranní přehled.</p>${SITE ? `<p><a href="${SITE}">Otevřít přehled</a></p>` : ""}`) : "chybí RESEND_API_KEY nebo ALERT_EMAIL");
} else {
  const digest = process.env.DIGEST === "true";
  await runScan({ digest });
}
