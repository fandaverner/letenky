// Společné odesílání upozornění (ntfy push + Resend e-mail)
const env = (k) => (process.env[k] || "").trim() || undefined;
const SECRETS = {
  resendKey: env("RESEND_API_KEY"),
  email: env("ALERT_EMAIL"),
  ntfyTopic: env("NTFY_TOPIC"),
};
export const canPush = () => !!SECRETS.ntfyTopic;
export const canEmail = () => !!(SECRETS.resendKey && SECRETS.email);

export async function sendPush(m) {
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

export async function sendEmail(subject, html) {
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

