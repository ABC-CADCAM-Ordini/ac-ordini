# Implant Detector e Replica Impianto — Spec di prodotto

> Nuovo prodotto ordinabile da AC Ordini. Bozza di disegno del 2026-07-21 (Francesco + Claude).
> Le voci marcate **[PROPOSTA]** sono raccomandazioni da confermare; **[DECISO]** è già concordato.
> Nessun codice ancora scritto: questo file è la spec da cui costruire.

## 1. Cos'è
Servizio di **identificazione implantare + produzione di geometrie protesiche personalizzate** (replica).
Il clinico/tecnico invia componenti fisici (monconi, analogo, vite protesica) oppure l'**impronta in
silicone** della connessione interna dell'impianto; il lab identifica il sistema implantare e produce i
componenti richiesti.

Framing ufficiale già live su https://abutmentcompatibili.com/implant-detector (da rispecchiare):
- Descrizione: «servizio di identificazione implantare e produzione di geometrie protesiche personalizzate di AbutmentCompatibili.com».
- Flusso cliente in 3 passi: **1. Scarica il protocollo → 2. prepara i materiali → 3. prenota il ritiro**.

## 2. Cosa lo rende diverso da ogni altro ordine
1. **Non parte da uno STL** — lo STL/scan è un *output* (il lab scansiona ciò che riceve). Upload STL NON obbligatorio.
2. **Primo prodotto multi-item dichiarato dal cliente** — oggi gli array `scheda_dati.impianti[]/lotti[]/documenti[]` li scrive solo il sync NA.
3. **La diagnosi è il deliverable** — esito con livello di confidenza + guardia medical: nessuna produzione automatica da identificazione a bassa confidenza.
4. **Serve messaggistica bidirezionale + upload immagini cliente** — oggi zero (pagine cliente read-only).

## 3. Modello dati — **[DECISO]**
Singola riga `orders`, `lavorazione = 'implant_detector'`, prezzo a preventivo (niente `prezzo_base` fisso).
Tutto il resto in `scheda_dati.detector`:

```jsonc
scheda_dati.detector = {
  fase: 'richiesta_aperta',            // rollup order-level (vedi §4)
  campioni_tipo: 'monconi'|'impronta_silicone'|'misto',
  // dati ordine
  libreria: true,                       // vuoi la libreria implantare? SI/NO
  cad: 'exocad'|'3shape'|'dwos'|'altro',
  lavorazione_protesica: 'avvitata_diretta'|'incollaggio_cementata'|'altro',
  paziente: 'string',
  items: [{
    idx: 1,
    descrizione: 'moncone dritto, avvitato, arcata sup.',
    modalita: 'identifica_e_produci'|'solo_identifica',   // guida il gate, vedi §4
    media: [{tipo:'foto'|'scan'|'rx', url, nome}],          // caricati dal cliente
    // compilati dal lab:
    identificazione: { sistema, piattaforma, diametro, confidenza:'alta'|'media'|'bassa', note },
    esito: 'da_identificare'|'identificato'|'non_identificabile',
    componenti_richiesti: [ /* vedi catalogo §5 */ ],
    fase: 'in_identificazione'          // stato produzione tracciato QUI (nessun NA)
  }]
}
```

I 3 `status` coarse (`ricevuto`/`in_lavorazione`/`concluso`) restano **intatti** (filtri, trigger notifiche,
storico invariati). La fase fine è **per-item**; la `fase` a livello ordine è un rollup (la meno avanzata) usato solo per la riga in lista.

## 4. Ciclo di vita — **[DECISO]**
```
richiesta_aperta ──► campioni_ricevuti ──► in_identificazione ──┐
                                                                 │
  item modalita = identifica_e_produci ──────────────► in_produzione ─► prodotto ─► concluso
  (produzione già approvata: NON si avvisa "identificato")       │
                                                                 │
  item modalita = solo_identifica ─► identificato (gate cliente)─┘  (se approva)
```
Mapping su `status` / `notifica_stadio` esistenti (nessuna modifica allo schema):
| fase detector | status | notifica_stadio |
|---|---|---|
| richiesta_aperta | ricevuto | — |
| campioni_ricevuti | in_lavorazione | preso_in_carico (via assegnazione operatore) |
| in_identificazione | in_lavorazione | — |
| identificato (solo gate) | in_lavorazione | — (nessuno stadio "identificato": voluto) |
| in_produzione | in_lavorazione | in_produzione |
| prodotto / concluso | concluso | prodotto |

## 5. Catalogo componenti "cosa produrre" (per-impianto) — **[DECISO]**
Dal modulo reale MD_149 rev.02. Attributi attivi solo dove hanno senso:

