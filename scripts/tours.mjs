// Hlídač levných zájezdů z ČR – čte last minute nabídky cestovních kanceláří,
// sleduje vývoj cen a hlásí výrazné slevy a zlevnění.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCedok, parseBlueStyle } from "./tours-parse.mjs";
import { sendPush, sendEmail, canPush, canEmail } from "./notify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "site", "data");
const CACHE = path.join(ROOT, "cache");
const SITE = (process.env.SITE_URL || "").trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const DEFAULTS = {
  enabled: true,
  superDiscount: 40, // % sleva od CK → super
  errorDiscount: 60, // % sleva od CK → podezřele levné
  superPerNight: 1300, // Kč/os/noc (letecky) → super
  errorPerNight: 800, // Kč/os/noc (letecky, min. 5 nocí) → podezřele levné
  dropPct: 15, // zlevnění oproti minulé ceně stejného termínu
  minRatingPct: 60, // horší hotely neposílat do upozornění
  maxPagesCedok: 45,
  maxPagesBlueStyle: 20,
};

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function readJSON(f, fb) {
  try {
    return JSON.parse(await readFile(f, "utf8"));
  } catch {
    return fb;
  }
}
async function writeJSON(f, d) {
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(d));
}
async function getHTML(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs-CZ,cs;q=0.9", Accept: "text/html" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
const fmt = (n) => Math.round(n).toLocaleString("cs-CZ").replace(/ /g, " ") + " Kč";

async function crawlCedok(max, errors) {
  const all = [];
  for (let page = 1; page <= max; page++) {
    try {
      const html = await getHTML(`https://www.cedok.cz/last-minute/${page > 1 ? `?page=${page}` : ""}`);
      const items = parseCedok(html);
      if (!items.length) break;
      all.push(...items);
    } catch (e) {
      errors.push(`Čedok str. ${page}: ${String(e).slice(0, 80)}`);
      break;
    }
    await sleep(1200);
  }
  return all;
}

async function crawlBlueStyle(max, errors) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= max; page++) {
    try {
      const html = await getHTML(`https://www.blue-style.cz/last-minute/${page > 1 ? `?page=${page}` : ""}`);
      const { offers } = parseBlueStyle(html);
      const fresh = offers.filter((o) => !seen.has(o.id));
      if (!fresh.length) break; // stránkování skončilo nebo nefunguje
      fresh.forEach((o) => seen.add(o.id));
      all.push(...fresh);
    } catch (e) {
      errors.push(`Blue Style str. ${page}: ${String(e).slice(0, 80)}`);
      break;
    }
    await sleep(1200);
  }
  return all;
}

async function run() {
  const cfgAll = await readJSON(path.join(ROOT, "config.json"), {});
  const cfg = { ...DEFAULTS, ...(cfgAll.tours || {}) };
  if (!cfg.enabled) return console.log("Zájezdy vypnuté v config.json");
  const started = Date.now();
  const errors = [];

  const [cedok, blue] = await Promise.all([crawlCedok(cfg.maxPagesCedok, errors), crawlBlueStyle(cfg.maxPagesBlueStyle, errors)]);
  const sources = { "Čedok": cedok.length, "Blue Style": blue.length };

  // sloučit, nejlevnější varianta pro stejný hotel + termín
  const map = new Map();
  for (const o of [...cedok, ...blue]) {
    if (!o.price || !o.from || o.from < today()) continue;
    const c = map.get(o.id);
    if (!c || o.price < c.price) map.set(o.id, o);
  }
  const offers = [...map.values()];

  // historie cen pro každý konkrétní termín
  const histFile = path.join(CACHE, "tours-history.json");
  const hist = await readJSON(histFile, {});
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);

  for (const o of offers) {
    o.perNight = o.nights ? Math.round(o.price / o.nights) : null;
    const h = hist[o.id] || [];
    const prevMin = h.filter(([d]) => d !== today()).reduce((m, [, p]) => Math.max(m, p), 0);
    o.prevPrice = prevMin || null;
    o.drop = prevMin && o.price < prevMin ? Math.round((1 - o.price / prevMin) * 100) : null;
    const fly = o.transport === "letecky";
    const reasons = [];
    let tag = null;
    if (o.discount >= cfg.errorDiscount) {
      tag = "chyba";
      reasons.push(`sleva ${o.discount} %`);
    }
    if (fly && o.perNight && o.nights >= 5 && o.perNight <= cfg.errorPerNight) {
      tag = "chyba";
      reasons.push(`jen ${fmt(o.perNight)}/noc i s letenkou`);
    }
    if (!tag && o.discount >= cfg.superDiscount) {
      tag = "super";
      reasons.push(`sleva ${o.discount} %`);
    }
    if (!tag && fly && o.perNight && o.perNight <= cfg.superPerNight) {
      tag = "super";
      reasons.push(`${fmt(o.perNight)}/noc i s letenkou`);
    }
    if (o.drop >= cfg.dropPct) {
      reasons.push(`zlevněno o ${o.drop} % (dřív ${fmt(o.prevPrice)})`);
      if (!tag) tag = "zlevneno";
    }
    o.tag = tag;
    o.reason = reasons.join(" · ") || null;
  }

  // uložit historii (jen aktuální a nedávné termíny)
  const newHist = {};
  for (const o of offers) {
    const h = (hist[o.id] || []).filter(([d]) => d >= cutoff && d !== today());
    const t = (hist[o.id] || []).find(([d]) => d === today());
    h.push([today(), t ? Math.min(t[1], o.price) : o.price]);
    newHist[o.id] = h;
  }
  for (const [k, h] of Object.entries(hist)) if (!newHist[k] && h.some(([d]) => d >= cutoff)) newHist[k] = h;
  await writeJSON(histFile, newHist);

  offers.sort((a, b) => a.price - b.price);
  const counts = {
    total: offers.length,
    chyba: offers.filter((o) => o.tag === "chyba").length,
    super: offers.filter((o) => o.tag === "super").length,
    zlevneno: offers.filter((o) => o.drop >= cfg.dropPct).length,
    countries: new Set(offers.map((o) => o.country)).size,
  };
  const out = { scannedAt: new Date().toISOString(), durationMs: Date.now() - started, sources, counts, settings: cfg, offers, errors };
  // když stahování úplně selže, nepřepisuj dobrá data prázdnými
  const prev = await readJSON(path.join(DATA, "tours.json"), null);
  if (!offers.length && prev?.offers?.length) {
    await writeJSON(path.join(DATA, "tours.json"), { ...prev, errors: ["Poslední stahování selhalo: " + errors.join("; ")] });
  } else {
    await writeJSON(path.join(DATA, "tours.json"), out);
  }

  const notify = await notifyTours(offers, cfg);
  console.log("Zájezdy hotovo:", JSON.stringify({ sources, counts, notify, errors, ms: out.durationMs }));
}

