const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

function setup(overrides = {}) {
  const dom = new JSDOM(html, { url: 'https://parkd.example/console/', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  const responses = {
    GetClusterStatistics: { totalObjectBytes: 2048, totalObjectCount: 2, bucketCount: 1 },
    GetClusterHealth: { status: 'healthy', storageNodesUp: 1, storageNodes: 1, partitionsQuorum: 256, partitions: 256 },
    ListBucketsInfo: [{ id: 'abc', globalAliases: ['<img src=x onerror=alert(1)>'], objects: 2, bytes: 2048, quotas: { maxSize: 4096, maxObjects: 10 } }],
    ListKeys: [{ id: 'key-id', name: 'test', expiration: null, expired: false }],
    GetClusterStatus: { nodes: [{ id: 'node-id', hostname: 'node', isUp: true, role: { zone: 'zone-a' } }] },
    ...overrides
  };
  const requests = [];
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    const name = url.split('/').pop().split('?')[0];
    const data = responses[name];
    if (data instanceof Error) throw data;
    return { ok: data !== undefined, status: data === undefined ? 403 : 200, json: async () => data };
  };
  window.eval(script);
  return { window, document: window.document, requests, responses };
}
async function connect(ctx) {
  ctx.document.getElementById('token').value = 'private-token';
  ctx.document.getElementById('connect-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: ctx.document.querySelector('#connect-form button') }));
  await tick();
}

test('connects to live data without storing token or interpreting bucket names as HTML', async () => {
  const ctx = setup(); await connect(ctx);
  assert.equal(ctx.document.getElementById('stat-bytes').textContent, '2 KiB');
  assert.equal(ctx.document.getElementById('stat-health').textContent, 'healthy');
  assert.match(ctx.document.getElementById('bucket-list').textContent, /<img/);
  assert.equal(ctx.document.querySelector('#bucket-list img'), null);
  assert.equal(ctx.window.localStorage.length, 0);
  assert.equal(ctx.window.sessionStorage.length, 0);
  assert.equal(ctx.document.getElementById('token').value, '');
  assert.equal(ctx.requests[0].options.headers.Authorization, 'Bearer private-token');
  assert.match(ctx.document.getElementById('billing-view').textContent, /not yet collect billable/);
  ctx.document.getElementById('disconnect').click();
  assert.equal(ctx.document.getElementById('stat-bytes').textContent, '--');
  assert.equal(ctx.document.getElementById('connect-panel').hidden, false);
  ctx.window.close();
});

test('shows partial failure instead of stale or fabricated data', async () => {
  const ctx = setup({ ListBucketsInfo: new Error('offline'), GetClusterStatistics: new Error('offline') });
  await connect(ctx);
  assert.equal(ctx.document.getElementById('stat-bytes').textContent, 'Not available');
  assert.equal(ctx.document.getElementById('bucket-list').textContent, 'Could not load data.');
  assert.match(ctx.document.getElementById('notice').textContent, /ListBucketsInfo/);
  assert.equal(ctx.document.getElementById('stat-health').textContent, 'healthy');
  ctx.window.close();
});

test('refuses a token on an insecure origin', async () => {
  const ctx = setup();
  Object.defineProperty(ctx.window, 'isSecureContext', { value: false });
  await connect(ctx);
  assert.equal(ctx.requests.length, 0);
  assert.match(ctx.document.getElementById('notice').textContent, /secure HTTPS/);
  ctx.window.close();
});

test('failed authorization leaves the console disconnected', async () => {
  const ctx = setup({ GetClusterHealth: undefined }); await connect(ctx);
  assert.equal(ctx.document.getElementById('connect-panel').hidden, false);
  assert.match(ctx.document.getElementById('notice').textContent, /Could not connect/);
  assert.equal(ctx.requests.length, 1);
  ctx.window.close();
});

test('grants only selected permissions to the selected bucket and key', async () => {
  const ctx = setup({ AllowBucketKey: {} }); await connect(ctx);
  ctx.document.getElementById('permission-bucket').value = 'abc';
  ctx.document.getElementById('permission-key').value = 'key-id';
  ctx.document.querySelector('input[name="read"]').checked = true;
  ctx.document.getElementById('permissions-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await tick();
  const request = ctx.requests.find(r => r.url === '/v2/AllowBucketKey');
  assert.ok(request);
  assert.deepEqual(JSON.parse(request.options.body), { bucketId: 'abc', accessKeyId: 'key-id', permissions: { read: true, write: false, owner: false } });
  assert.match(ctx.document.getElementById('notice').textContent, /granted/);
  ctx.window.close();
});

test('does not grant permissions without an explicit selection', async () => {
  const ctx = setup({ AllowBucketKey: {} }); await connect(ctx);
  ctx.document.getElementById('permissions-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(ctx.requests.some(r => r.url === '/v2/AllowBucketKey'), false);
  assert.match(ctx.document.getElementById('notice').textContent, /Select a bucket/);
  ctx.window.close();
});


test('loads and updates both bucket quotas without rounding', async () => {
  const ctx = setup({ UpdateBucket: {} }); await connect(ctx);
  ctx.document.getElementById('quota-bucket').value = 'abc';
  ctx.document.getElementById('quota-bucket').dispatchEvent(new ctx.window.Event('change'));
  assert.equal(ctx.document.getElementById('quota-size').value, '4096');
  assert.equal(ctx.document.getElementById('quota-objects').value, '10');
  ctx.document.getElementById('quota-size').value = '8192';
  ctx.document.getElementById('quota-objects').value = '20';
  ctx.document.getElementById('quota-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await tick();
  const request = ctx.requests.find(r => r.url === '/v2/UpdateBucket?id=abc');
  assert.deepEqual(JSON.parse(request.options.body), { quotas: { maxSize: 8192, maxObjects: 20 } });
  ctx.window.close();
});

test('does not edit or round quota values outside the safe integer range', async () => {
  const ctx = setup({ ListBucketsInfo: [{ id: 'abc', globalAliases: [], objects: 0, bytes: 0, quotas: { maxSize: 9007199254740992, maxObjects: null } }] });
  await connect(ctx);
  ctx.document.getElementById('quota-bucket').value = 'abc';
  ctx.document.getElementById('quota-bucket').dispatchEvent(new ctx.window.Event('change'));
  assert.equal(ctx.document.getElementById('save-quota').disabled, true);
  assert.match(ctx.document.getElementById('quota-message').textContent, /safe integer/);
  ctx.window.close();
});

test('requires confirmation before removing a quota', async () => {
  const ctx = setup({ UpdateBucket: {} }); await connect(ctx);
  ctx.document.getElementById('quota-bucket').value = 'abc';
  ctx.document.getElementById('quota-bucket').dispatchEvent(new ctx.window.Event('change'));
  ctx.document.getElementById('quota-size').value = '';
  ctx.window.confirm = () => false;
  ctx.document.getElementById('quota-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(ctx.requests.some(r => r.url.startsWith('/v2/UpdateBucket')), false);
  ctx.window.close();
});

test('browses paginated object metadata without interpreting keys as HTML', async () => {
  const ctx = setup({ ListBucketObjects: { objects: [{ key: '<img src=x onerror=alert(1)>', size: 1024, modifiedMsec: 1700000000000, etag: 'abc' }], nextAfter: '<img src=x onerror=alert(1)>' } });
  await connect(ctx);
  ctx.document.getElementById('object-bucket').value = 'abc';
  ctx.document.getElementById('object-bucket').dispatchEvent(new ctx.window.Event('change'));
  ctx.document.getElementById('object-prefix').value = 'prefix/';
  ctx.document.getElementById('object-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.match(ctx.document.getElementById('object-list').textContent, /<img/);
  assert.equal(ctx.document.querySelector('#object-list img'), null);
  assert.match(ctx.document.getElementById('object-list').textContent, /1 KiB/);
  const request = ctx.requests.find(r => r.url === '/v2/ListBucketObjects');
  assert.deepEqual(JSON.parse(request.options.body), { bucketId: 'abc', prefix: 'prefix/', after: null, limit: 100 });
  ctx.responses.ListBucketObjects = { objects: [{ key: 'prefix/next', size: 3, modifiedMsec: 1700000000000, etag: 'def' }], nextAfter: null };
  ctx.document.getElementById('object-next').click(); await tick();
  const pages = ctx.requests.filter(r => r.url === '/v2/ListBucketObjects');
  assert.equal(JSON.parse(pages[1].options.body).after, '<img src=x onerror=alert(1)>');
  assert.match(ctx.document.getElementById('object-list').textContent, /prefix\/next/);
  assert.equal(ctx.document.getElementById('object-next').disabled, true);
  ctx.document.getElementById('object-prefix').dispatchEvent(new ctx.window.Event('input'));
  assert.match(ctx.document.getElementById('object-list').textContent, /Select a bucket/);
  ctx.window.close();
});

test('does not show stale object data after a request failure', async () => {
  const ctx = setup({ ListBucketObjects: new Error('offline') }); await connect(ctx);
  ctx.document.getElementById('object-bucket').value = 'abc';
  ctx.document.getElementById('object-bucket').dispatchEvent(new ctx.window.Event('change'));
  ctx.document.getElementById('object-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.match(ctx.document.getElementById('object-list').textContent, /Could not load objects/);
  assert.equal(ctx.document.getElementById('object-browse').disabled, false);
  assert.equal(ctx.document.getElementById('object-next').disabled, true);
  ctx.window.close();
});

test('discards object responses that arrive after disconnect', async () => {
  const ctx = setup(); await connect(ctx);
  const originalFetch = ctx.window.fetch;
  let complete;
  ctx.window.fetch = (url, options) => url === '/v2/ListBucketObjects'
    ? new Promise(resolve => { complete = () => resolve({ ok: true, json: async () => ({ objects: [{ key: 'private', etag: 'abc', size: 4, modifiedMsec: 1 }], nextAfter: null }) }); })
    : originalFetch(url, options);
  ctx.document.getElementById('object-bucket').value = 'abc';
  ctx.document.getElementById('object-bucket').dispatchEvent(new ctx.window.Event('change'));
  ctx.document.getElementById('object-form').dispatchEvent(new ctx.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  ctx.document.getElementById('disconnect').click();
  complete(); await tick();
  assert.doesNotMatch(ctx.document.getElementById('object-list').textContent, /private/);
  assert.equal(ctx.document.getElementById('object-next').disabled, true);
  ctx.window.close();
});
