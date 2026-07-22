// ─────────────────────────────────────────────────────────────
// NOTIFICA DI PROVA — invio manuale di una Web Push di test dal pannello Admin
// ─────────────────────────────────────────────────────────────
// Serve a verificare "dal vivo" che le push arrivino sull'app installata sul telefono,
// senza aspettare il cron o un ordine reale. Premi il pulsante nell'Admin → parte subito.
//
// Blindata agli ADMIN: verifica il JWT del chiamante e il suo ruolo (stesso schema di
// `gestione-operatori`). Manda la push di prova a TUTTE le iscrizioni attive in
// `push_subscriptions` (operatori + admin che hanno premuto "Attiva avvisi").
// Indipendente da `notifica-push`: non tocca cron, finestra oraria, stato ordini.
//
// SECRET usati: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (già impostati per
// notifica-push, condivisi a livello di progetto). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// automatici. Nessun WEBHOOK_SECRET: qui l'autorizzazione è il JWT admin del pannello.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ordini@abutmentcompatibili.com";
const PORTALE_URL = "https://abc-cadcam-ordini.github.io/ac-ordini/portale.html";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Client service-role: bypassa la RLS. Da usare SOLO dopo aver verificato che il chiamante è admin.
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "metodo non consentito" }, 405);

  // 1) Autentica il chiamante e pretendi ruolo = admin
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "non autenticato" }, 401);
  const { data: { user }, error: uerr } = await db.auth.getUser(token);
  if (uerr || !user) return json({ error: "sessione non valida" }, 401);
  const { data: me } = await db.from("profiles").select("ruolo, attivo").eq("id", user.id).single();
  if (!me || me.attivo === false || me.ruolo !== "admin") {
    return json({ error: "azione riservata agli amministratori" }, 403);
  }

  // 2) Tutte le iscrizioni push attive (operatori via portale + admin dal pannello)
  const { data: subsRaw, error: eS } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("attivo", true);
  if (eS) return json({ error: "db: " + eS.message }, 500);
  const subs = (subsRaw ?? []) as any[];
  if (!subs.length) return json({ ok: true, subs: 0, sent: 0, failed: 0 });

  // 3) Invia la push di prova a tutti. Il service worker (sw.js) la mostra persistente + vibrazione.
  const appServer = await buildAppServer();
  const payload = JSON.stringify({
    title: "🔔 Notifica di prova",
    body: "Test avvisi operatori — se vedi questo, le notifiche funzionano.",
    tag: "test-notifica",
    url: PORTALE_URL,
  });
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const subscriber = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
      await subscriber.pushTextMessage(payload, {});
      sent++;
    } catch (err: any) {
      failed++;
      const code = err?.response?.status ?? err?.status;
      if (code === 404 || code === 410) {
        await db.from("push_subscriptions").update({ attivo: false }).eq("id", s.id); // iscrizione scaduta
      } else {
        console.error("push test send:", err?.message ?? err);
      }
    }
  }));

  return json({ ok: true, subs: subs.length, sent, failed });
});
