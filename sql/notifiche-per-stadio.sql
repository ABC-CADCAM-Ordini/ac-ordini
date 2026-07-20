-- ══════════════════════════════════════════════════════════════
-- NOTIFICHE PER STADIO — cliente (WhatsApp per ordine) + pacing collettivo operatori
-- ══════════════════════════════════════════════════════════════
-- Sostituisce il digest generico ("hai aggiornamenti") con un messaggio SPECIFICO per
-- ogni ordine quando passa di stadio: preso in carico → in produzione → prodotto.
-- Il cron resta ORARIO (digest-whatsapp-hourly, già schedulato); non manda più un
-- riassunto ma, per ogni ordine con uno stadio in sospeso, il messaggio di quello stadio.
--
-- 1) orders.notifica_stadio (testo): null | 'preso_in_carico' | 'in_produzione' | 'prodotto'.
--    Sostituisce orders.notifica_pending (booleano), che rimuoviamo.
-- 2) Il trigger esistente trg_marca_notifica ora imposta lo stadio:
--    - 'preso_in_carico' la PRIMA volta che un operatore viene assegnato (non le riassegnazioni)
--    - 'in_produzione' / 'prodotto' quando lo stato passa a in_lavorazione / concluso
-- 3) wa_avvisi_stato: piccola tabella di stato per il PACING COLLETTIVO degli avvisi WhatsApp
--    agli operatori (nuovi ordini / nuovi urgenti / urgenti ancora bloccati) — un messaggio
--    per categoria a giro, non uno per ordine. Le push restano invariate (per singolo ordine).

alter table public.orders add column if not exists notifica_stadio text;
alter table public.orders drop column if exists notifica_pending;

create or replace function public.marca_notifica_pending() returns trigger
language plpgsql as $$
begin
  if old.operator is null and new.operator is not null then
    new.notifica_stadio := 'preso_in_carico';
  end if;
  if new.status is distinct from old.status then
    if new.status = 'in_lavorazione' then
      new.notifica_stadio := 'in_produzione';
    elsif new.status = 'concluso' then
      new.notifica_stadio := 'prodotto';
    end if;
  end if;
  return new;
end;
$$;
-- Il trigger trg_marca_notifica esiste già (before update on orders) e chiama questa
-- funzione: cambiando solo il corpo (CREATE OR REPLACE) non serve toccarlo.

create table if not exists public.wa_avvisi_stato (
  chiave       text primary key,
  ultimo_invio timestamptz
);
