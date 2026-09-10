import test from 'node:test';
import assert from 'node:assert/strict';
import { installGameResponseCapture } from './response-capture.mjs';

async function harness({ method = 'POST', body = '{"gameId":"game_1"}', failure } = {}) {
  let handler;
  let matcher;
  const calls = [];
  const errors = [];
  const request = { method: () => method };
  const response = {
    body: async () => Buffer.from(body),
    dispose: async () => { calls.push('dispose'); },
  };
  const read = await installGameResponseCapture({
    route: async (match, handle) => { matcher = match; handler = handle; },
  }, { origin: 'http://localhost:8787', timeout: 600000, onError: error => errors.push(error) });
  const route = {
    request: () => request,
    continue: async () => { calls.push('continue'); },
    fetch: async options => {
      calls.push(['fetch', options]);
      if (failure) throw failure;
      return response;
    },
    fulfill: async options => {
      // The body must already be readable while the browser gets the response.
      assert.equal(await read(browserResponse), body);
      assert.equal(options.response, response);
      assert.deepEqual(options.body, Buffer.from(body));
      calls.push('fulfill');
    },
    abort: async reason => { calls.push(['abort', reason]); },
  };
  const browserResponse = {
    request: () => request,
    text: async () => { throw Error('Request content was evicted from inspector cache'); },
  };
  await handler(route);
  return { read, browserResponse, calls, errors, matcher };
}

test('game response survives inspector eviction and can be read by submit and logging', async () => {
  const { read, browserResponse, calls, errors, matcher } = await harness();
  assert.deepEqual(await Promise.all([read(browserResponse), read(browserResponse)]),
    ['{"gameId":"game_1"}', '{"gameId":"game_1"}']);
  assert.deepEqual(calls, [['fetch', { timeout: 600000, maxRetries: 0, maxRedirects: 0 }], 'fulfill', 'dispose']);
  assert.deepEqual(errors, []);
  assert.equal(matcher(new URL('http://localhost:8787/api/games')), true);
  assert.equal(matcher(new URL('http://localhost:8787/api/games/game_1/choices')), true);
  assert.equal(matcher(new URL('http://other.test/api/games')), false);
  assert.equal(matcher(new URL('http://localhost:8787/api/logs')), false);
});

test('backend rejection body is preserved verbatim', async () => {
  const body = '{"error":"Required beat 0 was not completed."}';
  const { read, browserResponse } = await harness({ body });
  assert.equal(await read(browserResponse), body);
});

test('GET requests keep their original browser path', async () => {
  const { calls } = await harness({ method: 'GET' });
  assert.deepEqual(calls, ['continue']);
});

test('a failed mutation is aborted and reported without retrying', async () => {
  const failure = Error('ECONNRESET');
  const { calls, errors } = await harness({ failure });
  assert.deepEqual(calls, [['fetch', { timeout: 600000, maxRetries: 0, maxRedirects: 0 }], ['abort', 'failed']]);
  assert.deepEqual(errors, [failure]);
});
