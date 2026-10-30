'use strict';

const $ = id => document.getElementById(id);
const state = { token: null, generation: 0, refreshId: 0, buckets: null, keys: null, nodes: null, objectRequestId: 0, objectNext: null, objectPrefix: null };
const labels = {
  overview: ['Overview', 'A clear view of your object storage, all in one place.'],
  buckets: ['Buckets', 'Manage your storage namespaces.'],
  objects: ['Objects', 'Browse current object metadata.'],
  keys: ['Access keys', 'View credentials used to access your storage.'],
  cluster: ['Cluster', 'See the infrastructure behind your storage.'],
  billing: ['Usage & billing', 'Understand what is available for your account.']
};

function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'Not available';
  if (value < 1024) return `${value} B`;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[power]}`;
}
function number(value) { return Number.isFinite(value) ? value.toLocaleString() : 'Not available'; }
function text(id, value) { $(id).textContent = value; }
function switchView(view) {
  if (!labels[view]) return;
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== `${view}-view`; });
  document.querySelectorAll('.nav').forEach(el => { el.classList.toggle('active', el.dataset.view === view); });
  text('crumb', labels[view][0]);
  text('page-title', labels[view][0]);
  text('page-description', labels[view][1]);
  $('new-bucket').hidden = view !== 'overview' && view !== 'buckets';
}
async function api(path, token, options = {}) {
  const response = await fetch(`/v2/${path}`, {
    method: options.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store', credentials: 'omit', redirect: 'error'
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}
function table(target, headers, rows, empty) {
  const container = $(target);
  container.replaceChildren();
  if (!rows.length) { container.className = 'list-empty'; container.textContent = empty; return; }
  container.className = 'table-wrap';
  const table = document.createElement('table'); table.className = 'resource-table';
  const head = table.createTHead().insertRow();
  headers.forEach(value => { const th = document.createElement('th'); th.textContent = value; head.appendChild(th); });
  const body = table.createTBody();
  rows.forEach(row => {
    const tr = body.insertRow();
    row.forEach(cell => {
      const td = tr.insertCell();
      if (Array.isArray(cell)) {
        td.append(document.createTextNode(cell[0]));
        const sub = document.createElement('span'); sub.className = 'muted'; sub.textContent = cell[1]; td.append(sub);
      } else td.textContent = cell;
    });
  });
  container.append(table);
}
function renderPermissionOptions() {
  for (const [id, items, label] of [
    ['permission-bucket', state.buckets, item => item.globalAliases[0] || item.id],
    ['permission-key', state.keys, item => `${item.name} (${item.id})`]
  ]) {
    const select = $(id), previous = select.value;
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = items ? 'Select an option' : 'Data not available'; select.append(placeholder);
    if (items) items.forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = label(item); select.append(option); });
    select.value = items && items.some(item => item.id === previous) ? previous : '';
    select.disabled = !items || !items.length;
  }
  const enabled = !!(state.token && state.buckets?.length && state.keys?.length);
  $('grant-permission').disabled = !enabled;
  $('revoke-permission').disabled = !enabled;
}
function resetObjectPage(message = 'Select a bucket and choose Browse.') {
  state.objectRequestId++;
  state.objectNext = null;
  state.objectPrefix = null;
  $('object-next').disabled = true;
  $('object-browse').disabled = !$('object-bucket').value || $('object-bucket').disabled;
  $('object-list').className = 'list-empty'; text('object-list', message);
  text('object-page-info', 'No page loaded.');
}
function renderObjectOptions() {
  const select = $('object-bucket'), previous = select.value;
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = state.buckets ? 'Select a bucket' : 'Data not available'; select.append(placeholder);
  if (state.buckets) state.buckets.forEach(bucket => {
    const option = document.createElement('option'); option.value = bucket.id;
    option.textContent = `${bucket.globalAliases[0] || '(no global alias)'} (${bucket.id})`; select.append(option);
  });
  select.value = state.buckets?.some(bucket => bucket.id === previous) ? previous : '';
  select.disabled = !state.buckets?.length;
  $('object-prefix').disabled = select.disabled;
  $('object-browse').disabled = select.disabled || !select.value;
  if (!select.value || select.value !== previous) resetObjectPage();
}
async function loadObjectPage(after = null) {
  const bucketId = $('object-bucket').value, prefix = $('object-prefix').value;
  if (!state.token || !bucketId) return;
  if (after !== null && (state.objectNext !== after || state.objectPrefix !== prefix)) return;
  const token = state.token, generation = state.generation, requestId = ++state.objectRequestId;
  $('object-browse').disabled = true; $('object-next').disabled = true;
  $('object-list').className = 'list-empty'; text('object-list', 'Loading objects.');
  text('object-page-info', 'Loading.');
  try {
    const result = await api('ListBucketObjects', token, { method: 'POST', body: { bucketId, prefix, after, limit: 100 } });
    if (generation !== state.generation || requestId !== state.objectRequestId) return;
    if (!Array.isArray(result.objects) || !result.objects.every(object => typeof object.key === 'string' && typeof object.etag === 'string') || !(result.nextAfter === null || typeof result.nextAfter === 'string')) throw new Error('Invalid response');
    state.objectNext = result.nextAfter; state.objectPrefix = prefix;
    const modified = value => {
      if (!Number.isSafeInteger(value) || value < 0) return 'Not available';
      const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Not available' : date.toLocaleString();
    };
    table('object-list', ['Key', 'Logical size', 'Last modified', 'ETag'], result.objects.map(object => [object.key, Number.isSafeInteger(object.size) ? formatBytes(object.size) : 'Not available', modified(object.modifiedMsec), object.etag]), 'No objects found for this prefix.');
    text('object-page-info', `${result.objects.length} objects on this page.${result.nextAfter !== null ? ' More results available.' : ' End of results.'}`);
    $('object-next').disabled = result.nextAfter === null;
  } catch (error) {
    if (generation !== state.generation || requestId !== state.objectRequestId) return;
    resetObjectPage(`Could not load objects: ${error.message}`);
  } finally {
    if (generation === state.generation && requestId === state.objectRequestId) $('object-browse').disabled = !$('object-bucket').value;
  }
}
function renderQuotaOptions() {
  const select = $('quota-bucket'), previous = select.value;
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = state.buckets ? 'Select a bucket' : 'Data not available'; select.append(placeholder);
  if (state.buckets) state.buckets.forEach(bucket => {
    const option = document.createElement('option'); option.value = bucket.id;
    option.textContent = `${bucket.globalAliases[0] || '(no global alias)'} (${bucket.id})`; select.append(option);
  });
  select.value = state.buckets?.some(bucket => bucket.id === previous) ? previous : '';
  select.disabled = !state.buckets?.length;
  loadQuota();
}
function loadQuota() {
  const bucket = state.buckets?.find(item => item.id === $('quota-bucket').value);
  const quotas = bucket?.quotas;
  const valid = quotas && ['maxSize', 'maxObjects'].every(key => quotas[key] === null || (Number.isSafeInteger(quotas[key]) && quotas[key] >= 0));
  for (const id of ['quota-size', 'quota-objects', 'save-quota']) $(id).disabled = !valid;
  $('quota-size').value = valid && quotas.maxSize !== null ? String(quotas.maxSize) : '';
  $('quota-objects').value = valid && quotas.maxObjects !== null ? String(quotas.maxObjects) : '';
  text('quota-message', !bucket ? 'Select a bucket to view its current limits.' : valid ? 'Values are current as of the last refresh. Saving replaces both limits.' : 'Quota values are unavailable or exceed the safe integer range of this browser. Use the admin API or CLI.');
}
function parseQuota(input) {
  const value = input.trim();
  if (!value) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Use whole non-negative numbers, or leave a field empty.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('The value exceeds the safe integer range of this browser. Use the admin API or CLI.');
  return parsed;
}
function renderBuckets() {
  if (!state.buckets) return;
  const filter = $('bucket-search').value.trim().toLowerCase();
  const rows = state.buckets.filter(b => `${b.id} ${b.globalAliases.join(' ')}`.toLowerCase().includes(filter));
  const row = b => [[b.globalAliases[0] || '(no global alias)', b.id], number(b.objects), formatBytes(b.bytes)];
  table('bucket-list', ['Bucket / ID', 'Objects', 'Logical size'], rows.map(row), 'No matching buckets in the first 100 results.');
  table('recent-buckets', ['Bucket / ID', 'Objects', 'Logical size'], state.buckets.slice(0, 5).map(row), 'No buckets found.');
}
function renderKeys() {
  if (!state.keys) return;
  table('key-list', ['Name / access key ID', 'Status', 'Expiration'], state.keys.map(k => [[k.name, k.id], k.expired ? 'Expired' : 'Active', k.expiration ? new Date(k.expiration).toLocaleString() : 'No expiration']), 'No keys found.');
}
function renderNodes() {
  if (!state.nodes) return;
  table('node-list', ['Node / ID', 'Status', 'Zone'], state.nodes.map(n => [[n.hostname || '(unknown hostname)', n.id], n.isUp ? 'Connected' : 'Disconnected', n.role ? n.role.zone : 'Unassigned']), 'No nodes reported.');
}
function setConnected(connected) {
  $('connect-panel').hidden = connected;
  $('refresh').disabled = !connected;
  $('disconnect').disabled = !connected;
  $('new-bucket').disabled = !connected;
  $('new-key').disabled = !connected;
  text('connection-label', connected ? 'Connected' : 'Not connected');
  $('connection-dot').className = `status-dot${connected ? ' online' : ''}`;
}
function clearData() {
  state.buckets = state.keys = state.nodes = null;
  renderPermissionOptions();
  renderQuotaOptions();
  renderObjectOptions();
  ['stat-bytes', 'stat-objects', 'stat-buckets', 'stat-health', 'nodes-online', 'quorum', 'billing-bytes'].forEach(id => text(id, '--'));
  text('health-detail', 'Connect to view status'); text('cluster-summary', 'Not connected'); text('cluster-subsummary', 'No cluster data available');
  for (const [id, message] of [['bucket-list', 'Connect to see your buckets.'], ['recent-buckets', 'Connect to see your buckets.'], ['key-list', 'Connect to see your keys.'], ['node-list', 'Connect to see your nodes.']]) {
    $(id).className = 'list-empty'; text(id, message);
  }
}
async function refresh() {
  if (!state.token) return;
  const token = state.token, generation = state.generation, refreshId = ++state.refreshId;
  $('refresh').disabled = true;
  const paths = ['GetClusterStatistics', 'GetClusterHealth', 'ListBucketsInfo?limit=100', 'ListKeys?limit=100', 'GetClusterStatus'];
  const results = await Promise.allSettled(paths.map(path => api(path, token)));
  if (generation !== state.generation || refreshId !== state.refreshId) return;
  $('refresh').disabled = false;
  const [stats, health, buckets, keys, nodes] = results;
  if (stats.status === 'fulfilled') {
    const s = stats.value;
    text('stat-bytes', formatBytes(s.totalObjectBytes)); text('billing-bytes', formatBytes(s.totalObjectBytes));
    text('stat-objects', number(s.totalObjectCount)); text('stat-buckets', number(s.bucketCount));
  } else {
    ['stat-bytes', 'billing-bytes', 'stat-objects', 'stat-buckets'].forEach(id => text(id, 'Not available'));
  }
  if (health.status === 'fulfilled') {
    const h = health.value;
    text('stat-health', h.status); text('health-detail', 'As reported by this node');
    text('cluster-summary', h.status); text('cluster-subsummary', 'As reported by this node');
    text('nodes-online', `${number(h.storageNodesUp)} / ${number(h.storageNodes)}`);
    text('quorum', `${number(h.partitionsQuorum)} / ${number(h.partitions)}`);
    $('connection-dot').className = `status-dot ${h.status === 'healthy' ? 'online' : 'warning'}`;
  } else {
    ['stat-health', 'cluster-summary', 'nodes-online', 'quorum'].forEach(id => text(id, 'Not available'));
    text('health-detail', 'Health request failed'); text('cluster-subsummary', 'Health request failed');
    $('connection-dot').className = 'status-dot warning';
  }
  for (const [result, key, ids, render] of [
    [buckets, 'buckets', ['bucket-list', 'recent-buckets'], renderBuckets],
    [keys, 'keys', ['key-list'], renderKeys],
    [nodes, 'nodes', ['node-list'], renderNodes]
  ]) {
    if (result.status === 'fulfilled') { state[key] = key === 'nodes' ? result.value.nodes : result.value; render(); }
    else { state[key] = null; ids.forEach(id => { $(id).className = 'list-empty'; text(id, 'Could not load data.'); }); }
  }
  renderPermissionOptions();
  renderQuotaOptions();
  renderObjectOptions();
  const failed = results.map((r, i) => r.status === 'rejected' ? paths[i].split('?')[0] : null).filter(Boolean);
  showNotice(failed.length ? `Some data could not be loaded: ${failed.join(', ')}. Check token permissions and refresh.` : '');
}

document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => switchView(el.dataset.view)));
document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => switchView(el.dataset.go)));
$('bucket-search').addEventListener('input', renderBuckets);
$('object-bucket').addEventListener('change', () => { resetObjectPage(); $('object-browse').disabled = !$('object-bucket').value; });
$('object-prefix').addEventListener('input', () => { resetObjectPage(); $('object-browse').disabled = !$('object-bucket').value; });
$('object-form').addEventListener('submit', event => { event.preventDefault(); loadObjectPage(); });
$('object-next').addEventListener('click', () => { if (state.objectNext !== null) loadObjectPage(state.objectNext); });
$('refresh').addEventListener('click', refresh);
$('disconnect').addEventListener('click', () => { state.generation++; state.token = null; clearData(); setConnected(false); showNotice('Disconnected.'); });
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!window.isSecureContext) { showNotice('A secure HTTPS or local connection is required before sending an admin token.'); return; }
  const token = $('token').value.trim();
  if (!token) return;
  const button = event.submitter; button.disabled = true;
  try {
    await api('GetClusterHealth', token);
    state.token = token; state.generation++; $('token').value = ''; setConnected(true); showNotice(''); await refresh();
  } catch (error) { showNotice(`Could not connect: ${error.message}. Check the token and server.`); }
  finally { button.disabled = false; }
});
$('new-bucket').addEventListener('click', async () => {
  const name = window.prompt('Global bucket name:');
  if (name === null || !name.trim() || !state.token) return;
  try { await api('CreateBucket', state.token, { method: 'POST', body: { globalAlias: name.trim() } }); await refresh(); showNotice('Bucket created. Grant an access key permission before using it.'); }
  catch (error) { showNotice(`Could not create bucket: ${error.message}`); }
});
$('new-key').addEventListener('click', async () => {
  const name = window.prompt('Name for the new access key:');
  if (name === null || !name.trim() || !state.token) return;
  try {
    const key = await api('CreateKey', state.token, { method: 'POST', body: { name: name.trim() } });
    window.prompt('Copy this secret access key now. Store it securely.', key.secretAccessKey);
    await refresh(); showNotice(`Key ${key.accessKeyId} created. It has no bucket permissions until granted by an administrator.`);
  } catch (error) { showNotice(`Could not create key: ${error.message}`); }
});

async function changePermissions(operation) {
  const bucketId = $('permission-bucket').value, accessKeyId = $('permission-key').value;
  const permissions = Object.fromEntries(['read', 'write', 'owner'].map(name => [name, document.querySelector(`#permissions-form input[name="${name}"]`).checked]));
  if (!state.token || !bucketId || !accessKeyId || !Object.values(permissions).some(Boolean)) {
    showNotice('Select a bucket, a key, and at least one permission.'); return;
  }
  if (operation === 'DenyBucketKey' && !window.confirm('Revoke the selected permissions from this key?')) return;
  try {
    await api(operation, state.token, { method: 'POST', body: { bucketId, accessKeyId, permissions } });
    await refresh(); showNotice(operation === 'AllowBucketKey' ? 'Selected permissions granted.' : 'Selected permissions revoked.');
  } catch (error) { showNotice(`Could not update permissions: ${error.message}`); }
}
$('permissions-form').addEventListener('submit', event => { event.preventDefault(); changePermissions('AllowBucketKey'); });
$('revoke-permission').addEventListener('click', () => changePermissions('DenyBucketKey'));

$('quota-bucket').addEventListener('change', loadQuota);
$('quota-form').addEventListener('submit', async event => {
  event.preventDefault();
  const bucketId = $('quota-bucket').value;
  if (!state.token || !bucketId || $('save-quota').disabled) return;
  try {
    const maxSize = parseQuota($('quota-size').value);
    const maxObjects = parseQuota($('quota-objects').value);
    if ((maxSize === null || maxObjects === null) && !window.confirm('Empty fields remove their corresponding limits. Save both limits?')) return;
    await api(`UpdateBucket?id=${encodeURIComponent(bucketId)}`, state.token, { method: 'POST', body: { quotas: { maxSize, maxObjects } } });
    await refresh(); showNotice('Bucket limits updated. Concurrent writes may exceed these limits.');
  } catch (error) { showNotice(`Could not update bucket limits: ${error.message}`); }
});
