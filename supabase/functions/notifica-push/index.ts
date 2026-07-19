// ─────────────────────────────────────────────────────────────
// AVVISI URGENTI — motore di escalation via Web Push (PWA operatori)
// ─────────────────────────────────────────────────────────────
// BOZZA — NON ATTIVA. Si accende in Fase B (deploy + cron in sql/push-urgenti.sql).
//
// Invocata da un cron ogni 5 min (pg_cron → pg_net). Ad ogni giro:
//   1. trova gli ordini URGENTE/EXPRESS ancora 'ricevuto' (= non mandati in produzione);
//   2. per ciascuno, in base a da quanto è fermo, decide se avvisare di nuovo e chi:
//        • livello 1 (subito, poi ogni REMINDER_MIN): tutti gli operatori del carico;
//        • livello 2 (dopo ESCALATE_MIN ancora fermo): anche il RESPONSABILE (ruolo admin/responsabile);
//   3. manda la push persistente e aggiorna il pacing in `urgenti_notifiche`.
// Si ferma DA SOLO: appena l'ordine passa a 'in_lavorazione' non rientra più nella query.
// "Preso in carico" (Fase B, dall'Admin) silenzia i solleciti per SILENCE_MIN senza produzione.
//
// SECRET da impostare al deploy:
//   WEBHOOK_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (es. mailto:ordini@…)
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sono automatici.)
//
// ⚠️ DA VERIFICARE al deploy: import/formato chiavi VAPID nella libreria push
//    (qui convertite dal formato base64url standard) e gestione 404/410 (subscription scadute).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.3";

// ── Config ────────────────────────────────────────────────────
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ordini@abutmentcompatibili.com";

const REMINDER_MIN = Number(Deno.env.get("REMINDER_MIN") ?? "10");   // ogni quanto ripetere il sollecito
const ESCALATE_MIN = Number(Deno.env.get("ESCALATE_MIN") ?? "30");   // dopo quanto coinvolgere il responsabile
const SILENCE_MIN = Number(Deno.env.get("SILENCE_MIN") ?? "15");     // durata del "preso in carico"
const ADMIN_URL = "https://abc-cadcam-ordini.github.io/ac-ordini/Admin_Ordini_v2.html";

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const RUOLI_RESPONSABILE = ["admin", "responsabile"];

// ── Finestra operativa: lun-ven, 8:00–17:00 (fuso Roma), esclusi i festivi nazionali ──
const TZ = "Europe/Rome";
const WORK_START = Number(Deno.env.get("WORK_START_HOUR") ?? "8");  // ora inclusa
const WORK_END = Number(Deno.env.get("WORK_END_HOUR") ?? "17");    // ora esclusa (alle 17:00 stop)

// Ora/giorno LOCALI a Roma (gestisce da sé CET/CEST); wd: 1=lun … 7=dom.
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

// Domenica di Pasqua (algoritmo di Meeus/Butcher, calendario gregoriano).
function pasqua(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mth = Math.floor((a + 11 * h + 22 * l) / 451);
  return { m: Math.floor((h + l - 7 * mth + 114) / 31), d: ((h + l - 7 * mth + 114) % 31) + 1 };
}

// Festivi nazionali italiani (i "giorni rossi"): fissi + Pasqua e Lunedì dell'Angelo.
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
  if (t.wd < 1 || t.wd > 5) return false;              // solo lun-ven
  if (t.hour < WORK_START || t.hour >= WORK_END) return false; // 8:00–17:00
  return !isFestivo(t.y, t.m, t.day);                   // niente giorni rossi
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