const fdate = (iso) => {
  const d = new Date(iso);
  return isNaN(+d) ? "" : d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" });
};
const line = (o) =>
  `${o.country}${o.region && o.region !== o.country ? " – " + o.region : ""}: ${o.hotel}${o.stars ? " " + "★".repeat(Math.floor(o.stars)) : ""} · ${fdate(o.from)}, ${o.nights} nocí, ${o.board || "?"}${o.depCity ? ", z " + o.depCity : ""} · ${fmt(o.price)}/os.${o.reason ? " (" + o.reason + ")" : ""} · ${o.ck}`;

async function notifyTours(offers, cfg) {
  const file = path.join(CACHE, "tours-notified.json");
  const sent = await readJSON(file, {});
  const week = Date.now() - 10 * 864e5;
  for (const k of Object.keys(sent)) if (sent[k].at < week) delete sent[k];

  const fresh = offers
    .filter((o) => o.tag && (o.ratingPct == null || o.ratingPct >= cfg.minRatingPct))
    .filter((o) => {
      const p = sent[o.id];
      return !p || o.price < p.p * 0.92;
    })
    .sort((a, b) => (a.tag === b.tag ? (b.discount || 0) - (a.discount || 0) : a.tag === "chyba" ? -1 : b.tag === "chyba" ? 1 : a.tag === "super" ? -1 : 1));

  // max. 1 upozornění na hotel, ať to nezahltí mobil
  const byHotel = new Map();
  for (const o of fresh) {
    const k = o.ck + o.hotel;
    if (!byHotel.has(k)) byHotel.set(k, o);
  }
  const pick = [...byHotel.values()];
  const res = { fresh: pick.length };
  if (pick.length && canPush()) {
    const errs = pick.filter((o) => o.tag === "chyba").length;
    const top = pick.slice(0, 5);
    res.push = await sendPush({
      title: errs ? `🏖️🔥 ${errs}× podezřele levný zájezd!` : `🏖️ ${pick.length} levn${pick.length === 1 ? "ý zájezd" : "é zájezdy"} z ČR`,
      message: top.map(line).join("\n\n") + (pick.length > top.length ? `\n\n… a dalších ${pick.length - top.length}` : ""),
      priority: errs ? 5 : 3,
      tags: errs ? ["fire", "beach_with_umbrella"] : ["beach_with_umbrella"],
      click: SITE ? SITE + "#zajezdy" : top[0].url,
    });
  }
  if (pick.some((o) => o.tag === "chyba") && canEmail()) {
    const rows = pick
      .slice(0, 20)
      .map(
        (o) =>
          `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${o.tag === "chyba" ? '<b style="color:#e33">PODEZŘELE LEVNÉ</b> ' : ""}<b>${line(o)}</b><br><a href="${o.url}">Zobrazit u ${o.ck}</a></td></tr>`
      )
      .join("");
    res.email = await sendEmail(
      `🏖️ Podezřele levné zájezdy: ${pick.filter((o) => o.tag === "chyba").slice(0, 2).map((o) => `${o.country} ${fmt(o.price)}`).join(", ")}`,
      `<div style="font-family:system-ui,Arial;max-width:640px;margin:auto"><h2>🏖️ Levné zájezdy z ČR</h2><table style="width:100%;border-collapse:collapse">${rows}</table>${SITE ? `<p><a href="${SITE}#zajezdy">Otevřít přehled</a></p>` : ""}</div>`
    );
  }
  for (const o of pick) sent[o.id] = { p: o.price, at: Date.now() };
  await writeJSON(file, sent);
  return res;
}

await run();
