// ─────────────────────────────────────────────────────────────
// Notifiche CLIENTI per stadio ordine (preso in carico / in produzione / prodotto)
// ─────────────────────────────────────────────────────────────
// Invocata da un cron ORARIO (pg_cron → pg_net, vedi sql/notifiche-per-stadio.sql).
// Per ogni ordine con notifica_stadio non nullo, manda IL messaggio di quello stadio
// (specifico per quell'ordine, con codice + link al pannello) — SOLO se il cliente ha
// dato consenso_whatsapp, ha un telefono e ha un pannello collegato. Poi azzera lo stadio,
// indipendentemente dall'esito dell'invio (niente arretrato infinito).
//
// SECRET (già impostati): RESPOND_IO_TOKEN, RESPOND_IO_CHANNEL_ID, WEBHOOK_SECRET.
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sono automatici.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESPOND_TOKEN = Deno.env.get("RESPOND_IO_TOKEN")!;
const CHANNEL_ID = Number(Deno.env.get("RESPOND_IO_CHANNEL_ID") ?? "446581");
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTALE_URL = "https://abc-cadcam-ordini.github.io/ac-ordini/portale.html";

// stadio ordine → nome del template WhatsApp approvato (Utility, it; {{1}}=nome, {{2}}=codice, {{3}}=link)
const TEMPLATE: Record<string, string> = {
  preso_in_carico: "ac_preso_in_carico",
  in_produzione: "ac_in_produzione",
  prodotto: "ac_prodotto_tracking",
};

const db = createClient(SUPABASE_URL, SERVICE_KEY);

function toE164(raw: string): string | null {
  let s = (raw || "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  s = s.replace(/^00/, "");
  if (s.startsWith("39")) return "+" + s;
  return "+39" + s;
}
function codiceOrdine(id: string): string {
  return id ? id.substring(0, 8).toUpperCase() : "—";
}

async function sendStage(phone: string, nome: string, codice: string, link: string, template: string) {
  const url = `https://api.respond.io/v2/contact/phone:${encodeURIComponent(phone)}/message`;
  const body = {
    channelId: CHANNEL_ID,
    message: {
      type: "whatsapp_template",
      template: {
        name: template,
        languageCode: "it",
        components: [
          { type: "body", parameters: [
            { type: "text", text: nome },
            { type: "text", text: codice },
            { type: "text", text: link },
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

  // 1) Ordini con uno stadio da notificare
  const { data: pending, error: e1 } = await db
    .from("orders")
    .select("id, nome, azienda, telefono, consenso_whatsapp, notifica_stadio")
    .not("notifica_stadio", "is", null);
  if (e1) { console.error("orders:", e1.message); return new Response("db error", { status: 500 }); }
  const orders = pending ?? [];
  if (!orders.length) return new Response(JSON.stringify({ ok: true, inviati: 0 }), { status: 200 });

  // 2) Token pannello per ordine (join ordini_condivisi → collaboratori tipo 'cliente')
  const ids = orders.map((o: any) => o.id);
  const { data: links, error: e2 } = await db
    .from("ordini_condivisi")
    .select("order_id, collaboratori!inner(id, token, tipo, attivo)")
    .in("order_id", ids)
    .eq("collaboratori.tipo", "cliente")
    .eq("collaboratori.attivo", true);
  if (e2) { console.error("links:", e2.message); return new Response("db error", { status: 500 }); }
  const tokenByOrder = new Map<string, string>();
  for (const l of (links ?? []) as any[]) {
    const c = Array.isArray(l.collaboratori) ? l.collaboratori[0] : l.collaboratori;
    if (c) tokenByOrder.set(l.order_id, c.token);
  }

  // 3) Un messaggio PER ORDINE (non raggruppato): stadio specifico, codice, link pannello
  let inviati = 0;
  const processed: string[] = [];
  for (const o of orders as any[]) {
    processed.push(o.id);
    const template = TEMPLATE[(o.notifica_stadio || "") as string];
    const token = tokenByOrder.get(o.id);
    const phone = o.consenso_whatsapp === true ? toE164(o.telefono || "") : null;
    if (template && token && phone) {
      const nome = ((o.nome || "").toString().trim()) || ((o.azienda || "").toString().trim()) || "Cliente";
      const link = `${PORTALE_URL}?c=${token}`;
      try { await sendStage(phone, nome, codiceOrdine(o.id), link, template); inviati++; }
      catch (e) { console.error("send:", e); }
    }
  }

  // 4) Azzera lo stadio di TUTTI gli ordini considerati (inviati o meno) → niente arretrato infinito
  if (processed.length) {
    await db.from("orders").update({ notifica_stadio: null }).in("id", processed);
  }

  return new Response(JSON.stringify({ ok: true, ordini: orders.length, inviati }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
