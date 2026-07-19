-- ══════════════════════════════════════════════════════════════
-- AVVISI URGENTI AGLI OPERATORI — Web Push (PWA) + motore di escalation
-- ══════════════════════════════════════════════════════════════
-- Obiettivo: quando arriva un ordine URGENTE o EXPRESS e resta 'ricevuto'
-- (= non ancora mandato in produzione), martellare gli operatori del carico
-- con notifiche push persistenti; dopo N solleciti salire al RESPONSABILE.
-- Si spegne DA SOLO appena l'ordine passa a 'in_lavorazione'.
--
-- Additivo e reversibile. Da girare all'ACCENSIONE della Fase A.
-- Il cron (in fondo) va attivato solo in Fase B, quando la Edge Function
-- `notifica-push` è deployata e almeno un operatore si è iscritto.
--
-- Ruoli (dalla tabella `profiles`, pannello "Gestione Operatori"):
--   • operatori del carico  → ricevono i solleciti (livello 1)
--   • responsabile          → ruolo 'admin' (o 'responsabile') → escalation (livello 2)

-- ── 1) Iscrizioni push: una riga per (operatore, browser/dispositivo) ─────────
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  endpoint     text not null unique,          -- URL push del browser (identifica il dispositivo)
  p256dh       text not null,                 -- chiave pubblica del client (cifratura payload)
  auth         text not null,                 -- secret di autenticazione del client
  user_agent   text,
  attivo       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_profile_idx on public.push_subscriptions(profile_id);

alter table public.push_subscriptions enable row level security;

-- L'operatore loggato gestisce SOLO le proprie iscrizioni. La Edge Function usa la
-- service-role key e bypassa la RLS per leggerle tutte quando deve inviare.
drop policy if exists "operatore gestisce le proprie push" on public.push_subscriptions;
create policy "operatore gestisce le proprie push" on public.push_subscriptions
  for all to authenticated using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ── 2) Colonna `urgenza` derivata da `note` (blindata da trigger) ─────────────
-- Oggi l'urgenza vive nel testo di `note` come "Urgenza: urgente|express".
-- La estraiamo in una colonna dedicata così il motore filtra in modo netto,
-- con la STESSA logica del client (parseNote → 'express'|'urgente', case-insensitive).
alter table public.orders
  add column if not exists urgenza text;   -- 'urgente' | 'express' | null

create or replace function public.deriva_urgenza()
returns trigger
language plpgsql
as $$
declare
  v text;
begin
  -- (?i) = case-insensitive; cattura il valore dopo "Urgenza:" fino al separatore '|' o a fine stringa
  v := lower(trim(substring(coalesce(new.note, '') from '(?i)Urgenza:\s*([^|]+)')));
  if v in ('urgente', 'express') then
    new.urgenza := v;
  else
    new.urgenza := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_deriva_urgenza on public.orders;
create trigger trg_deriva_urgenza
before insert or update of note on public.orders
for each row execute function public.deriva_urgenza();

-- Backfill degli ordini già esistenti
update public.orders
   set urgenza = lower(trim(substring(coalesce(note, '') from '(?i)Urgenza:\s*([^|]+)')))
 where lower(trim(substring(coalesce(note, '') from '(?i)Urgenza:\s*([^|]+)'))) in ('urgente', 'express');

-- ── 3) Stato dei solleciti per ordine (pacing dell'escalation) ────────────────
-- Il motore ci scrive per sapere quando ha avvisato l'ultima volta e se ha già
-- coinvolto il responsabile. Chiave = order_id, così basta un upsert.
create table if not exists public.urgenti_notifiche (
  order_id           uuid primary key references public.orders(id) on delete cascade,
  primo_avviso_at    timestamptz not null default now(),
  ultimo_avviso_at   timestamptz,
  avvisi_count       int not null default 0,
  escalato           boolean not null default false,   -- responsabile già allertato?
  preso_in_carico_at timestamptz,                       -- silenzia i solleciti (senza produzione)
  preso_in_carico_da uuid references public.profiles(id),
  created_at         timestamptz not null default now()
);

alter table public.urgenti_notifiche enable row level security;
drop policy if exists "operatori gestiscono urgenti_notifiche" on public.urgenti_notifiche;
create policy "operatori gestiscono urgenti_notifiche" on public.urgenti_notifiche
  for all to authenticated using (true) with check (true);

-- ── 4) Cron ogni 5 minuti — ⚠️ ATTIVARE SOLO IN FASE B ────────────────────────
-- Richiede le extension pg_cron e pg_net (Dashboard → Database → Extensions).
-- Il WEBHOOK_SECRET è lo stesso salvato nei secret della Edge Function; NON in chiaro nel repo.
--
-- Il cron gira ogni 5 min SEMPRE: la finestra operativa (lun-ven 8:00-17:00 fuso Roma,
-- esclusi i festivi nazionali) è imposta DAL CODICE della funzione, che fa no-op fuori orario.
-- Non restringere qui gli orari: pg_cron gira in UTC e sballerebbe col cambio d'ora.
--
--   select cron.schedule(
--     'notifica-push-urgenti',
--     '*/5 * * * *',
--     $cron$
--       select net.http_post(
--         url     := 'https://gnqnebjuhnxvndrpcdtt.functions.supabase.co/notifica-push',
--         headers := jsonb_build_object('x-webhook-secret', '<WEBHOOK_SECRET>')
--       );
--     $cron$
--   );
--
-- Per spegnere:  select cron.unschedule('notifica-push-urgenti');
