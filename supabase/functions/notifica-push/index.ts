// ─────────────────────────────────────────────────────────────
// AVVISI OPERATORI — Web Push: nuovo ordine + ordine urgente (PWA portale)
// ─────────────────────────────────────────────────────────────
// Invocata da un cron ogni 5 min (pg_cron → pg_net). Ad ogni giro, SOLO in finestra
// operativa (lun-ven 8:00–17:00 Europe/Rome, no festivi):
//   1. NUOVI ORDINI (push_nuovo_inviato=false): una push a testa, poi segna inviato.
//   2. URGENTI/EXPRESS ancora 'ricevuto': ripete ogni REMINDER_MIN finché non vanno in produzione.
// Destinatari: TUTTE le iscrizioni push attive (operatori iscritti dal portale via token,
// ed eventuali account admin). Un link unico condiviso, nessuna escalation al responsabile.
//
// SECRET: WEBHOOK_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY automatici.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush";

// ── Config ────────────────────────────────────────────────────
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ordini@abutmentcompatibili.com";
const REMINDER_MIN = Number(Deno.env.get("REMINDER_MIN") ?? "10");   // ogni quanto ripetere l'urgente
const PORTALE_URL = "https://abc-cadcam-ordini.github.io/ac-ordini/portale.html";

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// ── WhatsApp operatori via respond.io (stesso canale/formato dei clienti) ──────
// ADDITIVO e DORMIENTE: spedisce SOLO se OPERATORI_WHATSAPP è impostato (numeri in
// formato E.164, separati da virgola, es. "+393517032387"). Richiede il template
// WhatsApp APPROVATO `ac_avviso_operatore` — {{1}}=tipo avviso, {{2}}=cliente.
// Se non configurato o se respond.io dà errore, le push NON ne risentono.
const RESPOND_TOKEN = Deno.env.get("RESPOND_IO_TOKEN") ?? "";
const RESPOND_CHANNEL = Number(Deno.env.get("RESPOND_IO_CHANNEL_ID") ?? "446581");
const WA_TEMPLATE = "ac_avviso_operatore";
const OPERATORI_WA = (Deno.env.get("OPERATORI_WHATSAPP") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function waOperatore(tipo: string, cliente: string) {
  if (!OPERATORI_WA.length || !RESPOND_TOKEN) return;   // dormiente finché non configurato
  await Promise.all(OPERATORI_WA.map(async (phone) => {
    try {
      const res = await fetch(
        `https://api.respond.io/v2/contact/phone:${encodeURIComponent(phone)}/message`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESPOND_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            channelId: RESPOND_CHANNEL,
            message: {
              type: "whatsapp_template",
              template: {
                name: WA_TEMPLATE,
                languageCode: "it",
                components: [{
                  type: "body",
                  parameters: [{ type: "text", text: tipo }, { type: "text", text: cliente }],
                }],
              },
            },
          }),
        },
      );
      if (!res.ok) console.error("wa operatore:", res.status, await res.text());
    } catch (e) { console.error("wa operatore:", (e as any)?.message ?? e); }
  }));
}

// ── Finestra operativa: lun-ven, 8:00–17:00 (fuso Roma), esclusi i festivi nazionali ──
const TZ = "Europe/Rome";
const WORK_START = Number(Deno.env.get("WORK_START_HOUR") ?? "8");  // ora inclusa
const WORK_END = Number(Deno.env.get("WORK_END_HOUR") ?? "17");    // ora esclusa (alle 17:00 stop)

function romeParts(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, weekday: "short", hour: "2-digit", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const wd: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    y: Number(parts.year), m: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), wd: wd[parts.weekday as string] ?? 0,
  };
}
function pasqua(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mth = Math.floor((a + 11 * h + 22 * l) / 451);
  return { m: Math.floor((h + l - 7 * mth + 114) / 31), d: ((h + l - 7 * mth + 114) % 31) + 1 };
}
function isFestivo(y: number, m: number, day: number): boolean {
  const fissi = new Set(["1-1", "1-6", "4-25", "5-1", "6-2", "8-15", "11-1", "12-8", "12-25", "12-26"]);
  if (fissi.has(`${m}-${day}`)) return true;
  const p = pasqua(y);
  if (m === p.m && day === p.d) return true;                       // Pasqua
  const lun = new Date(Date.UTC(y, p.m - 1, p.d) + 86400000);      // Pasquetta = Pasqua + 1
  return m === lun.getUTCMonth() + 1 && day === lun.getUTCDate();
}
function inFinestraOperativa(now: Date): boolean {
  const t = romeParts(now);
  if (t.wd < 1 || t.wd > 5) return false;
  if (t.hour < WORK_START || t.hour >= WORK_END) return false;
  return !isFestivo(t.y, t.m, t.day);
}

