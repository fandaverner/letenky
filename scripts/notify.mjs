// Společné odesílání upozornění (ntfy push + Resend e-mail)
const env = (k) => (process.env[k] || "").trim() || undefined;
const SECRETS = {
  resendKey: env("RESEND_API_KEY"),
  email: env("ALERT_EMAIL"),
  ntfyTopic: env("NTFY_TOPIC"),
};
import { readFile, writeFile, rm } from "node:fs/promises";
const OUTBOX = "/tmp/letenky-outbox.json";
const DEFER = process.env.DEFER_NOTIFY === "1";
async function defer(kind, args) {
  let box = [];
  try { box = JSON.parse(await readFile(OUTBOX, "utf8")); } catch {}
  box.push({ kind, args });
  await writeFile(OUTBOX, JSON.stringify(box));
  return "odloženo";
}
export async function flushOutbox() {
  let box = [];
  try { box = JSON.parse(await readFile(OUTBOX, "utf8")); } catch { return []; }
  const out = [];
  for (const { kind, args } of box) out.push(kind === "push" ? await sendPushNow(...args) : await sendEmailNow(...args));
  await rm(OUTBOX, { force: true });
  return out;
}
export const sendPush = (...a) => (DEFER ? defer("push", a) : sendPushNow(...a));
export const sendEmail = (...a) => (DEFER ? defer("email", a) : sendEmailNow(...a));

export const canPush = () => !!SECRETS.ntfyTopic;
export const canEmail = () => !!(SECRETS.resendKey && SECRETS.email);

async function sendPushNow(m) {
  const topic = SECRETS.ntfyTopic.replace(/^https?:\/\/ntfy\.sh\//, "").replace(/[\s"'\/]/g, "");
  const hint = `téma ${topic.length} znaků, začíná „${topic.slice(0, 9)}“, končí „${topic.slice(-2)}“`;
  try {
    const r = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, ...m }),
    });
    const body = await r.text();
    if (r.ok) return `ok (${hint})`;
    console.log("ntfy JSON odpověď:", r.status, body.slice(0, 300));
    // záložní jednoduché odeslání
    const r2 = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: { Title: "Letenky z Prahy", Tags: (m.tags || []).join(",") },
      body: `${m.title}\n${m.message}`,
    });
    const body2 = await r2.text();
    return r2.ok ? `ok přes záložní cestu (${hint})` : `HTTP ${r.status}/${r2.status}: ${body2.slice(0, 200)} (${hint})`;
  } catch (e) {
    return `${String(e)} (${hint})`;
  }
}

async function sendEmailNow(subject, html) {
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

