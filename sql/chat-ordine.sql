-- ══════════════════════════════════════════════════════════════
-- CHAT ORDINE — messaggistica interna bidirezionale, dentro l'ordine
--
-- Generica per QUALSIASI ordine (non solo Implant Detector): cliente e operatore
-- si scrivono e allegano foto/STL nella scheda dell'ordine.
-- Tre superfici, tre identità:
--   • traccia-ordine.html  → cliente, identificato dallo share_token dell'ordine.
--   • portale.html         → collaboratore/operatore, identificato dal token collaboratore
--                            (vede_tutto = operatore).
--   • Admin_Ordini_v2.html → operatore loggato (Supabase Auth) → accesso diretto via RLS.
--
-- I media stanno nel bucket `ordini-media` (vedi sql/ordini-media-bucket.sql). Gli RPC
-- restituiscono i PATH dei media; la UI risolve l'URL (pubblico o firmato) a seconda
-- di come è configurato il bucket.
--
-- DA ESEGUIRE nel SQL Editor di Supabase. Idempotente.
-- ══════════════════════════════════════════════════════════════

-- 1) Tabella dei messaggi.
create table if not exists ordine_messaggi (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  autore      text not null check (autore in ('cliente','operatore')),
  autore_nome text,
  testo       text,
  media       jsonb not null default '[]',   -- [{tipo:'foto'|'stl', nome, path}]
  created_at  timestamptz not null default now(),
  letto_cliente   boolean not null default false,
  letto_operatore boolean not null default false
);
create index if not exists ordine_messaggi_order_idx on ordine_messaggi(order_id, created_at);

-- 2) RLS: anon passa SOLO dagli RPC; l'operatore loggato (Admin) accede a tutto.
alter table ordine_messaggi enable row level security;
drop policy if exists "operatore gestisce i messaggi" on ordine_messaggi;
create policy "operatore gestisce i messaggi" on ordine_messaggi
  for all to authenticated using (true) with check (true);

-- 3) Helper interno: un token collaboratore può accedere a un ordine?
--    Stessa logica d'accesso di ordini_collaboratore (vede_tutto / condiviso / commerciale-via-cliente).
create or replace function _collab_puo_ordine(p_token uuid, p_order uuid)
returns boolean language sql security definer set search_path = public as $$
  with me as (select id, tipo, vede_tutto from collaboratori where token = p_token and attivo = true)
  select exists (
    select 1 from me
    where me.vede_tutto
       or exists (select 1 from ordini_condivisi oc where oc.order_id = p_order and oc.collaboratore_id = me.id)
       or (me.tipo = 'commerciale' and exists (
            select 1 from ordini_condivisi oc join collaboratori cli on cli.id = oc.collaboratore_id
            where oc.order_id = p_order and cli.commerciale_id = me.id and cli.tipo = 'cliente' and cli.attivo = true))
  );
$$;

-- ── CLIENTE su traccia-ordine.html (share_token dell'ordine) ──────────────────

-- 4) Lista messaggi per il cliente. Marca come letti quelli dell'operatore.
create or replace function chat_lista(p_share_token uuid)
returns table (id uuid, autore text, autore_nome text, testo text, media jsonb, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_order uuid;
begin
  select o.id into v_order from orders o where o.share_token = p_share_token;
  if v_order is null then return; end if;
  update ordine_messaggi m set letto_cliente = true
    where m.order_id = v_order and m.autore = 'operatore' and not m.letto_cliente;
  return query
    select m.id, m.autore, m.autore_nome, m.testo, m.media, m.created_at
    from ordine_messaggi m where m.order_id = v_order order by m.created_at;
end; $$;
grant execute on function chat_lista(uuid) to anon;

-- 5) Invio messaggio dal cliente.
create or replace function chat_invia(p_share_token uuid, p_testo text, p_media jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_order uuid; v_id uuid;
begin
  select o.id into v_order from orders o where o.share_token = p_share_token;
  if v_order is null then raise exception 'ordine non trovato'; end if;
  if coalesce(btrim(p_testo), '') = '' and coalesce(jsonb_array_length(p_media), 0) = 0 then
    raise exception 'messaggio vuoto'; end if;
  insert into ordine_messaggi(order_id, autore, testo, media, letto_cliente)
    values (v_order, 'cliente', nullif(btrim(p_testo), ''), coalesce(p_media, '[]'::jsonb), true)
    returning id into v_id;
  return v_id;
end; $$;
grant execute on function chat_invia(uuid, text, jsonb) to anon;

-- ── COLLABORATORE/OPERATORE su portale.html (token collaboratore) ─────────────

-- 6) Lista messaggi via token collaboratore + share_token dell'ordine. Marca letti in base al ruolo.
--    Prende lo share_token (non l'order_id): così la stessa pagina traccia-ordine.html — che ha
--    lo share_token — serve sia il cliente sia l'operatore che la apre dal portale con &c=<token>.
create or replace function chat_lista_collab(p_token uuid, p_share_token uuid)
returns table (id uuid, autore text, autore_nome text, testo text, media jsonb, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_order uuid; v_vede boolean;
begin
  select o.id into v_order from orders o where o.share_token = p_share_token;
  if v_order is null then return; end if;
  if not _collab_puo_ordine(p_token, v_order) then return; end if;
  select coalesce(c.vede_tutto, false) into v_vede from collaboratori c where c.token = p_token and c.attivo = true;
  if v_vede then
    update ordine_messaggi m set letto_operatore = true
      where m.order_id = v_order and m.autore = 'cliente' and not m.letto_operatore;
  else
    update ordine_messaggi m set letto_cliente = true
      where m.order_id = v_order and m.autore = 'operatore' and not m.letto_cliente;
  end if;
  return query
    select m.id, m.autore, m.autore_nome, m.testo, m.media, m.created_at
    from ordine_messaggi m where m.order_id = v_order order by m.created_at;
end; $$;
grant execute on function chat_lista_collab(uuid, uuid) to anon;

-- 7) Invio messaggio via token collaboratore + share_token. vede_tutto → autore 'operatore', altrimenti 'cliente'.
create or replace function chat_invia_collab(p_token uuid, p_share_token uuid, p_testo text, p_media jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_order uuid; v_id uuid; v_vede boolean; v_nome text;
begin
  select o.id into v_order from orders o where o.share_token = p_share_token;
  if v_order is null then raise exception 'ordine non trovato'; end if;
  if not _collab_puo_ordine(p_token, v_order) then raise exception 'accesso negato'; end if;
  select coalesce(c.vede_tutto, false), c.nome into v_vede, v_nome
    from collaboratori c where c.token = p_token and c.attivo = true;
  if coalesce(btrim(p_testo), '') = '' and coalesce(jsonb_array_length(p_media), 0) = 0 then
    raise exception 'messaggio vuoto'; end if;
  insert into ordine_messaggi(order_id, autore, autore_nome, testo, media, letto_operatore, letto_cliente)
    values (
      v_order,
      case when v_vede then 'operatore' else 'cliente' end,
      v_nome,
      nullif(btrim(p_testo), ''),
      coalesce(p_media, '[]'::jsonb),
      case when v_vede then true  else false end,
      case when v_vede then false else true  end
    )
    returning id into v_id;
  return v_id;
end; $$;
grant execute on function chat_invia_collab(uuid, uuid, text, jsonb) to anon;

-- ── VERIFICA (facoltativa) ────────────────────────────────────
--   select proname from pg_proc where proname like 'chat\_%';
--   -- attese: chat_lista, chat_invia, chat_lista_collab, chat_invia_collab
