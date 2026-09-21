import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Actual production HTML/modules; only the API is mocked. No model calls,
// imported book, user account, or running BookRPG server are needed.
const publicRoot = new URL('../../public/', import.meta.url);
const inMemory = process.env.BOOKRPG_UI_IN_MEMORY === '1';
let browser;
const origin = 'https://bookrpg.test';
const anchor = '__bookrpg_source_anchor__';
const continuation = '__bookrpg_source_continuation__';
const book = { bookId: 'test-book', title: 'The Test Adventure', author: 'Test Author' };
const initialGame = () => ({
  gameId: 'game_ui', book, playerName: 'Hero', status: 'active',
  objective: 'Find the gate', victoryCondition: 'Reach the gate', gameProfile: {}, turnHistory: [],
  scene: { title: 'At the gate', text: 'I stand before a closed gate.', outcome: 'active', choices: [
    { id: anchor, text: 'Open the gate', type: 'action' },
    { id: 'look', text: 'Look around', type: 'action' },
    { id: 'talk', text: 'Talk to Guide', type: 'talk', character: 'Guide' },
  ] },
});

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
});
after(async () => {
  await browser?.close();
});

async function fixture(t, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No browser JavaScript errors'));
  const f = { page, game: initialGame(), rules: options.rules || [], calls: [], failNext: false,
    failMembership: false, failRuleLoad: options.failRuleLoad || false, release: null };
  if (options.choices) f.game.scene.choices = options.choices;
  if (options.ended) { f.game.status = 'completed'; f.game.scene.outcome = 'completed'; }
  f.holdNext = () => { f.gate = new Promise(resolve => { f.release = resolve; }); };
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[\w.-]+$/.test(filename)) return route.fulfill({ status: 404, body: '' });
    try {
      const body = await readFile(new URL(filename, publicRoot));
      const contentType = filename.endsWith('.js') ? 'text/javascript'
        : filename.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ body, contentType });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  async function api(method, path, body) {
    path = new URL(path, origin).pathname;
    const respond = (value, status = 200) => ({ status, body: structuredClone(value) });
    if (path === '/api/logs') return respond([]);
    if (path === '/api/me') return f.failMembership ? respond({ error: 'Account unavailable' }, 503)
      : respond({ provider: 'local', membership: { plan: 'unlimited' } });
    if (path === '/api/books') return respond([]);
    if (path === '/api/games') return respond([{ ...f.game, status: 'active', updatedAt: '2026-01-01T00:00:00Z', sceneTitle: f.game.scene.title }]);
    if (path.endsWith('/resume')) return respond(f.game);
    if (path.endsWith('/world-rules') && method === 'GET') {
      return f.failRuleLoad ? respond({ error: 'Rules unavailable' }, 503)
        : respond({ gameId: f.game.gameId, worldRules: f.rules });
    }
    f.calls.push({ method, path, body });
    if (f.gate) { const gate = f.gate; f.gate = null; await gate; }
    if (f.failNext) { f.failNext = false; return respond({ error: 'Try this action again' }, 400); }
    if (path.includes('/world-rules')) {
      if (method === 'POST') f.rules.push(body.text);
      if (method === 'DELETE') f.rules.splice(Number(path.split('/').at(-1)), 1);
      return respond({ gameId: f.game.gameId, worldRules: f.rules });
    }
    if (path.endsWith('/choices') && body.choiceId === 'talk') {
      return respond({ character: 'Guide', prompt: 'What brings you here?', suggestions: ['I need directions.'] });
    }
    f.game = { ...f.game, scene: { ...f.game.scene, title: `Updated scene ${f.calls.length}` } };
    return respond(f.game);
  }
  if (inMemory) {
    // Restricted runners may disallow browser navigation, even to localhost.
    // Keep the same app/controller code; replace only transport and module URL.
    await page.exposeFunction('bookrpgTestRequest', api);
    await page.evaluate(() => {
      window.fetch = async (url, init = {}) => {
        const result = await window.bookrpgTestRequest(init.method || 'GET', String(url),
          init.body ? JSON.parse(init.body) : null);
        return new Response(JSON.stringify(result.body), { status: result.status,
          headers: { 'content-type': 'application/json' } });
      };
    });
    const html = (await readFile(new URL('index.html', publicRoot), 'utf8'))
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
    await page.setContent(html);
    await page.addStyleTag({ content: await readFile(new URL('turn-controls.css', publicRoot), 'utf8') });
    const rulesSource = await readFile(new URL('world-rules.js', publicRoot), 'utf8');
    const rulesUrl = `data:text/javascript;base64,${Buffer.from(rulesSource).toString('base64')}`;
    const appSource = (await readFile(new URL('app.js', publicRoot), 'utf8'))
      .replace('"./world-rules.js"', JSON.stringify(rulesUrl));
    await page.addScriptTag({ type: 'module', content: appSource });
  } else {
    await page.route('**/api/**', async route => {
      const req = route.request();
      const result = await api(req.method(), new URL(req.url()).pathname, req.postDataJSON());
      await route.fulfill({ status: result.status, json: result.body });
    });
    await page.goto(origin);
  }
  await idle(page);
  await page.locator('.journey-card').click();
  await page.locator('.game-main').waitFor();
  await idle(page);
  return f;
}
const idle = page => page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function submit(f, name) {
  await button(f.page, name).click();
  await idle(f.page);
}
async function forceSubmit(page, selector) {
  await page.locator(selector).evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

for (const id of [anchor, continuation, 'look']) {
  test(`one click directly submits ${id}; no Continue button`, async t => {
    const f = await fixture(t, { choices: [{ id, text: 'Go forward', type: 'action' }] });
    assert.equal(await button(f.page, 'Continue').count(), 0);

    await f.page.locator('.choice-button').click();
    await idle(f.page);
    assert.deepEqual(f.calls, [{ method: 'POST', path: '/api/games/game_ui/choices', body: { choiceId: id } }]);
    assert.match(await f.page.locator('.scene-heading h1').innerText(), /Updated scene/);
  });
}

test('keyboard activation, double-click lock, and detached stale choice cannot submit twice', async t => {
  const f = await fixture(t);
  await f.page.locator('.choice-button').first().evaluate(el => { window.oldChoice = el; el.focus(); });
  f.holdNext();
  await f.page.keyboard.press('Enter');
  await f.page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'true');
  assert.equal(await f.page.locator('.choice-button:not(:disabled)').count(), 0);
  assert.equal(await f.page.locator('.action-dock button:not(:disabled)').count(), 0);
  assert.equal(await button(f.page, 'Return to the library').isDisabled(), true);
  await f.page.evaluate(() => { window.oldChoice.click(); window.oldChoice.click(); });
  assert.equal(f.calls.length, 1);
  f.release(); await idle(f.page);
  await f.page.evaluate(() => window.oldChoice.click());
  assert.equal(f.calls.length, 1, 'An old button cannot submit a repeated anchor ID on the new scene');
});

