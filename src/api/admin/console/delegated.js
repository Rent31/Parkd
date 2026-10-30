'use strict';

const $ = id => document.getElementById(id);
const state = { token: null, generation: 0, requestId: 0, next: null, prefix: null };
const scopePattern = /^ListBucketObjects:([0-9a-f]{64})$/;

function notice(message) { $('message').textContent = message; $('message').hidden = !message; }
async function api(endpoint, token, body) {
  const response = await fetch(`/v2/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store', credentials: 'omit', redirect: 'error'
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}
function resetPage(message = 'Choose Browse to load objects.') {
  state.requestId++;
  state.next = state.prefix = null;
  $('next').disabled = true;
  $('browse').disabled = !state.token;
  $('objects').className = 'list-empty'; $('objects').textContent = message;
  $('page-info').textContent = 'No page loaded.';
}
function disconnect() {
  state.generation++;
  state.token = null;
  $('bucket').replaceChildren(); $('prefix').value = ''; $('token').value = '';
  resetPage();
  $('browser').hidden = true; $('connect-panel').hidden = false;
}
function render(objects) {
  const container = $('objects'); container.replaceChildren();
  if (!objects.length) { container.className = 'list-empty'; container.textContent = 'No objects found for this prefix.'; return; }
  container.className = 'table-wrap';
  const table = document.createElement('table'); table.className = 'resource-table';
  const head = table.createTHead().insertRow();
  for (const label of ['Key', 'Logical bytes', 'Last modified', 'ETag']) {
    const th = document.createElement('th'); th.textContent = label; head.append(th);
  }
  const body = table.createTBody();
  for (const object of objects) {
    const modified = Number.isSafeInteger(object.modifiedMsec) && object.modifiedMsec >= 0 ? new Date(object.modifiedMsec) : null;
    const values = [object.key, Number.isSafeInteger(object.size) && object.size >= 0 ? object.size.toLocaleString() : 'Not available', modified && !Number.isNaN(modified.valueOf()) ? modified.toLocaleString() : 'Not available', object.etag];
    const row = body.insertRow();
    for (const value of values) row.insertCell().textContent = value;
  }
  container.append(table);
}
async function browse(after = null) {
  if (!state.token || !$('bucket').value) return;
  const prefix = $('prefix').value;
  if (after !== null && (after !== state.next || prefix !== state.prefix)) return;
  const token = state.token, generation = state.generation, requestId = ++state.requestId;
  $('browse').disabled = true; $('next').disabled = true;
  $('objects').className = 'list-empty'; $('objects').textContent = 'Loading objects.'; $('page-info').textContent = 'Loading.';
  try {
    const result = await api('ListBucketObjects', token, { bucketId: $('bucket').value, prefix, after, limit: 100 });
    if (generation !== state.generation || requestId !== state.requestId) return;
    if (!Array.isArray(result.objects) || !result.objects.every(object => object && typeof object.key === 'string' && typeof object.etag === 'string') || !(result.nextAfter === null || typeof result.nextAfter === 'string')) throw new Error('Invalid response');
    state.next = result.nextAfter; state.prefix = prefix;
    render(result.objects);
    $('page-info').textContent = `${result.objects.length} objects on this page.${result.nextAfter === null ? ' End of results.' : ' More results available.'}`;
    $('next').disabled = result.nextAfter === null;
  } catch (error) {
    if (generation !== state.generation || requestId !== state.requestId) return;
    resetPage(`Could not load objects: ${error.message}`);
  } finally {
    if (generation === state.generation && requestId === state.requestId) $('browse').disabled = false;
  }
}
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!window.isSecureContext) { notice('A secure HTTPS or local connection is required.'); return; }
  const token = $('token').value.trim(); $('token').value = '';
  if (!token) return;
  const generation = ++state.generation;
  const button = event.submitter; button.disabled = true;
  try {
    const info = await api('GetCurrentAdminTokenInfo', token);
    if (generation !== state.generation) return;
    if (!Array.isArray(info.scope) || !info.scope.length || !info.scope.every(scope => typeof scope === 'string' && scopePattern.test(scope))) throw new Error('Token must contain only bucket-specific ListBucketObjects scopes');
    const bucketIds = [...new Set(info.scope.map(scope => scope.match(scopePattern)[1]))];
    $('bucket').replaceChildren();
    for (const id of bucketIds) { const option = document.createElement('option'); option.value = id; option.textContent = id; $('bucket').append(option); }
    state.token = token;
    $('connect-panel').hidden = true; $('browser').hidden = false; notice(''); resetPage();
  } catch (error) {
    if (generation === state.generation) notice(`Could not connect: ${error.message}.`);
  } finally { button.disabled = false; }
});
$('disconnect').addEventListener('click', () => { disconnect(); notice('Disconnected.'); });
$('bucket').addEventListener('change', () => resetPage());
$('prefix').addEventListener('input', () => resetPage());
$('browse-form').addEventListener('submit', event => { event.preventDefault(); browse(); });
$('next').addEventListener('click', () => { if (state.next !== null) browse(state.next); });
