# Setup Storage per l'anteprima 3D degli STL

Serve **solo** per l'anteprima 3D *automatica* nell'Admin (la miniatura + il viewer che si
aprono da soli, sui nuovi ordini). Il pulsante **"Apri file STL" lato cliente funziona già
senza questo setup** (usa il file locale del cliente).

> Senza il setup, anche l'Admin funziona: mostra il bottone **"🧊 Apri viewer 3D"** e
> l'operatore ci trascina lo STL/ZIP appena scaricato (caricamento manuale). Il setup serve
> solo a rendere l'anteprima **automatica**.

## Cos'è, in parole semplici

- Un **bucket** = una cartella dentro il tuo Supabase dove vengono salvati i file STL.
- Le **policy** = regole di permesso: chi può scrivere e chi può leggere quella cartella.

Il configuratore, quando arriva un ordine, salva lo STL in `ordini-stl/<share_token>.stl`.
L'Admin ricava l'indirizzo dal `share_token` (lo stesso del link cliente) e mostra il modello.
Nessuna colonna nuova nel database: basta creare il bucket e i permessi.

## Come farlo: un unico copia-incolla (≈30 secondi)

1. Apri il tuo progetto su **supabase.com** → menu a sinistra **SQL Editor** → **New query**.
2. Incolla **tutto** il blocco qui sotto e premi **Run**.

```sql
-- 1) Crea il bucket "ordini-stl" (pubblico, max 50 MB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ordini-stl', 'ordini-stl', true, 52428800, array['application/octet-stream'])
on conflict (id) do update
  set public = true,
      file_size_limit = 52428800,
      allowed_mime_types = array['application/octet-stream'];

-- 2) Permesso di upload: configuratore (anon) e Admin (authenticated)
drop policy if exists "ordini-stl insert" on storage.objects;
create policy "ordini-stl insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'ordini-stl');

drop policy if exists "ordini-stl update" on storage.objects;
create policy "ordini-stl update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'ordini-stl')
  with check (bucket_id = 'ordini-stl');
```

Fatto. La **lettura è già pubblica** perché il bucket è pubblico (non serve una policy di
lettura). Dal primo ordine nuovo in poi, l'Admin mostra la miniatura 3D e apre il viewer al
click. Gli ordini vecchi restano sul caricamento manuale.

Puoi rilanciare lo script quando vuoi: è scritto per non dare errori se già eseguito.

## Verifica (facoltativa)

Dopo un ordine nuovo dal configuratore, in Supabase → **Storage** → `ordini-stl` dovresti
vedere comparire un file `<...>.stl`. Nell'Admin, aprendo quell'ordine, comparirà la miniatura.

## Note

- Lo STL viene caricato con la *publishable key* già presente nel configuratore (lo stesso
  meccanismo con cui si salvano gli ordini). Il limite di 50 MB e il tipo file riducono
  eventuali abusi. Se un giorno un upload venisse rifiutato per "tipo file non consentito",
  allarga la lista `allowed_mime_types` (es. aggiungi `'model/stl'`).
- Il bucket è pubblico: lo STL è raggiungibile solo da chi conosce l'indirizzo con l'UUID
  (`share_token`), esattamente come il link cliente `traccia-ordine`.
- Il viewer 3D nell'Admin usa three.js + JSZip caricati al volo da `esm.sh` (serve internet).
```

