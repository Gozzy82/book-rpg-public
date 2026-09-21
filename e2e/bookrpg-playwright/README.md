# BookRPG Playwright endurance test

Deze runner speelt de huidige BookRPG-webinterface automatisch door en verzamelt
per personage genoeg informatie om een vastloper, herhaling of inhoudelijke fout
achteraf te analyseren.

## Uitvoeren op Windows

Start BookRPG eerst in een aparte terminal en controleer dat
`http://127.0.0.1:8787/` opent.

Ga daarna vanuit de repository naar de Playwright-map:

```powershell
cd e2e/bookrpg-playwright
npm.cmd install
npx.cmd playwright install chromium
npm.cmd start
```

Gebruik voor een onzichtbare browser:

```powershell
npm.cmd run headless
```

De `.cmd`-varianten vermijden PowerShell-problemen met `npm.ps1`. In cmd/bash
kunnen gewone `npm`/`npx` commando's worden gebruikt.

## Een opgeslagen game hervatten

Gebruik het gameId uit de vorige `summary.json` of de naam van het game-log:

```powershell
npm.cmd start -- --resume game_a2cbe9b2d03e4ad09cc1ce97267c9cee
```

Dit opent precies die bestaande game via de hervatknop in de UI. Het start geen
nieuwe game en negeert voor deze run de personage- en boekselectie uit config.
`clicksPerCharacter` bepaalt het aantal **extra** keuzes vanaf de opgeslagen
situatie. Automatische vervolgen en gesprekken worden zoals gewoonlijk verwerkt.
De bestaande game wordt verder opgeslagen; dit maakt geen kopie. Nieuwe testlogs
komen in een nieuwe results-map. De summary vermeldt het gameId, `resumed` en
`startingTurnNumber`. Een ontbrekende of niet-hervatbare game geeft een fout;
de runner valt niet terug op een nieuw spel.

Herstart na een code-update ook de BookRPG-server voordat je hervat.

## Wat doet de test?

De runner:

1. opent de BookRPG-homepage;
2. kiest **Start a new adventure**;
3. kiest het boek uit `config.json`;
4. leest de beschikbare personages uit de actuele UI;
5. start voor ieder geselecteerd personage een nieuw spel;
6. voert standaard 20 scènekeuzes uit;
7. verzamelt browser-, netwerk-, server- en gameplay-output;
8. bewaart per personage een Playwright trace.

`characters: []` betekent: test alle personages die de UI op dat moment toont.
Je kunt bijvoorbeeld alleen Scarecrow draaien met:

```json
{
  "characters": ["Scarecrow"]
}
```

De normale BookRPG-server voert alle AI-calls uit. De Playwright-runner heeft dus
geen aparte AI-key nodig, maar live runs gebruiken wel dezelfde provider/kosten
als de server.

## Keuzegedrag

De test is bedoeld om lange story-runs te maken, niet om expres in een gesprek te
blijven hangen.

Per scène:

- normaal wordt optie 1 gekozen;
- als optie 1 het type `CONVERSATION` heeft, kiest de runner optie 2;
- ontbreekt die optie 2, dan faalt de run met een duidelijke melding;
- na **Continue** wacht de runner op het `/choices`-antwoord en totdat de app weer
  idle is.

Als een ingediende beurt toch een gesprek opent, kiest de runner gesprek-optie 1
totdat er weer een normale scène staat. Na 10 opeenvolgende gesprek-antwoorden
wordt dit als vastloper gemeld.

Hierdoor telt `clicksPerCharacter` het aantal gewone ingediende scènekeuzes. De
extra dialoogantwoorden worden apart gelogd.

Game-POST-antwoorden worden via Playwright opgehaald en vóór aflevering aan de
browser bewaard. Zo gebruiken de runner en `network.jsonl` hetzelfde echte
serverantwoord, ook als Chromium zijn inspectiecache opruimt. HTTP-fouten blijven
fouten; een ingediende beurt wordt nooit opnieuw verstuurd om een ontbrekend
antwoord te herstellen. Service workers staan voor deze capture uit.

De capture-regressietests uitvoeren (zonder draaiende BookRPG-server):

```powershell
node --test response-capture.test.mjs
```

## Configuratie

`config.json` bevat onder andere:

- `url`: BookRPG-server, standaard `http://127.0.0.1:8787/`;
- `bookTitle`: te kiezen boek;
- `clicksPerCharacter`: standaard `20`;
- `characters`: leeg voor alle zichtbare startpersonages;
- `turnTimeoutMs`: maximale wachttijd per netwerk/UI-stap;
- `headless`: zonder zichtbaar browservenster draaien;
- `selectors`: alleen aanpassen wanneer de frontendmarkup verandert.

## Resultaten

Elke run krijgt een timestamp-map onder:

```text
results/<timestamp>/
```

`summary.json` bevat per personage onder andere `gameId`, aantal voltooide
keuzes, status en eventuele fout.

Per personage worden onder andere geschreven:

- `flow.md` — leesbaar verloop van scènes, gekozen opties en dialoogkeuzes;
- `flow.jsonl` — gestructureerde start-/beurtresultaten;
- `network.jsonl` — API requests/responses en HTTP-status;
- `server.jsonl` — serverlogs die via de webapp beschikbaar komen;
- `browser.jsonl` — browserconsole en JavaScript-fouten;
- `screen-00.txt`, `screen-01.txt`, ... — zichtbare schermtekst per stap;
- `error.txt`, `error-screen.txt`, `error.png` — foutinformatie;
- `trace.zip` — Playwright browsertrace.

Een trace openen:

```powershell
npx.cmd playwright show-trace "results\<timestamp>\1-Dorothy\trace.zip"
```

## Statussen

- `passed`: het geconfigureerde aantal scènekeuzes is uitgevoerd;
- `ended`: BookRPG bereikte eerder een eindscherm;
- `failed`: technische fout, timeout, ontbrekende keuze, lege scène, exacte
  scènetekstherhaling of een gesprek dat niet terugkeert naar een scène.

`passed` betekent niet automatisch dat het verhaal semantisch correct is. De
runner detecteert bijvoorbeeld niet zelfstandig een verkeerde actor, verkeerde
beatvolgorde of subtiele perspectieffout. Daarvoor zijn de verzamelde BookRPG
flowlogs bedoeld.

## Complete backendflow verzamelen

`server.jsonl` is geen volledige terminalcapture. De BookRPG-server schrijft bij
`BOOKRPG_FLOW_LOG=true` een veel completere trace naar:

```text
<BOOKRPG_DATA_DIR>/logs/games/<gameId>.log
```

Voor een inhoudelijke fout zijn meestal deze twee bronnen samen het nuttigst:

1. de Playwright personage-map (`flow.md`, `network.jsonl`, `trace.zip`, enz.);
2. het bijbehorende BookRPG per-game flowlog.

Je kunt daarnaast de volledige serversessie tee'en:

```powershell
npm.cmd run dev 2>&1 | Tee-Object -FilePath server-session.log
```

Resultaten en flowlogs kunnen boektekst, prompts, game state en modeloutput
bevatten. Controleer ze voordat je ze openbaar deelt.

