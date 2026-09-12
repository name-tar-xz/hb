const results = document.querySelector('#results');
const health = document.querySelector('#health');
const target = document.querySelector('#target');
const fixAll = document.querySelector('#fix-all');
const revertAll = document.querySelector('#revert-all');
const downloadProject = document.querySelector('#download-project');
const resolvedCount = document.querySelector('#resolved-count b');
const attentionCount = document.querySelector('#attention-count b');
const log = document.querySelector('#log');
const logText = log.querySelector('pre');
const changesPanel = document.querySelector('#changes');
const changesList = changesPanel.querySelector('ul');
const dropZone = document.querySelector('#drop-zone');
const folderInput = document.querySelector('#folder-input');
const uploadNote = document.querySelector('#upload-note');
let current;
let changes = [];
const esc = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function issueCard(issue) {
  const place = issue.file ? `<div class="place">${esc(issue.file)}${issue.line ? `:${issue.line}` : ''}</div>` : '';
  const canFix = issue.autoFixable;
  const action = canFix
    ? `<button type="button" class="fix-one" data-id="${esc(issue.id)}" aria-label="Fix ${esc(issue.title)} automatically">Fix safely</button>`
    : '<span class="attention">Manual action</span>';
  return `<article class="issue-card ${issue.severity}" data-id="${esc(issue.id)}"><h3>${esc(issue.title)}</h3><p>${esc(issue.message)}</p><div class="issue-meta">${place}${action}</div></article>`;
}
function resolvedCard(change) {
  return `<article class="issue-card"><h3>${esc(change.title)}</h3><p>${esc(change.message)}</p><div class="issue-meta"><span class="status-label">✓ AUTO-FIXED</span></div></article>`;
}
function renderChanges() {
  changesPanel.hidden = !changes.length;
  changesList.replaceChildren();
  for (const change of changes) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = change.title;
    item.append(title, document.createTextNode(change.message));
    changesList.append(item);
  }
}
function recordChange(id, title, message) {
  if (changes.some(change => change.id === id)) return;
  changes.push({ id, title, message });
  renderChanges();
}
function render(scan) {
  current = scan;
  target.textContent = `Scanning: ${scan.displayName || scan.targetDir}`;
  uploadNote.hidden = !scan.uploaded;
  const open = [];
  let errors = 0;
  let warnings = 0;
  let hasAutomaticFixes = false;
  for (const issue of scan.diagnoses) {
    if (issue.fixed) continue;
    open.push(issue);
    if (issue.severity === 'error') errors++;
    else if (issue.severity === 'warning') warnings++;
    if (issue.autoFixable) hasAutomaticFixes = true;
  }
  health.className = `health ${errors ? 'bad' : warnings ? 'caution' : 'good'}`;
  health.querySelector('span').textContent = open.length ? `${open.length} issue${open.length === 1 ? '' : 's'} found` : 'All clear ✅';
  resolvedCount.textContent = changes.length;
  attentionCount.textContent = open.length;
  fixAll.hidden = !hasAutomaticFixes;
  revertAll.hidden = !scan.canRevert;
  downloadProject.hidden = !scan.canDownload;
  if (!open.length) {
    results.innerHTML = '<div class="all-clear"><div>✓</div><h2>Environment healthy</h2><p>No unresolved dependency or environment issues were found.</p></div>';
  } else {
    const resolved = changes.length
      ? changes.map(resolvedCard).join('')
      : '<div class="empty-card"><strong>No fixes applied yet</strong>Safe repairs will appear here as you apply them.</div>';
    results.innerHTML = `<div class="mapper-head"><div><h2>Dependency hierarchy</h2><p>Nodes map the detected issue to its recommended action.</p></div><p>${scan.displayName || 'LOCAL PROJECT'}</p></div><div class="dependency-map"><section class="map-column resolved-column"><div class="column-head"><h3>Resolved / auto-fixed</h3><span>${changes.length} resolved</span></div><div class="issue-stack">${resolved}</div></section><div class="map-line" aria-hidden="true"></div><section class="map-column remaining-column"><div class="column-head"><h3>Remaining needs attention</h3><span>${open.length} remaining</span></div><div class="issue-stack">${open.map(issueCard).join('')}</div></section></div>`;
  }
  renderChanges();
}
async function scan() {
  results.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Running a health check…</p></div>';
  try { render(await (await fetch('/api/scan')).json()); } catch { results.innerHTML = '<p class="failure">Could not scan this folder. Please refresh to retry.</p>'; }
}
function showEmptyState() {
  target.textContent = 'No project selected yet';
  health.className = 'health loading';
  health.querySelector('span').textContent = 'Ready to scan';
  fixAll.hidden = true;
  revertAll.hidden = true;
  downloadProject.hidden = true;
  changes = [];
  resolvedCount.textContent = '0';
  attentionCount.textContent = '0';
  renderChanges();
  results.innerHTML = '<div class="all-clear"><div>↥</div><h2>Map a project</h2><p>Choose or drop a folder to inspect its dependencies and environment configuration.</p></div>';
}
async function fixOne(button) {
  button.disabled = true; button.textContent = 'Fixing…';
  try {
    const response = await fetch('/api/fix', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: button.dataset.id }) });
    const item = await response.json();
    if (!response.ok || !item.fixed) throw new Error(item.error || item.fixMessage || 'Could not fix this issue automatically.');
    button.closest('.issue-card')?.remove();
    recordChange(item.id, item.title, item.fixMessage || 'Fixed automatically.');
    await scan();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Try again';
    button.title = error instanceof Error ? error.message : 'Could not fix this issue automatically.';
  }
}
results.addEventListener('click', event => { const button = event.target.closest('.fix-one'); if (button) fixOne(button); });
async function fixAllSafeIssues() {
  fixAll.disabled = true;
  fixAll.textContent = 'Fixing…';
  log.hidden = false;
  logText.textContent = '';
  try {
    const response = await fetch('/api/fix-all', { method: 'POST' });
    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Could not fix the detected errors.');
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const packets = buffer.split('\n\n'); buffer = packets.pop();
      packets.forEach(packet => { const event = packet.match(/^event: (.+)$/m)?.[1]; const raw = packet.match(/^data: (.+)$/m)?.[1]; if (!raw) return; const data = JSON.parse(raw); if (event === 'progress' && data.line) logText.textContent += `${data.line}\n`; if (event === 'fixed') { logText.textContent += `${data.success ? '✓' : '✗'} ${data.message}\n`; if (data.success) { const title = current?.diagnoses.find(issue => issue.id === data.id)?.title || data.id; recordChange(data.id, title, data.message); } } if (event === 'complete') render(data); });
    }
  } catch (error) {
    logText.textContent = `Error: ${error instanceof Error ? error.message : 'Could not fix the detected errors.'}\n`;
  } finally {
    fixAll.disabled = false;
    fixAll.textContent = 'Fix all safe issues';
  }
}
fixAll.addEventListener('click', fixAllSafeIssues);
downloadProject.addEventListener('click', () => { window.location.assign('/api/project/download'); });
revertAll.addEventListener('click', async () => {
  revertAll.disabled = true; revertAll.textContent = 'Reverting…'; log.hidden = false; logText.textContent = '';
  const response = await fetch('/api/revert', { method: 'POST' });
  const result = await response.json();
  if (!response.ok) { revertAll.disabled = false; revertAll.textContent = 'Revert changes'; logText.textContent = `Error: ${result.message}\n`; return; }
  logText.textContent = `Reverted ${result.restored?.length || 0} file${result.restored?.length === 1 ? '' : 's'}\n`;
  result.restored?.forEach(file => logText.textContent += `  ↩ ${file}\n`);
  changes = [];
  render(result);
  revertAll.disabled = false; revertAll.textContent = 'Revert changes';
});
function keepFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (!normalized.includes('/node_modules/')) return !/(?:^|\/)(?:\.git|dist|coverage)(?:\/|$)/.test(normalized);
  return /\/node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/i.test(normalized);
}
function normalizeEntries(entries) {
  const included = entries.filter(item => keepFile(item.path));
  const first = included[0]?.path.split('/')[0];
  const sharedRoot = first && included.every(item => item.path.split('/').length > 1 && item.path.split('/')[0] === first);
  return included.map(item => ({ ...item, path: sharedRoot ? item.path.split('/').slice(1).join('/') : item.path }));
}
function directoryEntries(entry, prefix = '') {
  return new Promise((resolve, reject) => {
    if (entry.isFile) return entry.file(file => resolve([{ file, path: `${prefix}${file.name}` }]), reject);
    const reader = entry.createReader(); const children = [];
    const read = () => reader.readEntries(batch => {
      if (batch.length) { children.push(...batch); read(); }
      else Promise.all(children.map(child => directoryEntries(child, `${prefix}${entry.name}/`))).then(groups => resolve(groups.flat()), reject);
    }, reject);
    read();
  });
}
async function upload(entries) {
  const files = normalizeEntries(entries);
  if (!files.length) { results.innerHTML = '<p class="failure">That folder did not contain any scannable project files.</p>'; return; }
  changes = [];
  renderChanges();
  results.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Preparing your project for a safe scan…</p></div>';
  const form = new FormData();
  files.forEach(item => form.append('paths', item.path));
  files.forEach(item => form.append('files', item.file, item.file.name));
  const response = await fetch('/api/project', { method: 'POST', body: form });
  const data = await response.json();
  if (!response.ok) { results.innerHTML = `<p class="failure">${esc(data.error || 'Could not scan this folder.')}</p>`; return; }
  render(data);
}
dropZone.addEventListener('click', () => folderInput.click());
dropZone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); folderInput.click(); } });
folderInput.addEventListener('change', () => upload([...folderInput.files].map(file => ({ file, path: file.webkitRelativePath || file.name }))));
['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', async event => {
  const items = [...event.dataTransfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (items.length) return upload((await Promise.all(items.map(item => directoryEntries(item)))).flat());
  upload([...event.dataTransfer.files].map(file => ({ file, path: file.webkitRelativePath || file.name })));
});
scan();
