-- ══════════════════════════════════════════════════════════════
-- STORAGE — permesso di CANCELLARE i file di un ordine (Feature 1)
--
-- PERCHÉ SERVE
-- Cancellare un ordine dall'Admin toglieva solo la riga dal database: i file restavano.
-- Un ordine ha file in QUATTRO bucket:
--   • ordini-stl   (pubblico) — STL del paziente             <share_token>.stl
--   • ordini-doc   (pubblico) — PDF conformità/garanzia/lav. <share_token>-*.pdf
--   • ordini-zip   (PRIVATO)  — ZIP con PII + STL            <share_token>.zip
--   • ordini-media (pubblico) — foto/STL di chat e detector  <share_token>/...
--
-- PERCHÉ ANCHE «select» E NON SOLO «delete»
-- Per cancellare, lo Storage prima cerca l'oggetto (una select, sotto RLS) e poi lo elimina.
-- Senza la select non lo "vede" e risponde «Object not found»: fallisce in silenzio, con la
-- stessa risposta che darebbe se il file non ci fosse. Che il bucket sia pubblico NON basta:
-- la lettura pubblica passa da un'altra strada e non vale come policy di select. Nessuna
-- esposizione in più: sono file già leggibili da chi ha il link, e qui il permesso è del solo
-- operatore loggato (authenticated) — anon continua solo a caricare.
--
-- La pulizia AUTOMATICA (Feature 2) gira con la service key e bypassa la RLS: NON dipende da
-- queste policy. Queste servono alla cancellazione manuale dall'Admin (ruolo authenticated).
--
-- Idempotente: si può rilanciare. DA ESEGUIRE nel SQL Editor di Supabase PRIMA di deployare l'HTML.
-- ══════════════════════════════════════════════════════════════

-- ── ordini-stl: il modello 3D del paziente ────────────────────
drop policy if exists "ordini-stl select" on storage.objects;
create policy "ordini-stl select" on storage.objects
  for select to authenticated using (bucket_id = 'ordini-stl');
drop policy if exists "ordini-stl delete" on storage.objects;
create policy "ordini-stl delete" on storage.objects
  for delete to authenticated using (bucket_id = 'ordini-stl');

-- ── ordini-doc: lavorazione, dichiarazione di conformità, garanzia ──
drop policy if exists "ordini-doc select" on storage.objects;
create policy "ordini-doc select" on storage.objects
  for select to authenticated using (bucket_id = 'ordini-doc');
drop policy if exists "ordini-doc delete" on storage.objects;
create policy "ordini-doc delete" on storage.objects
  for delete to authenticated using (bucket_id = 'ordini-doc');

-- ── ordini-zip: lo ZIP privato (la select è già stata applicata il 2026-07-22) ──
drop policy if exists "operatore cancella lo zip ordine" on storage.objects;
create policy "operatore cancella lo zip ordine" on storage.objects
  for delete to authenticated using (bucket_id = 'ordini-zip');

-- ── ordini-media: foto/STL di chat e detector (la delete esiste già → aggiungo la select) ──
drop policy if exists "ordini-media select" on storage.objects;
create policy "ordini-media select" on storage.objects
  for select to authenticated using (bucket_id = 'ordini-media');

-- ── VERIFICA (facoltativa): elenca tutte le policy dei bucket ordine ──
-- select policyname, cmd, roles from pg_policies
--   where schemaname='storage' and tablename='objects'
--     and (policyname ilike '%ordini-%' or policyname ilike '%zip%' or policyname ilike '%media%')
--   order by policyname;
