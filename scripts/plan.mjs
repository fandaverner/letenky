// Rozhodne, co se má při tomto spuštění dělat (GitHub budí workflow každou hodinu).
import { readFile, writeFile, mkdir } from "node:fs/promises";
const event = process.argv[2] || "schedule";
const read = async (f) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } };
const ageH = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 36e5 : 999);
const manual = event !== "schedule";
const latest = await read("site/data/latest.json");
const tours = await read("site/data/tours.json");
const flights = manual || ageH(latest?.scannedAt) >= 3.5;
const toursDo = manual || ageH(tours?.scannedAt) >= 5.5;
// ranní přehled: první letenkový sken po 6:00 pražského času, jednou denně
const now = new Date();
const pragueHour = +now.toLocaleString("en-GB", { timeZone: "Europe/Prague", hour: "2-digit", hour12: false });
const pragueDay = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
const dg = (await read("cache/digest.json")) || {};
const digest = flights && pragueHour >= 6 && pragueHour < 12 && dg.day !== pragueDay;
if (digest) { await mkdir("cache", { recursive: true }); await writeFile("cache/digest.json", JSON.stringify({ day: pragueDay })); }
console.log(`flights=${flights}`);
console.log(`tours=${toursDo}`);
console.log(`digest=${digest}`);
console.log(`any=${flights || toursDo}`);
console.error(`Letenky: ${flights ? "ano" : "ne"} (stáří ${ageH(latest?.scannedAt).toFixed(1)} h), zájezdy: ${toursDo ? "ano" : "ne"} (stáří ${ageH(tours?.scannedAt).toFixed(1)} h), ranní přehled: ${digest}`);
