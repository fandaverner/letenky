// Čtečky nabídek zájezdů z webů cestovních kanceláří.
const decode = (s) =>
  s
    .replace(/&nbsp;|&#160;| /g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const text = (html) => decode(html.replace(/<[^>]+>/g, "|")).replace(/\s+/g, " ").split("|").map((x) => x.trim()).filter(Boolean);
const num = (s) => (s ? parseInt(String(s).replace(/[^\d]/g, ""), 10) || null : null);

// ---------- Čedok: HTML karty ----------
export function parseCedok(html) {
  const out = [];
  const parts = html.split('data-testid="offer-list-item"').slice(1);
  for (const raw of parts) {
    const p = raw.slice(0, 12000);
    try {
      const t = text("<x " + p);
      const href = (p.match(/href="(\/dovolena\/[^"]+)"/) || [])[1];
      if (!href) continue;
      const cur = p.match(/data-testid="current-price"[^>]*>([\s\S]*?)<\/(div|span)>/);
      const base = p.match(/data-testid="base-price"[^>]*>([\s\S]*?)<\/(div|span)>/);
      const priceIdx = t.findIndex((x) => /\/\s*os\./.test(x));
      const prices = t.filter((x) => /^\d[\d ]*Kč$/.test(x)).map(num);
      const price = num(cur && text(cur[1]).join(" ")) || prices[prices.length - 2] || prices[0];
      const orig = num(base && text(base[1]).join(" "));
      const dIdx = t.findIndex((x) => /^\(\d+ dní\)$/.test(x));
      const dashIdx = t.findIndex((x, i) => x === "-" && /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(t[i + 1] || ""));
      const dateTo = dashIdx >= 0 ? t[dashIdx + 1] : t.find((x) => /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(x));
      const dateFrom = dashIdx > 0 && /^\d{1,2}\.\d{1,2}\.?$/.test(t[dashIdx - 1]) ? t[dashIdx - 1] : null;
      const year = dateTo ? +dateTo.split(".")[2] : null;
      const toIso = (s, y) => {
        const [d, m] = s.split(".").map(Number);
        return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      };
      let from = null, to = null;
      if (dateTo) {
        to = toIso(dateTo, year);
        if (dateFrom) {
          const [, fm] = dateFrom.split(".").map(Number);
          const [, tm] = dateTo.split(".").map(Number);
          from = toIso(dateFrom, fm > tm ? year - 1 : year);
        }
      }
      const days = dIdx >= 0 ? num(t[dIdx]) : null;
      const depCity = dIdx >= 0 ? (t[dIdx + 1] || "").replace(/\s*\(letiště\)/, "") : "";
      const boards = ["All inclusive", "Ultra all inclusive", "Polopenze", "Plná penze", "Snídaně", "Bez stravy", "Strava dle programu"];
      const board = t.find((x) => boards.some((b) => x.toLowerCase().startsWith(b.toLowerCase()))) || "";
      // destinace: za štítkem, "Země, Oblast", pak název hotelu
      const ci = t.indexOf(",");
      const country = ci > 0 ? t[ci - 1] : "";
      const region = ci > 0 ? t[ci + 1] : "";
      const hotel = ci > 0 ? t[ci + 2] : "";
      const rating = t.find((x) => /^\d(\.\d)?$/.test(x));
      const reviews = num((t.find((x) => /hodnocen/.test(x)) || "").match(/\d[\d ]*/)?.[0]);
      if (!price || !hotel) continue;
      out.push({
        ck: "Čedok",
        id: "cedok|" + href.split("?")[0] + "|" + from,
        hotel,
        country,
        region,
        stars: null,
        rating: rating ? `${rating}/6` : null,
        ratingPct: rating ? Math.round((+rating / 6) * 100) : null,
        reviews,
        from,
        to,
        nights: days ? days - 1 : null,
        depCity,
        board,
        transport: !depCity ? "" : /vlastní|autobus|bus/i.test(depCity) ? "vlastní" : "letecky",
        price,
        orig: orig && orig > price ? orig : null,
        discount: orig && orig > price ? Math.round((1 - price / orig) * 100) : null,
        url: "https://www.cedok.cz" + href,
        img: decode((p.match(/<img[^>]+src="(https:\/\/[^"]+)"/) || [])[1] || "") || null,
      });
    } catch {}
  }
  return out;
}

// ---------- Blue Style: data v __NEXT_DATA__ (Apollo) ----------
const STARS = { STAR_1: 1, STAR_2: 2, STAR_2_PLUS: 2.5, STAR_3: 3, STAR_3_PLUS: 3.5, STAR_4: 4, STAR_4_PLUS: 4.5, STAR_5: 5, STAR_5_PLUS: 5.5 };
export function parseBlueStyle(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { offers: [], hotelCount: null };
  const d = JSON.parse(m[1]);
  const ap = d.apolloState || d.props?.apolloState || {};
  const get = (r) => (r && r.__ref ? ap[r.__ref] : r);
  const out = [];
  let hotelCount = null;
  for (const [k, h] of Object.entries(ap)) {
    if (k.startsWith("KeyValuePair-") && /hotel/.test(h.value || "")) hotelCount = num(h.key);
    if (!k.startsWith("ThematicHolidayHotel-")) continue;
    const ct = get(h.cheapestTerm);
    if (!ct || !ct.priceFrom) continue;
    const r = get(h.rating);
    const from = ct.departureDate;
    const to = from ? new Date(Date.parse(from) + (ct.nightCount || 7) * 864e5).toISOString().slice(0, 10) : null;
    const price = ct.priceFrom;
    const disc = ct.percentageDiscount || null;
    out.push({
      ck: "Blue Style",
      id: "bluestyle|" + h.idHotel + "|" + from,
      hotel: h.name,
      country: h.countryName || "",
      region: h.regionName || h.destinationName || "",
      stars: STARS[h.stars] ?? null,
      rating: r?.rating || null,
      ratingPct: num(r?.rating),
      reviews: r?.ratingCount || null,
      from,
      to,
      nights: ct.nightCount || null,
      depCity: "Praha",
      board: ct.boardingType || "",
      transport: "letecky",
      price,
      orig: disc ? Math.round(price / (1 - disc / 100) / 10) * 10 : null,
      discount: disc,
      url: "https://www.blue-style.cz" + (ct.url || h.url),
      img: h.photoUrl ? "https://www.blue-style.cz" + h.photoUrl : null,
    });
  }
  return { offers: out, hotelCount };
}
