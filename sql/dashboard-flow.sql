-- ══════════════════════════════════════════════════════════════
-- NUOVO FLUSSO "DASHBOARD" — Fase 1: modello + RPC portale riscritta
-- Obiettivo: la dashboard per-persona (portale) diventa il canale principale.
--   • cliente  → vede i SUOI casi
--   • commerciale → vede i casi dei SUOI clienti (gerarchia) + eventuali casi diretti (eccezioni)
--   • il link del singolo caso (traccia-ordine) resta come opzione speciale
-- Riusa: collaboratori (rubrica) + ordini_condivisi (caso↔persona). Nessuna tabella nuova.
-- ══════════════════════════════════════════════════════════════

-- 1) Estendi la rubrica: chiavi di match (studio/email) + gerarchia commerciale
alter table collaboratori add column if not exists email          text;
alter table collaboratori add column if not exists studio         text;
alter table collaboratori add column if not exists commerciale_id uuid;

-- FK di gerarchia (un cliente appartiene a un commerciale). Se il commerciale viene
-- cancellato, il cliente resta ma senza commerciale.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'collaboratori_commerciale_fk'
  ) then
    alter table collaboratori
      add constraint collaboratori_commerciale_fk
      foreign key (commerciale_id) references collaboratori(id) on delete set null;
  end if;
end$$;

create index if not exists collaboratori_commerciale_idx on collaboratori(commerciale_id);
-- match per studio case-insensitive
create index if not exists collaboratori_studio_lower_idx on collaboratori(lower(studio));

-- 2) RPC dashboard riscritta.
--    distinct: un caso può risultare sia "diretto" sia "via cliente" → una sola riga.
create or replace function ordini_collaboratore(p_token uuid)
returns table (
  id           uuid,
  codice       text,
  cliente      text,
  lavorazione  text,
  stato        text,
  ricevuto_il  timestamptz,
  scheda       jsonb,
  tracking     text,
  share_token  uuid
)
language sql
security definer
set search_path = public
as $$
  with me as (
    select id, tipo from collaboratori where token = p_token and attivo = true
  )
  select distinct
    o.id,
    upper(substr(o.id::text, 1, 8))                                                   as codice,
    coalesce(nullif(btrim(o.nome || ' ' || coalesce(o.cognome, '')), ''), o.azienda)  as cliente,
    o.lavorazione,
    o.status                                                                          as stato,
    o.created_at                                                                      as ricevuto_il,
    -- whitelist: al canale pubblico (anon) escono SOLO le chiavi usate dal portale
    -- (origine/id_na per il codice NA), non l'intera scheda di produzione.
    jsonb_build_object('origine', o.scheda_dati->'origine', 'id_na', o.scheda_dati->'id_na') as scheda,
    o.tracking,
    o.share_token
  from me
  join orders o on (
    -- (a) casi collegati DIRETTAMENTE a me (cliente, o commerciale-eccezione)
    exists (
      select 1 from ordini_condivisi oc
      where oc.order_id = o.id and oc.collaboratore_id = me.id
    )
    or
    -- (b) se sono un COMMERCIALE: i casi dei miei clienti (gerarchia)
    (me.tipo = 'commerciale' and exists (
      select 1
      from ordini_condivisi oc
      join collaboratori cli on cli.id = oc.collaboratore_id
      where oc.order_id = o.id
        and cli.commerciale_id = me.id
        and cli.tipo   = 'cliente'   -- la gerarchia vale solo per i clienti (difensivo)
        and cli.attivo = true        -- cliente disattivato = nascosto ovunque, anche al commerciale
    ))
  )
  -- ricevuti/in lavorazione sempre; conclusi solo entro la scadenza (chiusura + 30 giorni)
  where (o.status <> 'concluso' or (o.share_expires_at is not null and o.share_expires_at > now()))
  order by ricevuto_il desc;
$$;

grant execute on function ordini_collaboratore(uuid) to anon;

-- collaboratore_info resta invariata (nome/tipo per l'intestazione del portale).
