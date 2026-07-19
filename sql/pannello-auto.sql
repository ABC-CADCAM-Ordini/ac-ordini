-- ─────────────────────────────────────────────────────────────
-- Fase 1 respond.io — Auto-provisioning del pannello cliente
-- ─────────────────────────────────────────────────────────────
-- A ogni nuovo ordine: trova o crea il pannello del cliente (collaboratori tipo
-- 'cliente') e vi collega l'ordine (ordini_condivisi). Così portale.html?c=<token>
-- esiste sempre, dal primo messaggio, e mostra TUTTI gli ordini di quel cliente.
--
-- Match dei clienti abituali: prima per email, poi per studio (azienda) → tutti gli
-- ordini di uno stesso cliente finiscono in un unico pannello.
--
-- ⚠️ A PROVA DI ERRORE: il corpo è avvolto in EXCEPTION; qualsiasi problema nel
--    provisioning viene loggato come WARNING ma NON fa fallire l'INSERT dell'ordine.
--    Additivo e reversibile (drop function + drop trigger per annullarlo).

create or replace function public.provisiona_pannello_cliente()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_collab_id uuid;
  v_email  text := nullif(lower(trim(new.email)), '');
  v_studio text := nullif(trim(new.azienda), '');
  v_nome   text := coalesce(nullif(trim(new.azienda), ''),
                            nullif(trim(concat_ws(' ', new.nome, new.cognome)), ''),
                            'Cliente');
begin
  -- 1) cliente abituale per email
  if v_email is not null then
    select id into v_collab_id from collaboratori
     where tipo = 'cliente' and attivo = true and lower(email) = v_email
     limit 1;
  end if;

  -- 2) fallback: stesso studio
  if v_collab_id is null and v_studio is not null then
    select id into v_collab_id from collaboratori
     where tipo = 'cliente' and attivo = true and lower(studio) = lower(v_studio)
     limit 1;
  end if;

  -- 3) nessun match: nuovo pannello cliente (token generato dal default della tabella)
  if v_collab_id is null then
    insert into collaboratori (nome, tipo, email, studio)
    values (v_nome, 'cliente', v_email, v_studio)
    returning id into v_collab_id;
  end if;

  -- 4) collega l'ordine al pannello (idempotente)
  insert into ordini_condivisi (order_id, collaboratore_id)
  values (new.id, v_collab_id)
  on conflict do nothing;

  return new;
exception when others then
  raise warning 'provisiona_pannello_cliente: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_provisiona_pannello on public.orders;
create trigger trg_provisiona_pannello
after insert on public.orders
for each row execute function public.provisiona_pannello_cliente();
