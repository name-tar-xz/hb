const results = document.querySelector('#results');
const health = document.querySelector('#health');
const target = document.querySelector('#target');
const fixAll = document.querySelector('#fix-all');
const revertAll = document.querySelector('#revert-all');
const log = document.querySelector('#log');
const logText = log.querySelector('pre');
const dropZone = document.querySelector('#drop-zone');
const folderInput = document.querySelector('#folder-input');
const uploadNote = document.querySelector('#upload-note');
let current;
const esc = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function card(issue) {
  const place = issue.file ? `<div class="place">${esc(issue.file)}${issue.line ? `:${issue.line}` : ''}</div>` : '';
  const action = issue.autoFixable && !current?.uploaded ? `<button class="fix-one" data-id="${esc(issue.id)}">Fix</button>` : '<span class="attention">Needs your attention</span>';
  return `<article class="card ${issue.severity}" data-id="${esc(issue.id)}"><div><h2>${esc(issue.title)}</h2>${place}<p>${esc(issue.message)}</p></div><div class="action">${action}</div></article>`;
}
function render(scan) {
  current = scan;
  target.textContent = `Scanning: ${scan.displayName || scan.targetDir}`;
  uploadNote.hidden = !scan.uploaded;
  const open = scan.diagnoses.filter(item => !item.fixed);
  const errors = open.filter(item => item.severity === 'error').length;
  const warnings = open.filter(item => item.severity === 'warning').length;
  health.className = `health ${errors ? 'bad' : warnings ? 'caution' : 'good'}`;
  health.querySelector('span').textContent = open.length ? `${open.length} issue${open.length === 1 ? '' : 's'} found` : 'All clear ✅';
  fixAll.hidden = scan.uploaded || !open.some(item => item.autoFixable);
  revertAll.hidden = scan.uploaded;
  results.innerHTML = open.length ? open.map(card).join('') : '<div class="all-clear"><div>✅</div><h2>All clear!</h2><p>Your environment is healthy.</p></div>';
}
async function scan() {
  results.innerHTML = '<div class="spinner"></div><p>Running a health check…</p>';
  try { render(await (await fetch('/api/scan')).json()); } catch { results.innerHTML = '<p class="failure">Could not scan this folder. Please refresh to retry.</p>'; }
}
function showEmptyState() {
  target.textContent = 'No project selected yet';
  health.className = 'health loading';
  health.querySelector('span').textContent = 'Ready to scan';
  fixAll.hidden = true;
  results.innerHTML = '<div class="welcome"><div>📂</div><h2>Choose a project folder</h2><p>Drop a folder above to check its environment.</p></div>';
}
async function fixOne(button) {
  button.disabled = true; button.textContent = 'Fixing…';
  const response = await fetch('/api/fix', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: button.dataset.id }) });
  const item = await response.json();
  if (!response.ok) { button.disabled = false; button.textContent = 'Try again'; return; }
  const cardEl = button.closest('.card');
  cardEl.classList.add(item.fixed ? 'fixed' : 'failed');
  button.replaceWith(Object.assign(document.createElement('span'), { className: 'fixed-label', textContent: item.fixed ? '✅ Fixed' : 'Could not fix' }));
  setTimeout(scan, 350);
}
results.addEventListener('click', event => { const button = event.target.closest('.fix-one'); if (button) fixOne(button); });
fixAll.addEventListener('click', async () => {
  fixAll.disabled = true; log.hidden = false; logText.textContent = '';
  const response = await fetch('/api/fix-all', { method: 'POST' });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split('\n\n'); buffer = packets.pop();
    packets.forEach(packet => { const event = packet.match(/^event: (.+)$/m)?.[1]; const raw = packet.match(/^data: (.+)$/m)?.[1]; if (!raw) return; const data = JSON.parse(raw); if (event === 'progress' && data.line) logText.textContent += `${data.line}\n`; if (event === 'fixed') logText.textContent += `${data.success ? '✓' : '✗'} ${data.message}\n`; if (event === 'complete') render(data); });
  }
  fixAll.disabled = false;
});
revertAll.addEventListener('click', async () => {
  revertAll.disabled = true; revertAll.textContent = 'Reverting…'; log.hidden = false; logText.textContent = '';
  const response = await fetch('/api/revert', { method: 'POST' });
  const result = await response.json();
  if (!response.ok) { revertAll.disabled = false; revertAll.textContent = 'Revert changes'; logText.textContent = `Error: ${result.message}\n`; return; }
  logText.textContent = `Reverted ${result.restored?.length || 0} file${result.restored?.length === 1 ? '' : 's'}\n`;
  result.restored?.forEach(file => logText.textContent += `  ↩ ${file}\n`);
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
  results.innerHTML = '<div class="spinner"></div><p>Preparing your project for a safe scan…</p>';
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
showEmptyState();