test('custom action: empty/whitespace/oversized input blocked, then direct free-action POST', async t => {
  const f = await fixture(t);
  await button(f.page, 'Custom action').click();
  const input = f.page.locator('#custom-turn-text');
  assert.equal(await button(f.page, 'Take this action').isDisabled(), true);
  assert.equal(await input.getAttribute('maxlength'), '1000');
  await input.fill('   ');
  await forceSubmit(f.page, '.composer-form');
  assert.equal(f.calls.length, 0);
  await input.evaluate(el => { el.value = 'x'.repeat(1001); el.dispatchEvent(new Event('input')); });
  assert.equal(await button(f.page, 'Take this action').isDisabled(), true);
  await forceSubmit(f.page, '.composer-form');
  assert.equal(f.calls.length, 0);
  await input.fill('  I inspect the gate.  ');
  assert.equal(await f.page.locator('.choice-button:not(:disabled)').count(), 0);
  await submit(f, 'Take this action');
  assert.deepEqual(f.calls[0].body, { choiceId: '__bookrpg_free_action__', actionText: 'I inspect the gate.' });
  assert.equal(await f.page.locator('#custom-turn').count(), 0);
});

test('named modes keep separate drafts; cancel sends nothing; world event uses /events', async t => {
  const f = await fixture(t);
  await button(f.page, 'Custom action').click();
  await f.page.locator('#custom-turn-text').fill('I open the gate.');
  await button(f.page, 'World event').click();
  assert.equal(await f.page.locator('#custom-turn-text').inputValue(), '');
  assert.equal(await button(f.page, 'Apply world event').isDisabled(), true);
  await f.page.locator('#custom-turn-text').fill('A storm approaches.');
  await button(f.page, 'Cancel').click();
  assert.equal(f.calls.length, 0);
  await button(f.page, 'Custom action').click();
  assert.equal(await f.page.locator('#custom-turn-text').inputValue(), 'I open the gate.');
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('#custom-turn').count(), 0);
  await button(f.page, 'World event').click();
  assert.equal(await f.page.locator('#custom-turn-text').inputValue(), 'A storm approaches.');
  await submit(f, 'Apply world event');
  assert.deepEqual(f.calls, [{ method: 'POST', path: '/api/games/game_ui/events', body: { text: 'A storm approaches.' } }]);
});