| Componente | Quantità | HG (alt. trasmucosa) | Inclinazione | Extra |
|---|:--:|:--:|:--:|---|
| Scan Abutment | ✓ | — | — | |
| Analogo Digitale | ✓ | — | — | |
| Analogo da Gesso | ✓ | — | — | |
| Link-in da incollaggio | ✓ | ✓ | — | |
| MUA | ✓ | ✓ | ✓ | |
| Transfert / JT | ✓ | — | — | |
| Moncone personalizzato | ✓ | ✓ | ✓ | materiale: Titanio / CoCr / Calcinabile |
| Vite di guarigione | ✓ | ✓ | — | |
| Attacchi Rhein83 | ✓ | — | — | tipo attacco |

Componenti selezionati **per-impianto** ([PROPOSTA]: più pulito del modulo cartaceo che ha una tabella per-richiesta).

## 6. Step "prima di spedire" (configuratore) — descrizione sintetica + link PDF — **[DECISO]**
Non ricreare il protocollo in HTML (ha foto cliniche non disponibili). Mostrare questo testo + link al PDF Drive:

> **Implant Detector e Replica Impianto — come preparare e spedire**
> Invia i **componenti fisici** (moncone, analogo, vite protesica) oppure, se non li hai, l'**impronta in
> silicone** della parte interna dell'impianto.
> - **Impronta:** silicone per addizione (VPS), consistenza Regular/Medium; inietta nell'impianto col puntale
>   intraorale in retroriempimento, tenendolo immerso per evitare bolle; rimuovi con delicatezza a
>   polimerizzazione completata.
> - **Allega:** RX endorale nitida, foto occlusale della testa implantare (senza protesi), e ogni info utile.
> - **Spedizione:** componenti integri, decontaminati, imbustati singolarmente e sterilizzati in autoclave
>   (altrimenti restituiti); più impronte → buste separate.
> - **Tempi:** 6 giorni lavorativi. Ritiro a pagamento «Ritiro Reso/Spedizione» (€10).
>
> 📄 Protocollo completo (PDF): https://drive.google.com/file/d/1o4JgNINcky82Q8APnzlKMYB09DjMP_iQ/view
> 🚚 Prenota il ritiro: https://abutmentcompatibili.com/ritiro-reso-spedizione.html

## 7. Modulo di accompagnamento (aggancio fisico↔digitale) — **[PROPOSTA]**
Stampabile riusando il pattern `printModuloBeFree()`. Contiene: **codice richiesta = primi 8 hex dello
`share_token` + QR**, indirizzo di spedizione (Via Aurelia Nord 340ab, 19021 Arcola SP), e la lista degli
impianti dichiarati con il loro `idx`. All'arrivo del pacco l'operatore digita/scansiona il codice → apre
l'ordine → segna `campioni_ricevuti`. Stessa logica dell'`ID:<8hex>` autoritativo già usato per l'aggancio NA.

## 8. Messaggistica interna con immagini — **[DECISO]** — chat generica, dentro l'ordine
Chat **generica** (per qualsiasi ordine, non solo Implant Detector), che **resta dentro l'ordine** ed è
**visibile sia dal cliente sia dall'operatore**:
- Tabella `ordine_messaggi (order_id, autore 'cliente'|'operatore', operatore_nome, testo, media_url[], created_at, letto_cliente, letto_admin)`.
- Scrittura cliente via RPC token-based `posta_messaggio(p_token, testo, media[])` SECURITY DEFINER (come `scheda_ordine_pubblica(p_token)`).
- Bucket privato `ordini-media` (immagini) con policy anon-insert vincolata al path `<token>/…` (stessa forma di `sql/zip-ordine-privato.sql`).
- UI su **tre superfici**, stesso componente: `portale.html` (operatore da **telefono**, PWA mobile: oggi read-only → diventa scrivibile col token), `Admin_Ordini_v2.html` (operatore da **PC**), `traccia-ordine.html` (cliente → prima pagina cliente non più solo-read-only).
- **Upload immagini cross-device:** un unico `<input type="file" accept="image/*">` (senza `capture`) → su **telefono** apre Libreria foto/galleria, su **PC** apre le cartelle. Riuso della conversione `detToJpeg` (immagine → JPG leggero, max 1600px) per alleggerire le foto da smartphone. STL opzionale come lato cliente.

