// ─────────────────────────────────────────────────────────────
// GESTIONE OPERATORI — crea / cambia ruolo / elimina account, dal pannello Admin
// ─────────────────────────────────────────────────────────────
// Perché un Edge Function: creare/eliminare un login richiede la SERVICE_ROLE key
// (scavalca la RLS). Non può stare nell'HTML pubblico → sta qui, al sicuro.
// Ogni azione è riservata agli ADMIN: si verifica il JWT del chiamante e il suo ruolo.
//
// Chiamata dal browser (Admin_Ordini_v2.html) con l'access_token dell'operatore loggato,
// stesso schema di `forza-sync`. Azioni: create | setRole | delete.
//
// Nessun secret extra: usa SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (automatici).
// verify_jwt può restare ON (il browser manda un JWT valido).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Client service-role: bypassa la RLS. Da usare SOLO dopo aver verificato che il chiamante è admin.
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const RUOLI = ["operatore", "responsabile", "admin"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "metodo non consentito" }, 405);

  // 1) Autentica il chiamante e pretendi ruolo = admin
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "non autenticato" }, 401);
  const { data: { user }, error: uerr } = await admin.auth.getUser(token);
  if (uerr || !user) return json({ error: "sessione non valida" }, 401);
  const { data: me } = await admin.from("profiles").select("ruolo, attivo").eq("id", user.id).single();
  if (!me || me.attivo === false || me.ruolo !== "admin") {
    return json({ error: "azione riservata agli amministratori" }, 403);
  }

  // 2) Dispatch
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "richiesta non valida" }, 400); }

  // ── Crea un nuovo operatore (login + profilo) ───────────────────────────────
  if (body.action === "create") {
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    const nome = (body.nome || "").trim();
    const ruolo = RUOLI.includes(body.ruolo) ? body.ruolo : "operatore";
    const telefono = (body.telefono || "").trim() || null;
    if (!email || !nome || !password) return json({ error: "nome, email e password sono obbligatori" }, 400);
    if (password.length < 8) return json({ error: "la password deve avere almeno 8 caratteri" }, 400);

    const { data: created, error: cerr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { nome },
    });
    if (cerr || !created?.user) return json({ error: "creazione account: " + (cerr?.message || "sconosciuto") }, 400);
    const id = created.user.id;

    // Upsert del profilo: robusto sia se un trigger l'ha già creato, sia se no.
    const { error: perr } = await admin
      .from("profiles")
      .upsert({ id, nome, ruolo, telefono, email, attivo: true }, { onConflict: "id" });
    if (perr) {
      await admin.auth.admin.deleteUser(id); // niente account orfani senza profilo
      return json({ error: "profilo: " + perr.message }, 400);
    }
    return json({ ok: true, id, email });
  }

  // ── Cambia ruolo (operatore / responsabile / admin) ─────────────────────────
  if (body.action === "setRole") {
    const id = body.id;
    const ruolo = body.ruolo;
    if (!id || !RUOLI.includes(ruolo)) return json({ error: "id o ruolo non validi" }, 400);
    if (id === user.id && ruolo !== "admin") return json({ error: "non puoi rimuovere a te stesso il ruolo admin" }, 400);
    const { error } = await admin.from("profiles").update({ ruolo }).eq("id", id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // ── Elimina davvero l'account (login + profilo) ─────────────────────────────
  if (body.action === "delete") {
    const id = body.id;
    if (!id) return json({ error: "id mancante" }, 400);
    if (id === user.id) return json({ error: "non puoi eliminare te stesso" }, 400);
    const { error: derr } = await admin.auth.admin.deleteUser(id);
    if (derr && !/not\s*found/i.test(derr.message)) return json({ error: derr.message }, 400);
    await admin.from("profiles").delete().eq("id", id); // pulizia (se non c'è ON DELETE CASCADE)
    return json({ ok: true });
  }

  return json({ error: "azione sconosciuta" }, 400);
});