// ── VAPID: dalle chiavi base64url standard al formato JWK della libreria ──────
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function bytesToB64url(u: Uint8Array): string {
  let bin = "";
  for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function buildAppServer() {
  const pub = b64urlToBytes(VAPID_PUBLIC);              // 65 byte: 0x04 || X(32) || Y(32)
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  const jwkPublic = { kty: "EC", crv: "P-256", x, y, ext: true, key_ops: [] as string[] };
  const jwkPrivate = { kty: "EC", crv: "P-256", x, y, d: VAPID_PRIVATE, ext: true, key_ops: ["sign"] };
  const vapidKeys = await webpush.importVapidKeys(
    { publicKey: jwkPublic, privateKey: jwkPrivate },
    { extractable: false },
  );
  return await webpush.ApplicationServer.new({ contactInformation: VAPID_SUBJECT, vapidKeys });
}

function labelOrdine(o: any): string {
  return ((o.nome || "").trim()) || ((o.azienda || "").trim()) || "Cliente";
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  // Niente avvisi fuori orario o nei giorni rossi: gli ordini restano in lista e
  // ripartono al primo tick utile (es. lunedì alle 8:00).
  if (!inFinestraOperativa(new Date())) {
    return new Response(JSON.stringify({ ok: true, skipped: "fuori finestra operativa" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  const now = Date.now();

  // Tutte le iscrizioni push attive (operatori via token-portale ed eventuali account admin)
  const { data: subsRaw, error: eS } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("attivo", true);
  if (eS) { console.error("subs:", eS.message); return new Response("db error", { status: 500 }); }
  const subs = (subsRaw ?? []) as any[];
  if (!subs.length) return new Response(JSON.stringify({ ok: true, subs: 0 }), { status: 200 });

  const appServer = await buildAppServer();
  async function inviaTutti(payload: any) {
    await Promise.all(subs.map(async (s) => {
      try {
        const subscriber = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
        await subscriber.pushTextMessage(JSON.stringify(payload), {});
      } catch (err: any) {
        const code = err?.response?.status ?? err?.status;
        if (code === 404 || code === 410) {
          await db.from("push_subscriptions").update({ attivo: false }).eq("id", s.id); // iscrizione scaduta
        } else {
          console.error("push send:", err?.message ?? err);
        }
      }
    }));
  }

  let nuovi = 0, urgenti = 0;

  // 1) NUOVI ORDINI: una push a testa, poi segna inviato (niente ripetizioni).
  const { data: nuoviOrd } = await db
    .from("orders")
    .select("id, nome, azienda, scheda_dati")
    .eq("push_nuovo_inviato", false)
    .neq("status", "concluso");
  for (const o of (nuoviOrd ?? []) as any[]) {
    await inviaTutti({
      title: "📥 Nuovo ordine",
      body: labelOrdine(o) + ": nuovo ordine ricevuto.",
      tag: "nuovo-" + o.id,
      url: PORTALE_URL,
      orderId: o.id,
    });
    await waOperatore("Nuovo ordine", labelOrdine(o));   // WhatsApp operatori (dormiente se non configurato)
    // Implant Detector: il cliente ha spuntato "ritira il prodotto fisicamente" (+€10) → va organizzato un corriere.
    if (o.scheda_dati?.detector?.ritiro_fisico) {
      await inviaTutti({
        title: "🚚 Ritiro da organizzare",
        body: labelOrdine(o) + ": il cliente ha richiesto il ritiro corriere (+€10).",
        tag: "ritiro-" + o.id,
        url: PORTALE_URL,
        orderId: o.id,
      });
      await waOperatore("Ritiro da organizzare", labelOrdine(o));
    }
    nuovi++;
  }
  if (nuoviOrd?.length) {
    await db.from("orders").update({ push_nuovo_inviato: true }).in("id", (nuoviOrd as any[]).map((o) => o.id));
  }

  // 2) URGENTI/EXPRESS ancora 'ricevuto': ripeti ogni REMINDER_MIN finché non in produzione.
  const { data: urg } = await db
    .from("orders")
    .select("id, nome, azienda, urgenza")
    .in("urgenza", ["urgente", "express"])
    .eq("status", "ricevuto");
  const ids = (urg ?? []).map((o: any) => o.id);
  const stato = new Map<string, any>();
  if (ids.length) {
    const { data: st } = await db.from("urgenti_notifiche").select("*").in("order_id", ids);
    for (const s of (st ?? []) as any[]) stato.set(s.order_id, s);
  }
  for (const o of (urg ?? []) as any[]) {
    const st = stato.get(o.id);
    const ultimo = st?.ultimo_avviso_at ? new Date(st.ultimo_avviso_at).getTime() : 0;
    if (ultimo && now - ultimo < REMINDER_MIN * 60_000) continue;
    const urgLabel = o.urgenza === "urgente" ? "URGENTE" : "EXPRESS";
    await inviaTutti({
      title: "🔴 Ordine " + urgLabel,
      body: labelOrdine(o) + ": da mandare in produzione.",
      tag: "urgente-" + o.id,
      url: PORTALE_URL,
      orderId: o.id,
    });
    await waOperatore("Ordine " + urgLabel, labelOrdine(o));   // WhatsApp operatori (URGENTE/EXPRESS)
    urgenti++;
    await db.from("urgenti_notifiche").upsert({
      order_id: o.id,
      ultimo_avviso_at: new Date(now).toISOString(),
      avvisi_count: (st?.avvisi_count ?? 0) + 1,
      ...(st ? {} : { primo_avviso_at: new Date(now).toISOString() }),
    }, { onConflict: "order_id" });
  }

  return new Response(JSON.stringify({ ok: true, subs: subs.length, nuovi, urgenti }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