## 9. Produzione — **[DECISO]** — nessuna sincronizzazione con NA
**Un solo ordine per richiesta**, che contiene più abutment al suo interno (gli `items[]` di §3). Questo tipo
di ordine **NON viene caricato su NA Loading** e **NON si sincronizza con NA** (New Ancorvis non gestisce questo
tipo di ordine). Quindi: niente ordini "figli", niente STL-match, niente ID manuale, niente `forza-sync`.
La produzione dei singoli abutment è tracciata **internamente ad AC Ordini** tramite la `fase` per-item e lo
`status` dell'ordine (in_lavorazione → concluso), impostati a mano dall'operatore in Admin.
Conseguenza UI: per gli ordini `lavorazione='implant_detector'` i controlli NA-sync in Admin
(`naAutoBlock`/`naManualLink`/`forzaSync`/badge `isSyncedNA`) vanno **nascosti/disattivati**.

## 10. Prezzo — **[DECISO]** = a preventivo
Nessun calcolo automatico. Range indicativi (dal sito): analisi+geometria base €100-200; scan abutment/analogo
custom €150-300; set completo €250-500; spedizione €10-20+IVA; sconti oltre 5 pezzi.

## 11. Punti di innesto nei file
- `Configuratore_CAD_CAM_v12.html:1590` — nuova voce nell'array `LAVORAZIONI` (ramo dedicato: no STL obbligatorio, ripetizione blocco per-impianto, step spedizione, modulo accompagnamento).
- `Admin_Ordini_v2.html` — render dettaglio ordine detector (items, identificazione, componenti) + thread messaggi. Nasconde i controlli NA-sync per `lavorazione='implant_detector'`.
- `traccia-ordine.html` — vista cliente detector + thread messaggi + upload immagini.
- Nuovo SQL: `ordine_messaggi` + RPC `posta_messaggio` + bucket `ordini-media` policies.

## 12. Cosa NON si ricrea
Le pagine 2–5 del modulo cartaceo (anagrafica nuovo cliente + GDPR + consenso marketing) sono già gestite su
abutmentcompatibili.com e col `consenso_whatsapp`/registrazione esistenti. Il configuratore parte da un cliente
già identificato.

## 13. Decisioni
1. **Produzione/NA** — **[DECISO]** un ordine per richiesta con più abutment dentro; **nessuna** sync con NA (§9).
2. **Chat** — **[DECISO]** generica, dentro l'ordine, visibile da cliente e operatore (§8).
3. **Ambito v1** — **[DA CONFERMARE]** proposta: front stage completo (configuratore + intake multi-item + upload immagini + identificazione lato Admin + chat + modulo di accompagnamento). Produzione = solo avanzamento stato manuale (nessun automatismo, coerente con "nessuna sync NA").

## 14. Stato build
**[FATTO + VERIFICATO 2026-07-21] Incremento 1 — Intake nel Configuratore** (ramo isolato `implant_detector`, `Configuratore_CAD_CAM_v12.html`):
- Voce nel catalogo `LAVORAZIONI` + icona; `buildPhases` → flusso a 3 passi (lav → detector_setup → detector_items).
- Fase "La tua richiesta": tipo campioni (monconi/impronta/misto), libreria SI/NO, software CAD, lavorazione protesica.
- Fase "Cosa identificare e produrre": repeater per-impianto (descrizione, modalità identifica/produci, catalogo 9 componenti con attributi condizionali qtà/HG/incl/materiale/rhein), upload foto→JPG + STL con anteprima 3D riusando `openStlInNewWindow`.
- Helper: `detToJpeg` (canvas, max 1600px, q0.8), stato in `const detector`. Tutto in un blocco isolato dopo `buildPhases`.
- Verificato in browser (server locale): card, flusso 3 passi, tutti i campi + interazioni, toggle componenti con attributi, repeater multi-item, input file presenti, **zero errori console**. **NON deployato** (nessun push).
- Nav "Avanti → (spedizione)" **disabilitata di proposito**: è l'incremento 2.

