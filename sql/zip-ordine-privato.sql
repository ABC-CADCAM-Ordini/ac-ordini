-- ══════════════════════════════════════════════════════════════
-- ZIP DELL'ORDINE — dal file-host pubblico a un bucket privato
--
-- PERCHÉ. Il Configuratore caricava lo ZIP dell'ordine su gofile.io (e, se falliva,
-- su file.io o catbox.moe): host anonimi, pubblici, senza account e senza contratto.
-- Dentro c'è `config_ordine.txt` con nominativo, studio, telefono, email e P.IVA del
-- cliente, più l'STL del paziente; il nome del file contiene il nome dello studio.
-- Chiunque avesse l'URL poteva scaricarlo, per sempre (un link del 25/05 rispondeva
-- ancora a metà luglio). L'Admin, per giunta, quell'URL lo mandava al cliente su
-- WhatsApp e per email.
--
-- COSA CAMBIA. Il bucket `ordini-zip` è PRIVATO e già creato (50MB, application/zip).
-- Il Configuratore ci carica con la chiave anon; l'Admin scarica con un URL firmato
-- valido pochi minuti. I 23 ZIP già su gofile restano dove sono: questo vale da qui in poi.
--
-- DA ESEGUIRE nel SQL Editor di Supabase. Idempotente: si può rilanciare.
-- ══════════════════════════════════════════════════════════════

-- 1) Il Configuratore (chiave anon, dal browser del cliente) può SOLO creare.
--    Non può leggere: chi carica non deve poter scaricare gli ZIP degli altri.
--    Non può sovrascrivere: niente policy di update → un file caricato non si tocca più.
--    Il nome dell'oggetto è lo share_token dell'ordine, generato client-side e non indovinabile.
drop policy if exists "configuratore carica lo zip dell'ordine" on storage.objects;
create policy "configuratore carica lo zip dell'ordine"
  on storage.objects for insert to anon
  with check (
    bucket_id = 'ordini-zip'
    -- il nome DEVE essere <share_token>.zip: senza vincolo, con la chiave anon chiunque poteva
    -- riempire il bucket privato di file arbitrari (fino a 50MB) invisibili ai flussi dell'Admin.
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$'
  );

-- 2) L'operatore loggato in Admin può leggere: serve a farsi firmare l'URL di download.
--    Il bucket resta privato, quindi senza questo nemmeno l'Admin lo vedrebbe.
--    APPLICATA IN PROD il 2026-07-22 (via SQL Editor): prima MANCAVA — l'upload (policy #1)
--    era attivo ma il download NO, quindi «Scarica file ordine» dava 400 su tutti i nuovi ordini.
--    Nome senza apostrofo (l'apostrofo si rompeva digitandolo nell'editor via automazione).
drop policy if exists "operatore legge lo zip dell'ordine" on storage.objects;
drop policy if exists "operatore scarica lo zip ordine" on storage.objects;
create policy "operatore scarica lo zip ordine"
  on storage.objects for select to authenticated
  using (bucket_id = 'ordini-zip');

-- 3) L'operatore loggato può cancellare: serve a togliere davvero i file quando si
--    cancella un ordine (finora «Cancella ordine» lasciava i file del paziente online).
--    NON ANCORA APPLICATA IN PROD al 2026-07-22 (verificato: c'erano solo INSERT/anon + SELECT).
--    Da eseguire quando si vuole che «Cancella ordine» rimuova davvero lo ZIP col PDF/PII.
drop policy if exists "operatore cancella lo zip dell'ordine" on storage.objects;
create policy "operatore cancella lo zip dell'ordine"
  on storage.objects for delete to authenticated
  using (bucket_id = 'ordini-zip');

-- ── VERIFICA (facoltativa) ────────────────────────────────────
-- Devono comparire tre righe, tutte con bucket_id = 'ordini-zip':
--   select policyname, cmd, roles from pg_policies
--   where schemaname='storage' and tablename='objects' and policyname ilike '%zip%';
