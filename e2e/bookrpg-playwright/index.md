# Playwright-test uitvoeren

Start BookRPG in een aparte terminal en laat de server draaien op http://127.0.0.1:8787/.

Open daarna PowerShell in de projectmap:

```powershell
cd e2e/bookrpg-playwright
npm.cmd ci
npx.cmd playwright install chromium
npm.cmd start
```

Gebruik je de losse zip? Pak die uit en open PowerShell in de map met package.json; sla dan het cd-commando over.

Het script kiest Wizard of Oz en start voor ieder getoond personage een nieuw spel. Het klikt per personage het ingestelde aantal keren direct op optie 1 en wacht steeds op het volgende scherm. Er is geen aparte Continue-knop meer. Als optie 1 een gesprek is, kiest het script de volgende optie. Bij een fout bewaart het de diagnose en gaat verder met het volgende personage.

Pas config.json aan voor een ander adres, aantal keuzes of bijvoorbeeld `"characters": ["Scarecrow"]`. Leeg (`[]`) betekent alle getoonde personages.

Resultaten staan onder `results/<datum>/`. Begin met `summary.json`. Per personage vind je `flow.md`, API- en serverlogs en `trace.zip`. Bij fouten komen daar `error.txt` en `error.png` bij.

```powershell
npx.cmd playwright show-trace "results\DATUM\1-Dorothy\trace.zip"
```

Ctrl+C stopt de run. Iedere run maakt nieuwe opgeslagen spellen en gebruikt de normale AI-aanroepen van BookRPG. Inhoudelijke verhaalproblemen worden vastgelegd, maar niet automatisch door AI beoordeeld.

## Bediening testen zonder AI

Vanuit deze map binnen de volledige repository (niet de losse zip):

```powershell
node --test ui-controls.test.mjs
```

Deze regressietests gebruiken de echte webinterface in Chromium met een nagebootste API. Ze controleren direct klikken, toetsenbordbediening, dubbele verzending, lege en te lange tekst, gescheiden custom actions/world events, wereldregels zonder verhaalbeurt, foutafhandeling en herstel. Ze gebruiken geen AI-tokens, geen echte accounts en geen opgeslagen spellen. Chromium moet wel geinstalleerd zijn via het bovenstaande Playwright-commando. `npm.cmd test` voert deze tests samen met de andere lokale E2E-hulptests uit.

Voor een afgeschermde testomgeving die zelfs lokale browsernavigatie blokkeert, ondersteunt dezelfde test `BOOKRPG_UI_IN_MEMORY=1`. Die modus laadt de app en wereldregelmodule in het geheugen en vervangt alleen transport en de module-URL. Hij controleert bediening, maar niet de volledige stylesheetweergave, HTTP-assetlevering of Content Security Policy. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` kan naar een reeds geinstalleerde Chromium-binary wijzen.

Een geslaagde bedieningstest bewijst niet dat echte AI-scenes inhoudelijk correct zijn. Gebruik daarvoor de gewone speelrun hierboven. De serverroutes voor webbestanden hebben daarnaast regressietests in `test/web-controls-assets.test.ts`.

Zie [README.md](README.md) voor alle instellingen, foutdetectie, beperkingen en uitleg over logs.