test('failed custom request keeps text; busy Escape cannot close editor or send again', async t => {
  const f = await fixture(t);
  await button(f.page, 'Custom action').click();
  await f.page.locator('#custom-turn-text').fill('I open the gate.');
  f.holdNext(); f.failNext = true;
  await button(f.page, 'Take this action').click();
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('#custom-turn').count(), 1);
  await forceSubmit(f.page, '.composer-form');
  assert.equal(f.calls.length, 1);
  f.release(); await idle(f.page);
  assert.equal(await f.page.locator('#custom-turn-text').inputValue(), 'I open the gate.');
  assert.equal(await f.page.locator('#custom-turn-error').innerText(), 'Try this action again');
  assert.equal(await button(f.page, 'Take this action').isDisabled(), false);
  await submit(f, 'Take this action');
  assert.equal(f.calls.length, 2);
});

test('successful turn is applied even when secondary membership refresh fails', async t => {
  const f = await fixture(t);
  f.failMembership = true;

  await f.page.locator('.choice-button').first().click();
  await idle(f.page);
  assert.equal(await f.page.locator('.scene-heading h1').innerText(), 'Updated scene 1');
  assert.equal(f.calls.length, 1);
  assert.match(await f.page.locator('#toast-region').innerText(), /action succeeded/);
});

test('world rules save separately without a turn; empty rules blocked; deletion confirmed', async t => {
  const f = await fixture(t, { rules: ['It is always spring.'] });
  await button(f.page, 'World rules').click();
  await f.page.locator('#new-world-rule').waitFor();
  assert.equal(await button(f.page, 'Save world rule').isDisabled(), true);
  await f.page.locator('#new-world-rule').fill('  ');
  await forceSubmit(f.page, '.world-rule-add');
  assert.equal(f.calls.length, 0);
  await f.page.locator('#new-world-rule').fill('No one can lie.');
  await submit(f, 'Save world rule');
  assert.equal(f.calls[0].path, '/api/games/game_ui/world-rules');
  assert.equal(await f.page.locator('.scene-heading h1').innerText(), 'At the gate');
  assert.equal(await f.page.locator('.choice-button:not(:disabled)').count(), 0);
  await f.page.getByRole('button', { name: 'Remove world rule: It is always spring.', exact: true }).click();
  assert.equal(f.calls.length, 1, 'Remove alone only asks for confirmation');
  await button(f.page, 'Keep rule').click();
  assert.equal(f.calls.length, 1);
  await f.page.getByRole('button', { name: 'Remove world rule: It is always spring.', exact: true }).click();
  await submit(f, 'Confirm removal');
  assert.deepEqual(f.calls[1], { method: 'DELETE', path: '/api/games/game_ui/world-rules/0', body: null });
  await button(f.page, 'Close world rules').click();
  assert.equal(await f.page.locator('.choice-button:not(:disabled)').count(), 3);
});

