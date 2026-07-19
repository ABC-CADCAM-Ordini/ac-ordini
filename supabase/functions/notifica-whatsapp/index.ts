// ─────────────────────────────────────────────────────────────
// Fase 1 respond.io — Invio automatico dei messaggi di stato ordine via WhatsApp
// ─────────────────────────────────────────────────────────────
// Trigger: Database Webhook di Supabase su `orders` (INSERT + UPDATE) → questa funzione.
// Manda il template WhatsApp giusto al numero del cliente SOLO se consenso_whatsapp = true.
//
//   ordine creato (status=ricevuto)     → ac_ordine_ricevuto        (2 var: nome, codice)
//   status → in_lavorazione             → ac_ordine_in_lavorazione  (3 var: nome, codice, TOKEN pannello)
//   status → concluso                   → ac_ordine_pronto          (3 var: nome, codice, TOKEN pannello)
//
// SECRET da impostare (supabase secrets set ...):
//   RESPOND_IO_TOKEN       — Developer API token di respond.io (Impostazioni → Integrazioni). NON committarlo.
//   RESPOND_IO_CHANNEL_ID  — 446581 (canale WhatsApp Business)
//   WEBHOOK_SECRET         — stringa condivisa col Database Webhook (header x-webhook-secret)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — forniti in automatico nelle Edge Functions
//
// ⚠️ DA VERIFICARE PRIMA DEL DEPLOY: la forma esatta del body di invio template di respond.io.
//    Prendila da respond.io → canale WhatsApp → Modelli → (⋮) «Copia API Payload» su un template
//    APPROVATO e allinea sendTemplate() se differisce dalla struttura qui sotto.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESPOND_TOKEN = Deno.env.get("RESPOND_IO_TOKEN")!;
const CHANNEL_ID = Number(Deno.env.get("RESPOND_IO_CHANNEL_ID") ?? "446581");
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// stato ordine → template + se serve il token del pannello (link nel testo)
const TEMPLATES: Record<string, { name: string; withPanel: boolean }> = {
  ricevuto:       { name: "ac_ordine_ricevuto",       withPanel: false },
  in_lavorazione: { name: "ac_ordine_in_lavorazione", withPanel: true },
  concluso:       { name: "ac_ordine_pronto",         withPanel: true },
};

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// Telefono IT → E.164 (+39...). Difensivo: tiene il + se già presente.
function toE164(raw: string): string | null {
  let s = (raw || "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  s = s.replace(/^00/, "");
  if (s.startsWith("39")) return "+" + s;
  return "+39" + s; // numero IT senza prefisso
}

// Codice ordine come lo vede il cliente (allinea a orderCode() dell'Admin se cambia).
// deno-lint-ignore no-explicit-any
function orderCode(o: any): string {
  const na = o?.scheda_dati?.id_na;
  if (na) return String(na);
  return (o?.share_token || o?.id || "").toString().replace(/-/g, "").slice(0, 8).toUpperCase();
}

// Token del pannello (collaboratori.token) del cliente collegato all'ordine.
async function panelToken(orderId: string): Promise<string | null> {
  const { data, error } = await db
    .from("ordini_condivisi")
    .select("collaboratori!inner(token,tipo,attivo)")
    .eq("order_id", orderId)
    .eq("collaboratori.tipo", "cliente")
    .eq("collaboratori.attivo", true)
    .limit(1)
    .maybeSingle();
  if (error) { console.error("panelToken:", error.message); return null; }
  // deno-lint-ignore no-explicit-any
  return (data as any)?.collaboratori?.token ?? null;
}

// Invia un template WhatsApp via respond.io al numero indicato.
// ⚠️ Verifica il body con «Copia API Payload».
async function sendTemplate(phone: string, template: string, params: string[]) {
  const url = `https://api.respond.io/v2/contact/phone:${encodeURIComponent(phone)}/message`;
  const body = {
    channelId: CHANNEL_ID,
    message: {
      type: "whatsapp_template",
      template: {
        name: template,
        languageCode: "it",
        components: [
          { type: "body", parameters: params.map((t) => ({ type: "text", text: t })) },
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
  // Sicurezza: accetta solo il Database Webhook col secret condiviso.
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const evt = await req.json();
    const o = evt.record;
    const old = evt.old_record;
    if (!o) return new Response("no record", { status: 200 });

    // 1) È una transizione da notificare?
    let statoKey: string | null = null;
    if (evt.type === "INSERT" && o.status === "ricevuto") {
      statoKey = "ricevuto";
    } else if (evt.type === "UPDATE" && old?.status !== o.status &&
               (o.status === "in_lavorazione" || o.status === "concluso")) {
      statoKey = o.status;
    }
    if (!statoKey) return new Response("skip: nessuna transizione", { status: 200 });

    // 2) Consenso + telefono
    if (o.consenso_whatsapp !== true) return new Response("skip: nessun consenso", { status: 200 });
    const phone = toE164(o.telefono || "");
    if (!phone) return new Response("skip: telefono mancante", { status: 200 });

    // 3) Parametri: nome, codice (+ token pannello per gli stati con link)
    const tpl = TEMPLATES[statoKey];
    const nome = ((o.nome || "").toString().trim()) || ((o.azienda || "").toString().trim()) || "Cliente";
    const params = [nome, orderCode(o)];
    if (tpl.withPanel) {
      const token = await panelToken(o.id);
      if (!token) return new Response("skip: token pannello non trovato", { status: 200 });
      params.push(token);
    }

    await sendTemplate(phone, tpl.name, params);
    return new Response(JSON.stringify({ ok: true, template: tpl.name }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("notifica-whatsapp:", e);
    // 200 anche in errore: non vogliamo che il webhook ritenti all'infinito. L'errore resta nei log.
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
});
