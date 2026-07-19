-- ══════════════════════════════════════════════════════════════
-- Conclusi visibili ancora 48h nel portale (per vedere il tracking del corriere)
-- ══════════════════════════════════════════════════════════════
-- Problema: share_expires_at NON viene mai impostato → la vecchia clausola
--   (o.share_expires_at is not null and o.share_expires_at > now())
-- è sempre falsa, quindi per cliente/commerciale un ordine appena concluso
-- SPARIVA all'istante dal portale e il cliente non riusciva più ad aprirlo per
-- vedere il tracking DHL appena inserito.
--
-- Fix: un concluso resta visibile finché è stato aggiornato negli ultimi 48h
-- (updated_at = momento reale del passaggio a 'concluso', scritto dall'Admin ad
-- ogni cambio stato). Espongo anche updated_at così la UI del portale può tenere
-- questi conclusi "recenti" nella lista principale invece che dietro il toggle.
--
-- Rispetto a sql/portale-badge.sql cambiano SOLO due cose (marcate con « NEW »):
--   1) la colonna updated_at nel returns table + nel select
--   2) la clausola « or o.updated_at > now() - interval '48 hours' » nel where
-- Cambia la firma → drop+create.

drop function if exists ordini_collaboratore(uuid);
create function ordini_collaboratore(p_token uuid)
returns table (
  id           uuid,
  codice       text,
  cliente      text,
  lavorazione  text,
  stato        text,
  ricevuto_il  timestamptz,
  updated_at   timestamptz,          -- « NEW » momento dell'ultimo cambio stato (conclusione)
  scheda       jsonb,
  tracking     text,
  share_token  uuid,
  sincronizzato          boolean,
  collegato_cliente      boolean,
  collegato_commerciale  boolean
)
language sql
security definer
set search_path = public
as $$
  with me as (
    select id, tipo, vede_tutto from collaboratori where token = p_token and attivo = true
  )
  select distinct
    o.id,
    upper(substr(o.id::text, 1, 8))                                                   as codice,
    coalesce(nullif(btrim(o.nome || ' ' || coalesce(o.cognome, '')), ''), o.azienda)  as cliente,
    o.lavorazione,
    o.status                                                                          as stato,
    o.created_at                                                                      as ricevuto_il,
    o.updated_at                                                                      as updated_at,   -- « NEW »
    jsonb_build_object('origine', o.scheda_dati->'origine', 'id_na', o.scheda_dati->'id_na') as scheda,
    o.tracking,
    o.share_token,
    -- sincronizzato = la scheda NA è arrivata (id_na o codice_ordine presenti) — come isSyncedNA nell'Admin
    ((o.scheda_dati->>'id_na') is not null or (o.scheda_dati->>'codice_ordine') is not null) as sincronizzato,
    -- collegato a un cliente (condiviso con un collaboratore tipo 'cliente')
    exists (
      select 1 from ordini_condivisi oc join collaboratori c on c.id = oc.collaboratore_id
      where oc.order_id = o.id and c.attivo and coalesce(c.vede_tutto, false) = false and c.tipo = 'cliente'
    ) as collegato_cliente,
    -- seguito da un commerciale (diretto, o via un cliente che ha un commerciale_id) — come _shareMeta.comm
    exists (
      select 1 from ordini_condivisi oc join collaboratori c on c.id = oc.collaboratore_id
      where oc.order_id = o.id and c.attivo and coalesce(c.vede_tutto, false) = false
        and (c.tipo = 'commerciale' or (c.tipo = 'cliente' and c.commerciale_id is not null))
    ) as collegato_commerciale
  from me
  join orders o on (
    me.vede_tutto
    or exists (
      select 1 from ordini_condivisi oc
      where oc.order_id = o.id and oc.collaboratore_id = me.id
    )
    or (me.tipo = 'commerciale' and exists (
      select 1
      from ordini_condivisi oc
      join collaboratori cli on cli.id = oc.collaboratore_id
      where oc.order_id = o.id
        and cli.commerciale_id = me.id
        and cli.tipo   = 'cliente'
        and cli.attivo = true
    ))
  )
  -- operatore vede_tutto: riceve anche i conclusi (il portale li nasconde di default, con toggle);
  -- gli altri (clienti/commerciali) vedono i conclusi finché lo share è valido OPPURE finché
  -- l'ordine è stato concluso da meno di 48h (updated_at) → tempo per vedere il tracking.
  where (
    me.vede_tutto
    or o.status <> 'concluso'
    or (o.share_expires_at is not null and o.share_expires_at > now())
    or o.updated_at > now() - interval '48 hours'          -- « NEW »
  )
  order by ricevuto_il desc;
$$;
grant execute on function ordini_collaboratore(uuid) to anon;
