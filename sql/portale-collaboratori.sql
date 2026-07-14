-- ══════════════════════════════════════════════════════════════
-- PORTALE COLLABORATORI — Fase 1: schema dati + RPC
-- Ogni collaboratore (commerciale o cliente-grosso) ha un token;
-- apre portale.html?c=<token> e vede SOLO gli ordini condivisi con lui.
-- ══════════════════════════════════════════════════════════════

-- 1) Collaboratori: una riga per commerciale / cliente. Il "token" è il suo link.
create table if not exists collaboratori (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  tipo        text not null default 'commerciale',   -- 'commerciale' | 'cliente'
  token       uuid not null default gen_random_uuid(),
  vede_prezzi boolean not null default false,         -- per il futuro (v1 non mostra prezzi)
  attivo      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists collaboratori_token_uq on collaboratori(token);

-- 2) Ordini condivisi: quale ordine con quale collaboratore.
create table if not exists ordini_condivisi (
  order_id        uuid not null references orders(id) on delete cascade,
  collaboratore_id uuid not null references collaboratori(id) on delete cascade,
  condiviso_il    timestamptz not null default now(),
  primary key (order_id, collaboratore_id)
);
create index if not exists ordini_condivisi_collab_idx on ordini_condivisi(collaboratore_id);

-- 3) RLS: nessun accesso diretto da anon (si passa dalla RPC). L'Admin loggato gestisce tutto.
alter table collaboratori     enable row level security;
alter table ordini_condivisi  enable row level security;

drop policy if exists "admin gestisce collaboratori" on collaboratori;
create policy "admin gestisce collaboratori" on collaboratori
  for all to authenticated using (true) with check (true);

drop policy if exists "admin gestisce condivisioni" on ordini_condivisi;
create policy "admin gestisce condivisioni" on ordini_condivisi
  for all to authenticated using (true) with check (true);

-- 4) RPC pubblica: dato il token, ritorna gli ordini condivisi (campi safe, niente prezzi/note interne).
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
  select
    o.id,
    upper(substr(o.id::text, 1, 8))                                              as codice,
    coalesce(nullif(btrim(o.nome || ' ' || coalesce(o.cognome, '')), ''), o.azienda) as cliente,
    o.lavorazione,
    o.status                                                                     as stato,
    o.created_at                                                                 as ricevuto_il,
    o.scheda_dati                                                                as scheda,
    o.tracking,
    o.share_token
  from ordini_condivisi oc
  join collaboratori c on c.id = oc.collaboratore_id and c.attivo = true
  join orders o        on o.id = oc.order_id
  where c.token = p_token
    -- ricevuti/in lavorazione sempre; conclusi solo entro la scadenza (chiusura + 30 giorni)
    and (o.status <> 'concluso' or (o.share_expires_at is not null and o.share_expires_at > now()))
  order by o.created_at desc;
$$;

grant execute on function ordini_collaboratore(uuid) to anon;
