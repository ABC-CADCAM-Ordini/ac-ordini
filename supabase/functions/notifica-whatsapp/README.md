# notifica-whatsapp — invio automatico messaggi di stato ordine (Fase 1 respond.io)

Edge Function Supabase che, a **ordine ricevuto** e a **ogni cambio di stato**, invia al
cliente il template WhatsApp giusto — **solo se ha dato il consenso** (`orders.consenso_whatsapp = true`)
— con nome, codice ordine e (per in lavorazione / pronto) il **token del suo pannello** dentro il link.

Reagisce a:
| Evento su `orders` | Template | Variabili |
|---|---|---|
| INSERT, status = `ricevuto` | `ac_ordine_ricevuto` | nome, codice |
| UPDATE, status → `in_lavorazione` | `ac_ordine_in_lavorazione` | nome, codice, token pannello |
| UPDATE, status → `concluso` | `ac_ordine_pronto` | nome, codice, token pannello |

## ⛔ Prerequisiti (senza questi NON si attiva)
1. **I 3 template devono essere APPROVATI da Meta** (stato "Approvato" in respond.io → WhatsApp → Modelli). Un template non approvato non è inviabile.
2. **Token Developer API di respond.io** — lo generi tu in respond.io → Impostazioni → Integrazioni → Developer API. È un segreto: non va nel codice né nel repo, va nei secret di Supabase.

## Attivazione (quando i prerequisiti ci sono)
1. **Secret** (dal progetto, con Supabase CLI):
   ```
   supabase secrets set RESPOND_IO_TOKEN=<il-token-respond.io>
   supabase secrets set RESPOND_IO_CHANNEL_ID=446581
   supabase secrets set WEBHOOK_SECRET=<una-stringa-lunga-a-caso>
   ```
   (`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` ci sono già in automatico.)
2. **Deploy della funzione:**
   ```
   supabase functions deploy notifica-whatsapp --no-verify-jwt
   ```
   (`--no-verify-jwt`: la chiama il Database Webhook, non un utente loggato; la sicurezza è l'header `x-webhook-secret`.)
3. **Database Webhook** (Supabase Dashboard → Database → Webhooks → Create):
   - Tabella `orders`, eventi **INSERT** e **UPDATE**
   - Tipo **HTTP Request → POST** all'URL della funzione:
     `https://gnqnebjuhnxvndrpcdtt.functions.supabase.co/notifica-whatsapp`
   - Header extra: `x-webhook-secret: <la-stessa-stringa-di-sopra>`

## ⚠️ Da verificare prima del deploy vero
La forma esatta del body di invio template di respond.io. Prendila da respond.io →
Modelli → (⋮) **«Copia API Payload»** su un template approvato e allinea `sendTemplate()`
in `index.ts` se differisce (struttura `message.template.components[].parameters`).

## Test end-to-end (dopo il deploy)
Crea un ordine di prova col consenso spuntato e un tuo numero → deve arrivare il messaggio
"ricevuto". Poi spostalo su "in lavorazione" nell'Admin → deve arrivare il messaggio col link
al pannello. I log della funzione (Dashboard → Edge Functions → Logs) mostrano gli "skip"
(nessun consenso / nessuna transizione) e gli errori.

## Note
- Se il cliente risponde al messaggio, si apre da sola una conversazione nella inbox respond.io (comportamento nativo).
- Il token del pannello esiste sempre grazie al trigger `provisiona_pannello_cliente` (sql/pannello-auto.sql).
- La funzione risponde sempre 200 (anche in errore) per non far ritentare all'infinito il webhook; gli errori restano nei log.
