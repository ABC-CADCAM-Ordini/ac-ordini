-- ══════════════════════════════════════════════════════════════
-- PWA OPERATORE (riuso portale) — token "vede tutto" + push dal portale + alert nuovo ordine
-- ══════════════════════════════════════════════════════════════
-- Additivo. La app mobile degli addetti al carico riusa portale.html (token), non una pagina
-- nuova. Un token "Operatori" con vede_tutto vede TUTTI gli ordini (solo campi whitelistati,
-- come il resto del portale). Le push si iscrivono dal portale (anon) via RPC legata al token.
-- Vedi memoria pwa-operatore-portale + avvisi-urgenti-push.

-- 1) Collaboratore "vede tutto" ────────────────────────────────
alter table public.collaboratori add column if not exists vede_tutto boolean not null default false;

-- 2) RPC dashboard estesa: se vede_tutto → TUTTI gli ordini (stessa whitelist, niente scheda piena).
--    Stessa firma di sql/dashboard-flow.sql: solo aggiunto il ramo `me.vede_tutto`.
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
    select id, tipo, vede_tutto from collaboratori where token = p_token and attivo = true
  )
  select distinct
    o.id,
    upper(substr(o.id::text, 1, 8))                                                   as codice,
    coalesce(nullif(btrim(o.nome || ' ' || coalesce(o.cognome, '')), ''), o.azienda)  as cliente,
    o.lavorazione,
    o.status                                                                          as stato,
    o.created_at                                                                      as ricevuto_il,
    jsonb_build_object('origine', o.scheda_dati->'origine', 'id_na', o.scheda_dati->'id_na') as scheda,
    o.tracking,
    o.share_token
  from me
  join orders o on (
    -- (NUOVO) operatore che vede tutto → ogni ordine
    me.vede_tutto
    -- (a) casi collegati DIRETTAMENTE a me (cliente, o commerciale-eccezione)
    or exists (
      select 1 from ordini_condivisi oc
      where oc.order_id = o.id and oc.collaboratore_id = me.id
    )
    -- (b) se sono un COMMERCIALE: i casi dei miei clienti (gerarchia)
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
  where (o.status <> 'concluso' or (o.share_expires_at is not null and o.share_expires_at > now()))
  order by ricevuto_il desc;
$$;
grant execute on function ordini_collaboratore(uuid) to anon;

-- 3) push_subscriptions: iscrizioni legate al TOKEN (collaboratore), non solo agli account profiles.
alter table public.push_subscriptions add column if not exists collaboratore_id uuid references public.collaboratori(id) on delete cascade;
alter table public.push_subscriptions alter column profile_id drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'push_sub_owner_chk') then
    alter table public.push_subscriptions
      add constraint push_sub_owner_chk check (profile_id is not null or collaboratore_id is not null);
  end if;
end$$;
create index if not exists push_subscriptions_collab_idx on public.push_subscriptions(collaboratore_id);

-- 4) RPC anon per iscrivere una push DAL PORTALE (valida il token, il portale non ha login).
create or replace function salva_push_collaboratore(
  p_token uuid, p_endpoint text, p_p256dh text, p_auth text, p_ua text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c_id uuid;
begin
  select id into c_id from public.collaboratori where token = p_token and attivo = true;
  if c_id is null then
    raise exception 'token non valido';
  end if;
  insert into public.push_subscriptions (collaboratore_id, endpoint, p256dh, auth, user_agent, attivo, last_seen_at)
  values (c_id, p_endpoint, p_p256dh, p_auth, p_ua, true, now())
  on conflict (endpoint) do update
    set collaboratore_id = excluded.collaboratore_id,
        p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, attivo = true, last_seen_at = now();
end;
$$;
grant execute on function salva_push_collaboratore(uuid, text, text, text, text) to anon;

-- 5) Alert "nuovo ordine": flag su orders. Gli ESISTENTI a true (niente alert retroattivi):
--    solo gli ordini creati DA ORA in poi (default false) faranno scattare la push "nuovo ordine".
alter table public.orders add column if not exists push_nuovo_inviato boolean not null default false;
update public.orders set push_nuovo_inviato = true where push_nuovo_inviato = false;
