-- ══════════════════════════════════════════════════════════════
-- ORDINI-MEDIA — bucket per foto/scansioni (Implant Detector + chat ordine)
--
-- PERCHÉ. Il Configuratore (Implant Detector) e la chat dell'ordine fanno caricare
-- foto (convertite in JPG leggeri) e STL. Modello identico a `ordini-stl`: bucket
-- PUBBLICO ma con path NON indovinabili (contengono lo share_token uuid dell'ordine),
-- così cliente (traccia), operatore (portale) e Admin vedono le immagini con URL
-- diretto, senza autenticazione né URL firmati. Scelta confermata da Francesco
-- (stesso compromesso già accettato per gli STL del paziente).
--
-- Path in uso:
--   • Configuratore Implant Detector : <share_token>/i<n>-<m>-<file>
--   • Chat ordine                    : <share_token>/chat/<uuid>-<file>
--
-- DA ESEGUIRE nel SQL Editor di Supabase. Idempotente: si può rilanciare.
-- ══════════════════════════════════════════════════════════════

-- 0) Crea il bucket PUBBLICO (se non esiste). 25MB/file; foto JPG/PNG e STL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ordini-media', 'ordini-media', true, 26214400,
  array['image/jpeg','image/png','model/stl','application/octet-stream']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 26214400,
  allowed_mime_types = array['image/jpeg','image/png','model/stl','application/octet-stream'];

-- 1) Insert dal browser (Configuratore, traccia cliente, portale operatore): SOLO create,
--    e il path DEVE iniziare con <share_token>/ (uuid). Ruolo `public`: con le chiavi
--    `sb_publishable_` lo storage non mappa a `anon`/`authenticated` in modo affidabile,
--    quindi si usa `public` (il regex + bucket pubblico restano la barriera).
--    IMPORTANTE lato client: l'upload NON deve mandare l'header `x-upsert: true` — con
--    l'upsert lo storage richiede anche il permesso di UPDATE (che qui non c'è) e risponde
--    403 "violates row-level security". Path unici (uuid nel nome) → l'upsert non serve.
drop policy if exists "carica i media dell'ordine (anon)" on storage.objects;
create policy "carica i media dell'ordine (anon)"
  on storage.objects for insert to public
  with check (
    bucket_id = 'ordini-media'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  );

-- 2) Lettura: bucket pubblico → lettura aperta (come ordini-stl). Nessuna policy di select
--    necessaria; l'URL /object/public/ordini-media/<path> è servito direttamente.

-- 3) L'operatore loggato può cancellare: per togliere i file alla cancellazione ordine.
drop policy if exists "operatore cancella i media dell'ordine" on storage.objects;
create policy "operatore cancella i media dell'ordine"
  on storage.objects for delete to authenticated
  using (bucket_id = 'ordini-media');

-- ── VERIFICA (facoltativa) ────────────────────────────────────
--   select id, public from storage.buckets where id = 'ordini-media';   -- public = true
--   select policyname, cmd, roles from pg_policies
--     where schemaname='storage' and tablename='objects' and policyname ilike '%media%';
