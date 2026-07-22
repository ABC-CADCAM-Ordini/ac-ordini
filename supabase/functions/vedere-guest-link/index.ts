// ─────────────────────────────────────────────────────────────
// VEDERE-GUEST-LINK — firma un link "ospite" per aprire l'STL di un ordine
// nel viewer Vedere di Synthesis-ICP senza login (sola visualizzazione).
// ─────────────────────────────────────────────────────────────
// Perché una Edge Function: l'Admin di ac-ordini è HTML pubblico (GitHub Pages)
// e NON può tenere il segreto di firma. Qui sì. Gated allo STAFF (operatore/
// responsabile/admin): verifica il JWT del chiamante (stesso schema di
// gestione-operatori / notifica-test).
//
// Il segreto GUEST_LINK_SECRET è CONDIVISO con Synthesis-ICP (env dei servizi
// Railway backend + legacy), che verifica la firma lato server. NON è JWT_SECRET.
//
// SICUREZZA (da review avversariale):
//  • Il client passa SOLO share_token (+ order_code opzionale): l'URL dello STL
//    lo costruisce QUI, con l'host pinnato da SUPABASE_URL → niente open-signer/SSRF.
//  • Nessuna PII nel token: label = codice ordine o "Modello 3D", MAI il nome file.
//  • Payload firmato ATOMICO (blob b64url, firma sui suoi byte) → niente confusione
//    di canonicalizzazione. Formato token: "<p>.<sig>" dove p=b64url(JSON), sig=b64url(HMAC).
//  • Il token va messo nel FRAGMENT del link (#g=...) lato client, non in query.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GUEST_LINK_SECRET = Deno.env.get("GUEST_LINK_SECRET") ?? "";
const VEDERE_BASE = "https://app.synthesis-icp.com/vedere";
const STL_BUCKET = "ordini-stl";
const TTL_SECONDS = 7 * 24 * 60 * 60;   // 7 giorni (scelta utente)

// Guardia fail-closed sul segreto (da review): mai firmare con chiave assente/debole.
function secretOk(): boolean {
  return !!GUEST_LINK_SECRET && GUEST_LINK_SECRET.length >= 32 && GUEST_LINK_SECRET !== SERVICE_KEY;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ── base64url + HMAC-SHA256 (WebCrypto). Firma i BYTE ASCII di p (stringa b64url),
// gli stessi che Synthesis verifica con hmac.new(secret, p, sha256). ──────────
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string { return b64url(new TextEncoder().encode(s)); }
async function hmacB64url(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}

function randHex(nBytes: number): string {
  const u = new Uint8Array(nBytes);
  crypto.getRandomValues(u);
  return Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "metodo non consentito" }, 405);
  if (!secretOk()) return json({ error: "servizio non configurato (segreto mancante)" }, 503);

  // 1) Autentica il chiamante: STAFF (operatore/responsabile/admin) attivo
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "non autenticato" }, 401);
  const { data: { user }, error: uerr } = await db.auth.getUser(token);
  if (uerr || !user) return json({ error: "sessione non valida" }, 401);
  const { data: me } = await db.from("profiles").select("ruolo, attivo").eq("id", user.id).single();
  if (!me || me.attivo === false || !["operatore", "responsabile", "admin"].includes(me.ruolo)) {
    return json({ error: "azione riservata allo staff" }, 403);
  }

  // 2) Input: SOLO share_token (+ order_code opzionale). Niente url/file_name dal client.
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "richiesta non valida" }, 400); }
  const shareToken = String(body?.share_token ?? "").trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(shareToken)) return json({ error: "share_token non valido" }, 400);
  const orderCode = String(body?.order_code ?? "").trim().slice(0, 40);
  const label = orderCode || "Modello 3D";   // etichetta OPACA, mai il nome file paziente

  // 3) URL STL costruito QUI (host pinnato) → niente URL ostile dal client
  const url = `${SUPABASE_URL}/storage/v1/object/public/${STL_BUCKET}/${encodeURIComponent(shareToken)}.stl`;

  // 4) Payload firmato atomico
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    v: "1", iss: "ac-ordini", aud: "synthesis-vedere", scope: "vedere",
    url, label, iat, exp: iat + TTL_SECONDS, jti: randHex(16),
  };
  const p = b64urlStr(JSON.stringify(payload));
  const sig = await hmacB64url(GUEST_LINK_SECRET, p);
  const guestToken = `${p}.${sig}`;

  // 5) Token nel FRAGMENT (#g=): non finisce nei log/Referer del server
  return json({ guest_url: `${VEDERE_BASE}#g=${guestToken}`, exp: payload.exp });
});
