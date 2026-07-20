-- ══════════════════════════════════════════════════════════════
-- STORICO ORDINE — timeline dei passaggi di stato + prese in carico (solo Admin/operatori)
-- ══════════════════════════════════════════════════════════════
-- Colonna jsonb `storico` su orders, popolata da un trigger BEFORE UPDATE che appende
-- un evento ad ogni cambio di `status` e ad ogni cambio di `operator` (presa in carico
-- / rilascio). L'Admin (openDetail → renderStorico) la legge e la mostra; la traccia
-- cliente NON la include (usa RPC che non selezionano questa colonna).
--
-- Retroattività: gli ordini GIÀ esistenti partono con storico=[] (i loro passaggi
-- passati non sono stati registrati). Da ora in poi ogni transizione viene salvata.
-- Additivo e reversibile.

alter table public.orders
  add column if not exists storico jsonb not null default '[]'::jsonb;

create or replace function public.registra_storico() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    new.storico := coalesce(old.storico, '[]'::jsonb)
      || jsonb_build_object('at', now(), 'tipo', 'stato',
                            'da', old.status, 'a', new.status, 'operatore', new.operator);
  end if;
  if new.operator is distinct from old.operator then
    new.storico := coalesce(new.storico, old.storico, '[]'::jsonb)
      || jsonb_build_object('at', now(), 'tipo', 'assegnazione',
                            'da', old.operator, 'a', new.operator);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_registra_storico on public.orders;
create trigger trg_registra_storico
before update on public.orders
for each row execute function public.registra_storico();
