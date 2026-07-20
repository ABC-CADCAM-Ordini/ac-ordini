-- ══════════════════════════════════════════════════════════════
-- AVVISI OPERATORI VIA WHATSAPP — gestiti dal pannello "Gestione Operatori"
-- ══════════════════════════════════════════════════════════════
-- Prima i destinatari WhatsApp erano un elenco fisso nel secret OPERATORI_WHATSAPP.
-- Ora ogni operatore ha un interruttore "Riceve avvisi WhatsApp" nel proprio profilo,
-- gestibile dall'Admin (Gestione Operatori → Modifica). La Edge Function notifica-push
-- legge i numeri da qui (uniti a quelli eventualmente ancora nel secret, per non
-- perdere nessuno durante la transizione).

alter table public.profiles
  add column if not exists avvisi_whatsapp boolean not null default false;

comment on column public.profiles.avvisi_whatsapp is
  'Se true, l''operatore riceve su WhatsApp (campo telefono) gli avvisi di nuovo ordine non assegnato e di urgente/express in attesa. Gestito da Admin → Gestione Operatori.';