**[FATTO + VERIFICATO 2026-07-21] Incremento 2 — Configuratore completo** (flusso a 5 passi: lav → detector_setup → detector_items → detector_ship → cliente → conferma):
- Fase `detector_ship`: "cosa inserire nel pacco" (con modulo obbligatorio) + link protocollo PDF Drive + link ritiro €10.
- Riuso fase `cliente` (aggiunto "Nome paziente" anche per detector).
- Ramo detector in `saveOrderToSupabase`: payload con `scheda_dati.detector` completo (fase, campioni_tipo, libreria, cad, lavorazione_protesica, paziente, items[] con componenti+attributi, media[].path, identificazione/esito/fase per-item), `prezzo_base:null` (preventivo), `lavorazione:"Implant Detector e Replica Impianto"`.
- `sendDetectorOrder()` (submit dedicato, un solo bottone "Invia richiesta"), `uploadDetectorMedia()` (best-effort su `ordini-media`, path `<token>/i<n>-<m>-<file>`), `makeQrDataUrl()` (import `qrcode` da esm.sh, fallback silenzioso), `printModuloDetector()` (modulo di richiesta con **codice 8hex + QR** in evidenza, MD_149/1 REV.04).
- Ramo detector in `renderConfirmScreen` (schermata "inviato" con stampa modulo + ritiro). `resetApp` azzera anche `detector`.
- **Verificato end-to-end** con `fetch` mockato (nessuna scrittura su prod): 5 fasi renderizzano, payload `scheda_dati.detector` corretto, 2 media caricati con path coerenti, QR generato (data:image), modulo con codice 788F03C4 + QR + componenti/materiali, zero errori console. **NON deployato (nessun push).**
- **Dipendenza da attivare in Supabase:** eseguire `sql/ordini-media-bucket.sql` (crea bucket privato + policy anon-insert path-scoped). Finché non girato, l'upload media fallisce best-effort (l'ordine si salva comunque).

**[FATTO + VERIFICATO 2026-07-21] Blocco B — Chat ordine** (generica per QUALSIASI ordine, dentro l'ordine, cliente + operatore):
- **SQL** `sql/chat-ordine.sql`: tabella `ordine_messaggi` (order_id, autore cliente/operatore, autore_nome, testo, media jsonb, letto_*) + RLS (authenticated=Admin) + 4 RPC SECURITY DEFINER: `chat_lista`/`chat_invia` (cliente via share_token), `chat_lista_collab`/`chat_invia_collab` (collaboratore via token+share_token; vede_tutto→autore operatore). Helper `_collab_puo_ordine`.
- **Bucket media PUBBLICO** (scelta di Francesco): `sql/ordini-media-bucket.sql` aggiornato a `public=true`, path `<share_token>/chat/<uuid>-<file>`. Display via URL diretto `/object/public/ordini-media/<path>`.
- **traccia-ordine.html** (cliente): pannello chat con bolle, foto→JPG + STL, poll 20s. **Consapevole del ruolo**: con `&c=<token>` in URL usa gli RPC collab e posta come **operatore** (label/allineamento invertiti). Verificato: vista cliente e vista operatore.
- **portale.html** (operatore da telefono): le card ordine accodano `&c=<token>` quando `vede_tutto` → aprono traccia in modalità operatore. Nessun doppione di UI. Upload immagini = `<input accept="image/*">` → galleria del telefono.
- **Admin_Ordini_v2.html** (operatore da PC): sezione "Messaggi cliente" nel dettaglio; legge/scrive `ordine_messaggi` via `sb()` (autenticato); upload media come gli altri. Verificato: nessun errore, render bolle/immagini/URL ok.

**Dipendenze da attivare in Supabase:** eseguire `sql/chat-ordine.sql` e `sql/ordini-media-bucket.sql`. **NON deployato (nessun push).**

**[FATTO + VERIFICATO 2026-07-21] Detector nel dettaglio Admin (stesso pannello di tutti gli ordini).** Gli ordini Implant Detector compaiono nella normale lista/dettaglio (`orders?select=*`). Aggiunta in `openDetail` una sezione condizionale (solo se `o.scheda_dati.detector`): mostra cosa-invia/paziente/libreria/CAD/lavorazione + per ogni impianto descrizione, modalità, componenti richiesti con attributi, e le foto/STL del cliente (URL pubblico `acMediaUrl`). Sotto, form **identificazione per impianto** (sistema, piattaforma, diametro, confidenza, esito) con `saveDetectorIdent(id)` che scrive in `scheda_dati.detector.items[].identificazione/esito` via `sb()` PATCH (stesso pattern di `saveNote`). La chat convive nello stesso dettaglio. Verificato via DOM: sezione + form + salvataggio corretti, zero errori.

**[DA FARE] Rimasto:** far avanzare le fasi per-item / avvisare il cliente all'identificazione (per ora l'operatore usa i pulsanti di stato esistenti); test reale JPG/HEIC iPhone + anteprima STL su device. E girare gli SQL su Supabase (`ordini-media-bucket.sql`, `chat-ordine.sql`) + deploy (push) quando decidi.

**Nota tecnica JPG/HEIC:** `detToJpeg` converte via `<canvas>`. Su iPhone Safari (decodifica HEIC nativa) funziona; su Chrome desktop l'HEIC non si decodifica → fallback che tiene il file originale. Da testare con foto vera.
