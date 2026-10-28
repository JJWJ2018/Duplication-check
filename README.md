# Duplicate check — Assets 10 panel-plugin

Prototype. Laat bij geselecteerde (of net geüploade) bestanden zien of ze al ergens in
Assets staan. Aanleiding: verzoek van Coop via A&F (Zendesk #269529): "na de upload een
melding dat in map XY al een bestand staat met dezelfde checksum en/of dezelfde
opnamedatum + tijd". Alleen handmatige uploads: de check draait alleen als een gebruiker
zelf bestanden selecteert of uploadt.

Statische plugin (geen build-stap): `index.html` + `config.js` + `icon.png`.
SDK: `@woodwing/a10-client-sdk@1.0.4`.

## Wat het doet
- **Selectie:** per geselecteerd bestand (max 20) zoekt het paneel naar
  1. hetzelfde bestand: zelfde `firstExtractedChecksum` (checksum van het bestand zoals
     de gebruiker het uploadde) → label *Identical file*;
  2. dezelfde opnamedatum + tijd (tot op de seconde) → label *Same capture time*.
     Vangt opnieuw geëxporteerde of verkleinde kopieën, die een andere checksum hebben.
- Toont per bestand: geen duplicaten (groen), mogelijke duplicaten met map en
  miniatuur (oranje), of "kan niet controleren" als checksum en datum ontbreken.
- Klik op een treffer → opent die in Assets. "Open all side by side" opent origineel +
  treffers samen.
- **Na upload:** als de host meldt dat een upload klaar is, controleert het paneel de
  nieuwste bestanden van de huidige gebruiker automatisch (zie "te verifiëren").

## Bestanden
- `index.html` — UI + SDK-koppeling. `?demo=1` draait met voorbeelddata, zonder Assets.
- `config.js` — veldnamen en opties. **Controleer de veldnamen.**
- `icon.png` — 20×20 icoon.

## Te verifiëren in een echte Assets 10-omgeving
1. **Checksum gevuld?** Open een recente foto, kijk of `firstExtractedChecksum` een
   waarde heeft (verwacht `sha1:…`, zie SVL-1655). Ook een oude asset checken.
2. **Veld voor opnamedatum.** `config.js` probeert `created`, `dateCreated`,
   `contentCreated`, `dateTimeOriginal`. Zet het juiste veld vooraan.
3. **Datumzoekopdracht.** Het paneel zoekt met `<veld>:[jjjj-mm-dd TO jjjj-mm-dd]`
   (dag ervoor t/m dag erna) en filtert daarna op exacte seconde. Controleer of
   Assets 10 deze range-syntax accepteert.
4. **Zoekt de selectie alle metadata mee?** Zo niet, haalt het paneel de asset nog
   een keer op met `id:"…"`. Werkt dat?
5. **Na-upload-check.** Hangt af van (a) of `onUploadProgress` ook uploads via de
   gewone upload-knop doorgeeft, en (b) welk veld de gebruikersnaam bevat in
   `getPluginContext().app.userProfile` (nu: `username`, `userName` of `name`) en of
   `assetCreator` daarop matcht. Werkt het niet, dan toont het paneel alleen
   "selecteer de nieuwe bestanden". Uitzetten: `AUTO_CHECK_AFTER_UPLOAD: false`.

## Achterkant: automatisch signaleren (`api/webhook.js`)
Werkt zonder dat iemand het paneel opent. Assets stuurt bij elke nieuwe asset een
webhook; de functie zoekt duplicaten en:
1. zet op de nieuwe asset `cf_duplicateCheck` = *Possible duplicate* of *No duplicates
   found*, en bij treffers `cf_possibleDuplicateOf` = lijst met map, naam, reden en ID;
2. stuurt bij treffers optioneel een mail (via resend.com) en/of chatbericht.
Een opgeslagen zoekopdracht `cf_duplicateCheck:"Possible duplicate"` is daarmee de
werklijst voor de beeldredactie.

Alleen handmatige uploads: zet serviceaccounts en importgebruikers in
`IGNORE_CREATORS`, en/of beperk met `ONLY_FOLDERS` / `IGNORE_FOLDERS`.

### Inrichten
1. **Custom fields** (Management Console → Metadata): `cf_duplicateCheck` (tekst) en
   `cf_possibleDuplicateOf` (tekst, multi-value). Andere namen kan, via env-vars.
2. **API-key** (Management Console → API).
3. **Vercel env-vars:** `ASSETS_API_BASE`, `ASSETS_API_KEY`, `WEBHOOK_SECRET`, plus
   optioneel `IGNORE_CREATORS`, `CAPTURE_DATE_FIELD`, `RESEND_API_KEY` + `MAIL_FROM` +
   `MAIL_TO`, `CHAT_WEBHOOK_URL`, `ASSET_LINK_TEMPLATE`. Alles staat bovenin
   `api/webhook.js`.
4. **Webhook** (Management Console → Webhooks): URL `https://<vercel-url>/api/webhook`,
   events: het aanmaken van een asset én metadata-wijzigingen (de checksum is bij het
   eerste event mogelijk nog niet berekend). Kopieer het secret naar `WEBHOOK_SECRET`.
5. Test: open `https://<vercel-url>/api/webhook` in de browser → `{"ok":true,…}`.
   Upload daarna een foto die al bestaat en kijk naar de twee velden.

### Te verifiëren (achterkant)
- **Metadata schrijven.** De functie gebruikt `POST /services/update` (Elvis-stijl,
  `id` + `metadata` als JSON). Of Assets 10 dit via de API-key ondersteunt, heb ik niet
  kunnen bevestigen. Werkt het niet: zet het juiste pad in `UPDATE_ENDPOINT`, of zet
  `WRITE_METADATA=false` en gebruik alleen mail/chat.
- **Payload.** De event-namen en het exacte payload-formaat staan in de Management
  Console. De functie zoekt het asset-ID in `assetId`, `asset.id`, `id` of `data.*`.
- **Timing.** Assets wacht max. 5 seconden en probeert het daarna opnieuw (max. 3×).
  De functie doet 3–4 API-calls; dat zou moeten passen. Dubbel verwerken wordt
  voorkomen doordat het vlagveld al gevuld is.
- **Checksum later berekend?** Als de checksum pas na het aanmaken komt en er daarna
  geen metadata-event volgt, wordt de asset niet gecontroleerd.

### Lokaal getest
Met een nagebootste Assets-API: verkeerde handtekening → 400; nieuw duplicaat → velden
gezet + chatbericht; tweede event → overgeslagen; serviceaccount → overgeslagen.

## Bekende beperkingen
- Het paneel meldt alleen iets als het open staat; de achterkant (hierboven) vangt dat op.
- `search()` respecteert `num` niet altijd (zie sdk-verbeterpunten.md); het paneel
  knipt zelf af.
- Datum zonder tijd (00:00:00) wordt genegeerd, anders geeft "zelfde dag" te veel
  treffers. Instelbaar met `REQUIRE_TIME_PART`.
- Fotoseries met hetzelfde tijdstip op de seconde (burst) kunnen als "mogelijk
  duplicaat" verschijnen. Daarom staat er "possible".

## Hosten en configureren
Zelfde als de andere plugins: GitHub-repo → Vercel (preset *Other*, geen build).
Management Console → Plug-ins → **Panel plug-ins** → `+`:
- **Name / tooltip:** `Duplicate check`
- **URL:** de Vercel-URL
- **Icon:** `icon.png`
- **Enable** → Save, daarna rechten per usergroup.