test('world rule mutation shares turn lock and preserves draft on error', async t => {
  const f = await fixture(t);
  await button(f.page, 'World rules').click();
  await f.page.locator('#new-world-rule').fill('No one can lie.');
  f.holdNext(); f.failNext = true;
  await button(f.page, 'Save world rule').click();
  await forceSubmit(f.page, '.world-rule-add');
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('.action-dock button:not(:disabled)').count(), 0);
  assert.equal(await f.page.locator('#world-rules').evaluate(el => el.open), true);
  assert.equal(f.calls.length, 1);
  f.release(); await idle(f.page);
  assert.equal(await f.page.locator('#new-world-rule').inputValue(), 'No one can lie.');
  assert.equal(await f.page.locator('#world-rule-error').innerText(), 'Try this action again');
});

test('20 rules never silently evict the oldest via the UI', async t => {
  const f = await fixture(t, { rules: Array.from({ length: 20 }, (_, i) => `Rule ${i}`) });
  await button(f.page, 'World rules').click();
  await f.page.locator('#new-world-rule').fill('One more rule');
  assert.equal(await button(f.page, 'Save world rule').isDisabled(), true);
  await forceSubmit(f.page, '.world-rule-add');
  assert.equal(f.calls.length, 0);
});

test('empty choice list has explicit recovery; ended games have none', async t => {
  const f = await fixture(t, { choices: [] });
  await submit(f, 'Next story moment');
  assert.equal(f.calls[0].path, '/api/games/game_ui/continue');
  const ended = await fixture(t, { choices: [], ended: true });
  assert.equal(await button(ended.page, 'Next story moment').count(), 0);
  assert.equal(await button(ended.page, 'Continue').count(), 0);
});

test('conversation opens directly; blank reply blocked; suggestion submits once', async t => {
  const f = await fixture(t);

  await f.page.locator('[data-choice-id="talk"]').click();
  await idle(f.page);
  assert.equal(await button(f.page, 'Say this').isDisabled(), true);
  await f.page.locator('#dialogue-reply').fill('   ');
  await forceSubmit(f.page, '.dialogue-form');
  assert.equal(f.calls.length, 1);

  await f.page.locator('.suggestion-button').click();
  await idle(f.page);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body, { text: 'I need directions.' });
});

test('all four named dock actions remain usable at a narrow mobile viewport', async t => {
  const f = await fixture(t, { viewport: { width: 390, height: 844 } });
  for (const name of ['Undo', 'Custom action', 'World event', 'World rules']) {
    assert.equal(await button(f.page, name).isVisible(), true);
  }
  await button(f.page, 'World event').click();
  await f.page.locator('#custom-turn-text').fill('A storm approaches.');
  await submit(f, 'Apply world event');
  assert.equal(f.calls[0].path, '/api/games/game_ui/events');
});


test('failed world-rule load cannot be mistaken for empty rules and can be retried', async t => {
  const f = await fixture(t, { rules: ['Always spring.'], failRuleLoad: true });
  await button(f.page, 'World rules').click();
  await button(f.page, 'Retry loading rules').waitFor();
  assert.equal(await f.page.locator('#new-world-rule').count(), 0);
  assert.equal(await f.page.locator('#world-rule-error').innerText(), 'Rules unavailable');
  f.failRuleLoad = false;
  await button(f.page, 'Retry loading rules').click();
  await f.page.locator('#new-world-rule').waitFor();
  assert.equal(await f.page.locator('.world-rule-row p').innerText(), 'Always spring.');
  assert.equal(f.calls.length, 0);
});
