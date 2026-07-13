# Setup Storage per l'anteprima 3D degli STL

L'Admin mostra l'anteprima 3D del modello STL di ogni ordine. Per far funzionare
l'**anteprima automatica** (miniatura + viewer che si aprono da soli) serve un bucket
di Storage su Supabase, dove il configuratore salva lo STL grezzo di ogni nuovo ordine.

> Senza questo setup l'app funziona lo stesso: l'Admin mostra il bottone
> **"🧊 Apri viewer 3D"** e l'operatore ci trascina lo STL/ZIP appena scaricato
> (caricamento manuale). Il setup serve solo per l'anteprima **automatica** sui nuovi ordini.

## Come funziona (senza modifiche al database)

- Ogni ordine ha già un `share_token` (l'UUID del link cliente).
- Il configuratore carica lo STL in `ordini-stl/<share_token>.stl`.
- L'Admin ricava l'URL dal `share_token` → **nessuna colonna nuova da aggiungere**.

## 1) Crea il bucket

Dashboard Supabase → **Storage** → **New bucket**
- **Name**: `ordini-stl`
- **Public bucket**: **ON** ✅ (lo STL è raggiungibile solo con l'URL che contiene l'UUID,
  stesso modello del link cliente `traccia-ordine`)
- (Consigliato) **File size limit**: `50 MB` · **Allowed MIME types**: `application/octet-stream`
- **Create bucket**

## 2) Policy di upload (SQL Editor)

Il bucket pubblico consente già la **lettura**. Serve solo permettere la **scrittura**
al configuratore (ruolo `anon`) e all'Admin (`authenticated`):

```sql
-- Upload STL nel bucket ordini-stl (configuratore anon + admin authenticated)
create policy "ordini-stl insert"
on storage.objects for insert
to anon, authenticated
with check ( bucket_id = 'ordini-stl' );

-- Sovrascrittura dello stesso file (x-upsert)
create policy "ordini-stl update"
on storage.objects for update
to anon, authenticated
using ( bucket_id = 'ordini-stl' )
with check ( bucket_id = 'ordini-stl' );
```

Fatto. Dal primo ordine nuovo in poi, l'Admin mostrerà la miniatura 3D e aprirà il
viewer al click. Gli ordini vecchi restano sul caricamento manuale.

## Note

- Lo STL viene caricato con la publishable key già presente nel configuratore
  (stesso meccanismo con cui si salvano gli ordini). Limitare dimensione e MIME
  del bucket (punto 1) riduce eventuali abusi di upload.
- Il viewer 3D nell'Admin usa **three.js** e **JSZip** caricati on-demand da
  `esm.sh` solo al primo utilizzo (serve connessione internet).
