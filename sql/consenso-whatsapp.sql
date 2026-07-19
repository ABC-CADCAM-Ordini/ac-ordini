-- ─────────────────────────────────────────────────────────────
-- Fase 1 respond.io — Consenso WhatsApp per le notifiche di stato ordine
-- ─────────────────────────────────────────────────────────────
-- Additivo e reversibile: aggiunge due colonne a `orders`, non tocca nessun dato.
-- Perché una colonna e non scheda_dati: il consenso è un dato legale (GDPR/MDR) e
-- non deve poter essere sovrascritto da una sync NA che rimpiazza scheda_dati.
--
-- ⚠️ ORDINE: girare QUESTO file PRIMA di deployare il Configuratore che scrive
--    queste colonne. Se il codice scrive una colonna inesistente, l'INSERT dell'ordine
--    fallisce (403/400 da PostgREST) e il cliente non riesce a inviare l'ordine.

alter table public.orders
  add column if not exists consenso_whatsapp boolean not null default false;

alter table public.orders
  add column if not exists consenso_whatsapp_ts timestamptz;

comment on column public.orders.consenso_whatsapp is
  'Il cliente ha spuntato nel configuratore il consenso a ricevere aggiornamenti di stato via WhatsApp.';
comment on column public.orders.consenso_whatsapp_ts is
  'Momento in cui è stato prestato il consenso WhatsApp (ISO). Null se non prestato.';

-- Nota RLS: le policy di `orders` sono a livello di riga, non di colonna; il GRANT INSERT
-- è a livello tabella, quindi le nuove colonne sono già coperte per il ruolo anon del
-- configuratore. Verifica comunque creando un ordine di prova dopo la migrazione.