// ── Etichetta breve dell'ordine per la notifica ───────────────
function labelOrdine(o: any): string {
  const cliente = ((o.nome || "").trim()) || ((o.azienda || "").trim()) || "Cliente";
  return cliente;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  // Niente avvisi fuori orario di lavoro o nei giorni rossi: gli operatori non ci sono.
  // Gli ordini restano 'ricevuto' e ripartono al primo tick utile (es. lunedì alle 8:00).
  if (!inFinestraOperativa(new Date())) {
    return new Response(JSON.stringify({ ok: true, skipped: "fuori finestra operativa" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  const now = Date.now();

  // 1) Ordini urgenti/express ancora 'ricevuto' (= non mandati in produzione)
  const { data: urgenti, error: e1 } = await db
    .from("orders")
    .select("id, nome, azienda, urgenza, created_at")
    .in("urgenza", ["urgente", "express"])
    .eq("status", "ricevuto");
  if (e1) { console.error("orders:", e1.message); return new Response("db error", { status: 500 }); }
  if (!urgenti?.length) return new Response(JSON.stringify({ ok: true, urgenti: 0 }), { status: 200 });

  // 2) Iscrizioni push attive + ruolo del proprietario
  const { data: subs, error: e2 } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, profile_id, profiles!inner(ruolo, attivo)")
    .eq("attivo", true)
    .eq("profiles.attivo", true);
  if (e2) { console.error("subs:", e2.message); return new Response("db error", { status: 500 }); }
  const allSubs = (subs ?? []) as any[];
  if (!allSubs.length) return new Response(JSON.stringify({ ok: true, urgenti: urgenti.length, subs: 0 }), { status: 200 });

  const isResponsabile = (s: any) => {
    const p = Array.isArray(s.profiles) ? s.profiles[0] : s.profiles;
    return p && RUOLI_RESPONSABILE.includes(p.ruolo);
  };
  const subOperatori = allSubs;                              // livello 1: tutti
  const subResponsabile = allSubs.filter(isResponsabile);   // livello 2

  // 3) Stato pacing per gli ordini in gioco
  const ids = urgenti.map((o: any) => o.id);
  const { data: statiRaw } = await db.from("urgenti_notifiche").select("*").in("order_id", ids);
  const stato = new Map<string, any>();
  for (const s of (statiRaw ?? []) as any[]) stato.set(s.order_id, s);

  const appServer = await buildAppServer();

  async function inviaA(targets: any[], payload: any) {
    await Promise.all(targets.map(async (s) => {
      try {
        const subscriber = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
        await subscriber.pushTextMessage(JSON.stringify(payload), {});
      } catch (err: any) {
        const code = err?.response?.status ?? err?.status;
        if (code === 404 || code === 410) {
          // Subscription scaduta/rimossa dal browser → disattivala per non riprovarci all'infinito.
          await db.from("push_subscriptions").update({ attivo: false }).eq("id", s.id);
        } else {
          console.error("push send:", s.endpoint, err?.message ?? err);
        }
      }
    }));
  }

  let inviati = 0, escalati = 0;
  for (const o of urgenti as any[]) {
    const st = stato.get(o.id);

    // "Preso in carico": silenzia i solleciti per SILENCE_MIN (senza mandare in produzione)
    if (st?.preso_in_carico_at) {
      const silDa = now - new Date(st.preso_in_carico_at).getTime();
      if (silDa < SILENCE_MIN * 60_000) continue;
    }

    // Pacing: manda se è la prima volta o se è passato REMINDER_MIN dall'ultimo avviso
    const ultimo = st?.ultimo_avviso_at ? new Date(st.ultimo_avviso_at).getTime() : 0;
    if (ultimo && now - ultimo < REMINDER_MIN * 60_000) continue;

    // Escalation misurata dal PRIMO avviso effettivo (non dalla creazione): così un ordine
    // arrivato fuori orario non fa scattare l'escalation al responsabile al primo tick utile.
    const primoAvviso = st?.primo_avviso_at ? new Date(st.primo_avviso_at).getTime() : now;
    const ageMin = (now - primoAvviso) / 60_000;
    const escalation = ageMin >= ESCALATE_MIN;
    const label = labelOrdine(o);
    const urg = o.urgenza === "urgente" ? "URGENTE" : "EXPRESS";

    const payload = {
      title: escalation ? `⏰ ${urg} fermo da ${Math.round(ageMin)} min` : `🔴 Ordine ${urg}`,
      body: escalation
        ? `${label}: ancora da mandare in produzione. Serve intervento.`
        : `${label}: da mandare in produzione.`,
      tag: `urgente-${o.id}`,
      url: `${ADMIN_URL}#${o.id}`,
      orderId: o.id,
    };

    // Livello 1 sempre; al livello 2 aggiungi il responsabile (dedup per endpoint)
    let targets = subOperatori;
    if (escalation) {
      const seen = new Set(subOperatori.map((s) => s.endpoint));
      targets = subOperatori.concat(subResponsabile.filter((s) => !seen.has(s.endpoint)));
      escalati++;
    }
    await inviaA(targets, payload);
    inviati++;

    // Aggiorna il pacing
    const patch = {
      order_id: o.id,
      ultimo_avviso_at: new Date(now).toISOString(),
      avvisi_count: (st?.avvisi_count ?? 0) + 1,
      escalato: (st?.escalato ?? false) || escalation,
      ...(st ? {} : { primo_avviso_at: new Date(now).toISOString() }),
    };
    await db.from("urgenti_notifiche").upsert(patch, { onConflict: "order_id" });
  }

  return new Response(JSON.stringify({ ok: true, urgenti: urgenti.length, inviati, escalati }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
