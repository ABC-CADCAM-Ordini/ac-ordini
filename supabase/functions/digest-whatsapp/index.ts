// ─────────────────────────────────────────────────────────────
// Fase 1 respond.io — DIGEST: riassunto orario dei cambi di stato ordine
// ─────────────────────────────────────────────────────────────
// Invocata da un cron orario (pg_cron → pg_net, vedi sql/notifica-digest.sql).
// Raggruppa per cliente gli ordini con notifica_pending=true e manda UN solo
// messaggio "hai aggiornamenti, controlla il pannello" a testa (se consenso),
// poi azzera i flag. Anche se un cliente ha 5 ordini cambiati → 1 messaggio.
//
// SECRET (già impostati): RESPOND_IO_TOKEN, RESPOND_IO_CHANNEL_ID, WEBHOOK_SECRET.
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sono automatici.)
//
// ⚠️ DA VERIFICARE al deploy: (a) forma esatta del body respond.io («Copia API Payload»
//    su un template approvato); (b) la query PostgREST di join se il client la rifiuta.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESPOND_TOKEN = Deno.env.get("RESPOND_IO_TOKEN")!;
const CHANNEL_ID = Number(Deno.env.get("RESPOND_IO_CHANNEL_ID") ?? "446581");
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TEMPLATE = "ac_aggiornamento_ordini"; // {{1}}=nome, {{2}}=token pannello
const db = createClient(SUPABASE_URL, SERVICE_KEY);

function toE164(raw: string): string | null {
  let s = (raw || "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  s = s.replace(/^00/, "");
  if (s.startsWith("39")) return "+" + s;
  return "+39" + s;
}

async function sendDigest(phone: string, nome: string, token: string) {
  const url = `https://api.respond.io/v2/contact/phone:${encodeURIComponent(phone)}/message`;
  const body = {
    channelId: CHANNEL_ID,
    message: {
      type: "whatsapp_template",
      template: {
        name: TEMPLATE,
        languageCode: "it",
        components: [
          { type: "body", parameters: [
            { type: "text", text: nome },
            { type: "text", text: token },
          ] },
        ],
      },
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESPOND_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`respond.io ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  // 1) Ordini in attesa di notifica
  const { data: pending, error: e1 } = await db
    .from("orders")
    .select("id, nome, azienda, telefono, consenso_whatsapp")
    .eq("notifica_pending", true);
  if (e1) { console.error("orders:", e1.message); return new Response("db error", { status: 500 }); }
  const orders = pending ?? [];
  if (!orders.length) return new Response(JSON.stringify({ ok: true, inviati: 0 }), { status: 200 });

  // 2) Mappa order_id → cliente (collaboratore) + token pannello
  const ids = orders.map((o: any) => o.id);
  const { data: links, error: e2 } = await db
    .from("ordini_condivisi")
    .select("order_id, collaboratori!inner(id, token, tipo, attivo)")
    .in("order_id", ids)
    .eq("collaboratori.tipo", "cliente")
    .eq("collaboratori.attivo", true);
  if (e2) { console.error("links:", e2.message); return new Response("db error", { status: 500 }); }
  const byOrder = new Map<string, { collabId: string; token: string }>();
  for (const l of (links ?? []) as any[]) {
    const c = Array.isArray(l.collaboratori) ? l.collaboratori[0] : l.collaboratori;
    if (c) byOrder.set(l.order_id, { collabId: c.id, token: c.token });
  }

  // 3) Raggruppa per cliente
  type G = { token: string; nome: string; phone: string | null; consenso: boolean; ids: string[] };
  const groups = new Map<string, G>();
  const processed: string[] = [];
  for (const o of orders as any[]) {
    processed.push(o.id);
    const link = byOrder.get(o.id);
    if (!link) continue; // nessun pannello collegato → salta (ma il flag si azzera comunque)
    const g = groups.get(link.collabId) ?? { token: link.token, nome: "", phone: null, consenso: false, ids: [] };
    g.ids.push(o.id);
    if (o.consenso_whatsapp === true) {
      g.consenso = true;
      if (!g.phone) g.phone = toE164(o.telefono || "");
      if (!g.nome) g.nome = ((o.nome || "").toString().trim()) || ((o.azienda || "").toString().trim());
    }
    groups.set(link.collabId, g);
  }

  // 4) Un messaggio per cliente con consenso + telefono
  let inviati = 0;
  for (const g of groups.values()) {
    if (g.consenso && g.phone) {
      try { await sendDigest(g.phone, g.nome || "Cliente", g.token); inviati++; }
      catch (e) { console.error("send:", e); }
    }
  }

  // 5) Azzera i flag di TUTTI gli ordini considerati (inviati o meno) → niente arretrato infinito
  if (processed.length) {
    await db.from("orders").update({ notifica_pending: false }).in("id", processed);
  }

  return new Response(JSON.stringify({ ok: true, clienti: groups.size, inviati }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
