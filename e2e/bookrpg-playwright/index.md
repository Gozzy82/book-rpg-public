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

Het script kiest Wizard of Oz en start voor ieder getoond personage een nieuw spel. Het klikt per personage 20 keer optie 1 gevolgd door Continue, en wacht steeds op het volgende scherm. Bij een fout bewaart het de diagnose en gaat verder met het volgende personage.

Pas config.json aan voor een ander adres, aantal keuzes of bijvoorbeeld `"characters": ["Scarecrow"]`. Leeg (`[]`) betekent alle getoonde personages.

Resultaten staan onder `results/<datum>/`. Begin met `summary.json`. Per personage vind je `flow.md`, API- en serverlogs en `trace.zip`. Bij fouten komen daar `error.txt` en `error.png` bij.

```powershell
npx.cmd playwright show-trace "results\DATUM\1-Dorothy\trace.zip"
```

Ctrl+C stopt de run. Iedere run maakt nieuwe opgeslagen spellen en gebruikt de normale AI-aanroepen van BookRPG. Inhoudelijke verhaalproblemen worden vastgelegd, maar niet automatisch door AI beoordeeld.

Zie [README.md](README.md) voor alle instellingen, foutdetectie, beperkingen en uitleg over logs.
