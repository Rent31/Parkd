const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'delegated.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, 'delegated.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const id = 'a'.repeat(64);

function setup(scope = [`ListBucketObjects:${id}`]) {
  const dom = new JSDOM(html, { url: 'https://parkd.example/console/delegated.html', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  const requests = [];
  const responses = {
    GetCurrentAdminTokenInfo: { scope },
    ListBucketObjects: { objects: [{ key: '<img src=x onerror=alert(1)>', etag: 'etag', size: 14, modifiedMsec: 1700000000000 }], nextAfter: '<img src=x onerror=alert(1)>' }
  };
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    const data = responses[url.split('/').pop()];
    if (data instanceof Error) throw data;
    return { ok: data !== undefined, status: data === undefined ? 403 : 200, json: async () => data };
  };
  window.eval(script);
  return { window, document: window.document, requests, responses };
}
async function connect(ctx) {
  ctx.document.getElementById('token').value = 'scoped-secret';
  ctx.document.getElementById('connect-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: ctx.document.querySelector('#connect-form button') }));
  await tick();
}
async function browse(ctx) {
  ctx.document.getElementById('browse-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await tick();
}

test('scoped token browses and pages without rendering object keys as HTML', async () => {
  const ctx = setup(); await connect(ctx); await browse(ctx);
  assert.equal(ctx.document.getElementById('browser').hidden, false);
  assert.equal(ctx.document.getElementById('token').value, '');
  assert.equal(ctx.document.querySelector('#objects img'), null);
  assert.match(ctx.document.getElementById('objects').textContent, /<img/);
  assert.equal(ctx.window.localStorage.length, 0); assert.equal(ctx.window.sessionStorage.length, 0);
  const request = ctx.requests.find(r => r.url === '/v2/ListBucketObjects');
  assert.deepEqual(JSON.parse(request.options.body), { bucketId: id, prefix: '', after: null, limit: 100 });
  assert.equal(request.options.headers.Authorization, 'Bearer scoped-secret');
  ctx.responses.ListBucketObjects = { objects: [{ key: 'next', etag: 'etag', size: 1, modifiedMsec: 1 }], nextAfter: null };
  ctx.document.getElementById('next').click(); await tick();
  assert.equal(JSON.parse(ctx.requests.filter(r => r.url === '/v2/ListBucketObjects')[1].options.body).after, '<img src=x onerror=alert(1)>');
  assert.equal(ctx.document.getElementById('next').disabled, true);
  ctx.document.getElementById('disconnect').click();
  assert.equal(ctx.document.getElementById('browser').hidden, true);
  assert.doesNotMatch(ctx.document.getElementById('objects').textContent, /next/);
  ctx.window.close();
});

test('refuses broad, mixed, malformed and empty scopes', async () => {
  for (const scope of [['*'], ['ListBucketObjects'], [`ListBucketObjects:${id}`, 'ListKeys'], ['ListBucketObjects:not-a-bucket-id'], []]) {
    const ctx = setup(scope); await connect(ctx);
    assert.equal(ctx.document.getElementById('browser').hidden, true);
    assert.match(ctx.document.getElementById('message').textContent, /bucket-specific/);
    assert.equal(ctx.requests.some(r => r.url === '/v2/ListBucketObjects'), false);
    ctx.window.close();
  }
});

test('does not submit a token on an insecure origin', async () => {
  const ctx = setup(); Object.defineProperty(ctx.window, 'isSecureContext', { value: false });
  await connect(ctx); assert.equal(ctx.requests.length, 0);
  assert.match(ctx.document.getElementById('message').textContent, /secure HTTPS/);
  ctx.window.close();
});

test('clears stale metadata on errors and discards responses after disconnect', async () => {
  const ctx = setup(); await connect(ctx); await browse(ctx);
  ctx.responses.ListBucketObjects = new Error('offline');
  await browse(ctx);
  assert.match(ctx.document.getElementById('objects').textContent, /Could not load/);
  assert.equal(ctx.document.getElementById('next').disabled, true);
  assert.equal(ctx.document.getElementById('browse').disabled, false);
  const originalFetch = ctx.window.fetch; let complete;
  ctx.window.fetch = (url, options) => url === '/v2/ListBucketObjects'
    ? new Promise(resolve => { complete = () => resolve({ ok: true, json: async () => ({ objects: [{ key: 'private', etag: 'x', size: 1, modifiedMsec: 1 }], nextAfter: null }) }); })
    : originalFetch(url, options);
  ctx.document.getElementById('browse-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  ctx.document.getElementById('disconnect').click(); complete(); await tick();
  assert.doesNotMatch(ctx.document.getElementById('objects').textContent, /private/);
  ctx.window.close();
});

test('supports multiple explicit buckets and clears pagination when changed', async () => {
  const second = 'b'.repeat(64);
  const ctx = setup([`ListBucketObjects:${id}`, `ListBucketObjects:${second}`]); await connect(ctx); await browse(ctx);
  ctx.document.getElementById('bucket').value = second;
  ctx.document.getElementById('bucket').dispatchEvent(new ctx.window.Event('change'));
  assert.equal(ctx.document.getElementById('next').disabled, true);
  await browse(ctx);
  assert.equal(JSON.parse(ctx.requests.filter(r => r.url === '/v2/ListBucketObjects')[1].options.body).bucketId, second);
  ctx.window.close();
});
