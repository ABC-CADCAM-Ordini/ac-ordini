-- ─────────────────────────────────────────────────────────────
-- Fase 1 respond.io — DIGEST notifiche stato ordine (riassunto orario)
-- ─────────────────────────────────────────────────────────────
-- Invece di un messaggio per ogni cambio stato, un solo riassunto per cliente ogni ora.
--
-- 1) flag `notifica_pending` sull'ordine, alzato dal trigger SOLO quando lo stato avanza
--    a 'in_lavorazione' o 'concluso' (NON alla creazione dell'ordine).
-- 2) un cron orario (in fondo) chiama la Edge Function `digest-whatsapp`, che raggruppa
--    per cliente gli ordini con notifica_pending=true, manda UN messaggio a testa e azzera i flag.
--
-- Additivo. Da girare all'ACCENSIONE (dopo l'approvazione del template `ac_aggiornamento_ordini`),
-- non prima: altrimenti i flag si accumulano senza che nulla li consumi.

alter table public.orders
  add column if not exists notifica_pending boolean not null default false;

create or replace function public.marca_notifica_pending()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('in_lavorazione', 'concluso') then
    new.notifica_pending := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_marca_notifica on public.orders;
create trigger trg_marca_notifica
before update on public.orders
for each row execute function public.marca_notifica_pending();

-- ── Cron orario (attivare SOLO all'accensione) ────────────────────────────────
-- Richiede le extension pg_cron e pg_net (Dashboard → Database → Extensions).
-- Il WEBHOOK_SECRET è lo stesso salvato nei secret della funzione; NON in chiaro nel repo.
--
--   select cron.schedule(
--     'digest-whatsapp-hourly',
--     '0 * * * *',                              -- ogni ora, al minuto 0
--     $cron$
--       select net.http_post(
--         url     := 'https://gnqnebjuhnxvndrpcdtt.functions.supabase.co/digest-whatsapp',
--         headers := jsonb_build_object('x-webhook-secret', '<WEBHOOK_SECRET>')
--       );
--     $cron$
--   );
--
-- PRIMA di attivare il cron, azzerare l'eventuale arretrato accumulato:
--   update public.orders set notifica_pending = false;
