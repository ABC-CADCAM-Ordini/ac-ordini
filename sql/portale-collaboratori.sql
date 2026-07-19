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

-- 4) RPC pubblica ordini_collaboratore.
-- ⚠️  NON ridefinire qui la RPC. La versione DA TENERE in produzione è quella WHITELISTATA in
--     sql/dashboard-flow.sql, che espone all'anon solo `origine`/`id_na` (per il codice NA) e
--     NON l'intera `scheda_dati`. La vecchia versione presente qui restituiva `o.scheda_dati`
--     completa: rilanciare questo file con quel corpo REGREDIVA la sicurezza del portale.
--     Definizione rimossa apposta — l'unica fonte della RPC è dashboard-flow.sql.

-- 5) RPC pubblica: nome/tipo del collaboratore dal token (per personalizzare il portale).
create or replace function collaboratore_info(p_token uuid)
returns table (nome text, tipo text)
language sql security definer set search_path = public as $$
  select c.nome, c.tipo from collaboratori c where c.token = p_token and c.attivo = true;
$$;
grant execute on function collaboratore_info(uuid) to anon;
