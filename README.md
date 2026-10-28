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

## Bekende beperkingen
- Melding alleen als het paneel open staat. Een mail naar de beeldredactie vraagt
  een webhook + klein serverless script (niet in dit prototype).
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
