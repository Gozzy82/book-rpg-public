import { chromium } from 'playwright';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGameResponseCapture } from './response-capture.mjs';
import { assertPlayableResponse, assertTurnProgress, resolveAutomaticContinuations } from './progress-check.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
if (!Number.isInteger(cfg.clicksPerCharacter) || cfg.clicksPerCharacter < 1) throw Error('clicksPerCharacter moet een positief geheel getal zijn.');
if (!(cfg.turnTimeoutMs > 0)) throw Error('turnTimeoutMs moet positief zijn.');
const resumeIndex = process.argv.indexOf('--resume');
const resumeGameId = resumeIndex < 0 ? null : process.argv[resumeIndex + 1];
if (resumeIndex >= 0 && (!resumeGameId || !/^[a-zA-Z0-9_-]+$/.test(resumeGameId))) {
  throw Error('Gebruik --resume <gameId>.');
}
const output = path.join(root, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'config.json'), JSON.stringify({...cfg, resumeGameId}, null, 2));
const summary = [];
const saveSummary = () => writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
const browser = await chromium.launch({ headless: cfg.headless || process.argv.includes('--headless') });
const origin = new URL(cfg.url).origin;
async function idle(page) {
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: cfg.turnTimeoutMs });
}
async function setup(page) {
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
  await idle(page);
  await page.getByRole('button', { name: 'Start a new adventure', exact: true }).click();
  await page.getByRole('button', { name: `Start an adventure in ${cfg.bookTitle}`, exact: true }).click();
  await page.locator(cfg.selectors.character).first().waitFor();
}
let context;
try {
  context = await browser.newContext();
  const discover = await context.newPage();
  discover.setDefaultTimeout(cfg.turnTimeoutMs);
  let characters;
  try {
    if (resumeGameId) {
      const response = await context.request.get(new URL('/api/games', origin).href);
      if (!response.ok()) throw Error(`Opslaanlijst ophalen mislukt: HTTP ${response.status()}`);
      const saved = (await response.json()).find(game => game.gameId === resumeGameId);
      if (!saved) throw Error(`Opgeslagen game niet gevonden: ${resumeGameId}`);
      characters = [saved.playerName];
    } else {
      await setup(discover);
      characters = await discover.locator(cfg.selectors.characterName).allTextContents();
      characters = [...new Set(characters.map(s => s.trim()).filter(Boolean))];
      if (!characters.length) throw Error('Geen personages gevonden.');
      if (cfg.characters.length) {
        const missing = cfg.characters.filter(c => !characters.includes(c));
        if (missing.length) throw Error(`Niet gevonden: ${missing.join(', ')}`);
        characters = characters.filter(c => cfg.characters.includes(c));
      }
    }
  } catch (error) {
    await discover.screenshot({ path: path.join(output, 'setup-error.png'), fullPage: true }).catch(() => {});
    writeFileSync(path.join(output, 'setup-error.txt'), String(error.stack || error));
    throw error;
  } finally { await context.close(); context = null; }
  console.log(`Personages: ${characters.join(', ')}. ${cfg.clicksPerCharacter} keuzes per personage.`);
  for (const [index, character] of characters.entries()) {
    const dir = path.join(output, `${index + 1}-${character.replace(/[^a-z0-9_-]/gi, '_')}`);
    mkdirSync(dir, { recursive: true });
    const log = (file, data) => appendFileSync(path.join(dir, file), JSON.stringify({ time: new Date().toISOString(), ...data }) + '\n');
    const report = { character, completedClicks: 0, status: 'running', directory: path.basename(dir) };
    summary.push(report); saveSummary();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.setDefaultTimeout(cfg.turnTimeoutMs);
    let fatal = null;
    const pending = new Set();
    const seenLogs = new Set();
    const responseText = await installGameResponseCapture(page, {
      origin,
      timeout: cfg.turnTimeoutMs,
      onError: error => {
        fatal = `Game-response capture failed: ${error.message || error}`;
        log('browser.jsonl', { type: 'capture-error', message: fatal });
      },
    });
    page.on('pageerror', error => { fatal = `Browserfout: ${error.message}`; log('browser.jsonl', { type: 'pageerror', message: error.message }); });
    page.on('console', message => log('browser.jsonl', { type: message.type(), message: message.text() }));
    page.on('requestfailed', req => log('network.jsonl', { type: 'requestfailed', url: req.url(), method: req.method(), error: req.failure() }));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) return;
      const task = (async () => {
        const req = response.request();
        const body = await responseText(response).catch(() => '<response body unavailable>');
        if (url.pathname === '/api/logs') {
          try { for (const entry of JSON.parse(body)) {
            const key = JSON.stringify(entry);
            if (!seenLogs.has(key)) { seenLogs.add(key); log('server.jsonl', { entry }); }
          } } catch { log('server.jsonl', { status: response.status(), body }); }
        } else {
          log('network.jsonl', { method: req.method(), url: response.url(), status: response.status(), input: req.postData(), output: body });
        }
      })().catch(error => log('browser.jsonl', { type: 'capture-error', message: String(error) }));
      pending.add(task); task.finally(() => pending.delete(task));
    });
    async function submit(button, pathnameOrMatcher) {
      const matchesPath = typeof pathnameOrMatcher === 'function'
        ? pathnameOrMatcher
        : pathname => pathname === pathnameOrMatcher;
      const [response] = await Promise.all([
        page.waitForResponse(r => {
          const url = new URL(r.url());
          return url.origin === origin && matchesPath(url.pathname) && r.request().method() === 'POST';
        }, { timeout: cfg.turnTimeoutMs }),
        button.click()
      ]);
      const body = await responseText(response);
      if (!response.ok()) throw Error(`HTTP ${response.status()}: ${body}`);
      const result = JSON.parse(body);
      await idle(page);
      if (fatal) throw Error(fatal);
      const alerts = await page.locator('[role="alert"]:visible').allTextContents();
      if (alerts.length) throw Error(alerts.join('\n'));
      return result;
    }
    async function resolveConversation(step, result) {
      let replyIndex = 0;
      const gamePrefix = `/api/games/${encodeURIComponent(report.gameId)}/`;
      while (await page.locator('.conversation-panel').isVisible()) {
        replyIndex += 1;
        if (replyIndex > 10) throw Error('Gesprek bleef na 10 keer gesprek-optie 1 actief.');
        const reply = page.locator('.conversation-panel .suggestion-button').first();
        if (await reply.count() === 0) throw Error('Gesprek heeft geen gesprek-optie 1.');
        const chosen = await reply.innerText();
        log('flow.jsonl', { step, conversationReply: replyIndex, action: 'select-conversation-option-1', chosen });
        appendFileSync(path.join(dir, 'flow.md'), `\n### Klik ${step}: gesprek-optie 1.${replyIndex}\n\n${chosen}\n`);
        result = await submit(
          reply,
          pathname => pathname.startsWith(gamePrefix) && pathname !== `${gamePrefix}choices`,
        );
      }
      return result;
    }
    async function resolveAutomatic(step, result) {
      return resolveAutomaticContinuations(result, async (_previous, hop) => {
        console.log(`${character}: automatisch vervolg ${hop} na ${step} keuzes`);
        log('flow.jsonl', { step, automaticHop: hop, action: 'continue-automatic-source' });
        const choice = page.locator(cfg.selectors.choice).first();
        const next = await submit(choice,
          `/api/games/${encodeURIComponent(report.gameId)}/choices`);
        await snapshot(`${step}-auto-${hop}`, next);
        return next;
      });
    }
    async function snapshot(step, result) {
      const text = await page.locator('body').innerText();
      writeFileSync(path.join(dir, `screen-${String(step).padStart(2, '0')}.txt`), text);
      log('flow.jsonl', { step, result });
      appendFileSync(path.join(dir, 'flow.md'), `\n## Na ${step} keuzes\n\n${result.scene?.title || ''}\n\n${result.scene?.text || text}\n\nKeuzes:\n${(result.scene?.choices || []).map((c, i) => `${i + 1}. ${c.text}`).join('\n')}\n`);
    }
    try {
      let result;
      if (resumeGameId) {
        console.log(`\nHervat ${character}: ${resumeGameId}`);
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
        await idle(page);
        const card = page.locator(`.journey-card[data-game-id="${resumeGameId}"]`);
        if (await card.count() !== 1) throw Error('De opgeslagen game is niet beschikbaar als hervatbare game in de UI.');
        result = await submit(card, `/api/games/${encodeURIComponent(resumeGameId)}/resume`);
        if (result.gameId !== resumeGameId) throw Error('Hervatten gaf een andere game terug.');
        report.resumed = true;
        report.startingTurnNumber = result.turnNumber ?? result.turnHistory?.at(-1)?.turnNumber ?? null;
      } else {
        console.log(`\nStart ${character}`);
        await setup(page);
        // Filter via the exact name element, avoiding initials and similarly named characters.
        const option = page.locator(cfg.selectors.character).filter({ has: page.getByText(character, { exact: true }) });
        await option.click();
        result = await submit(page.getByRole('button', { name: 'Start my story', exact: true }), '/api/games');
      }
      report.gameId = result.gameId;
      if (!report.gameId) throw Error('Antwoord bevat geen gameId.');
      saveSummary();
      result = await resolveConversation(0, result);
      await snapshot(0, result);
      result = await resolveAutomatic(0, result);
      assertPlayableResponse(result);
      let previous = result;
      for (let step = 1; step <= cfg.clicksPerCharacter; step++) {
        if (await page.locator('.outcome-panel').isVisible()) { report.status = 'ended'; break; }
        const choices = page.locator(cfg.selectors.choice);
        const firstChoice = choices.first();
        if (await firstChoice.count() === 0) throw Error('Geen optie 1 beschikbaar.');

        const firstChoiceType = (await firstChoice.locator('small').first().textContent().catch(() => ''))?.trim().toLowerCase();
        const skipConversation = firstChoiceType === 'conversation';
        const choiceIndex = skipConversation ? 1 : 0;
        const choice = choices.nth(choiceIndex);

        if (await choice.count() === 0) {
          throw Error(skipConversation
            ? 'Optie 1 is CONVERSATION, maar optie 2 ontbreekt.'
            : 'Geen optie 1 beschikbaar.');
        }

        const chosen = await choice.innerText();
        const optionNumber = choiceIndex + 1;
        log('flow.jsonl', {
          step,
          action: `select-option-${optionNumber}`,
          skippedConversationOption1: skipConversation,
          chosen
        });
        appendFileSync(path.join(dir, 'flow.md'), `\n### Klik ${step}: optie ${optionNumber}${skipConversation ? ' (optie 1 was CONVERSATION)' : ''}\n\n${chosen}\n`);
        result = await submit(choice, `/api/games/${encodeURIComponent(report.gameId)}/choices`);
        result = await resolveConversation(step, result);
        await snapshot(step, result);
        assertTurnProgress(previous, result, { allowAutomatic: true });
        result = await resolveAutomatic(step, result);
        report.completedClicks = step;
        saveSummary();
        console.log(`${character}: ${step}/${cfg.clicksPerCharacter}`);
        previous = result;
        if (await page.locator('.outcome-panel').isVisible()) { report.status = 'ended'; break; }
      }
      if (report.status === 'running') report.status = 'passed';
    } catch (error) {
      report.status = 'failed'; report.error = String(error.stack || error);
      writeFileSync(path.join(dir, 'error.txt'), report.error);
      await page.screenshot({ path: path.join(dir, 'error.png'), fullPage: true }).catch(() => {});
      await page.locator('body').innerText().then(text => writeFileSync(path.join(dir, 'error-screen.txt'), text)).catch(() => {});
      console.error(`${character}: ${error.message}`);
    } finally {
      await Promise.allSettled([...pending]);
      await context.tracing.stop({ path: path.join(dir, 'trace.zip') }).catch(error => { report.traceError = String(error); });
      await context.close(); context = null; saveSummary();
    }
  }
} finally {
  if (context) await context.close();
  await browser.close();
  console.log(`\nResultaten: ${output}`);
}
if (summary.some(r => r.status === 'failed')) process.exitCode = 1;