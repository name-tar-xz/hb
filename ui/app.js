const results = document.querySelector('#results');
const health = document.querySelector('#health');
const target = document.querySelector('#target');
const verifyAll = document.querySelector('#verify-all');
const verifiedPanel = document.querySelector('#verified');
const fixAll = document.querySelector('#fix-all');
const revertAll = document.querySelector('#revert-all');
const downloadProject = document.querySelector('#download-project');
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

function card(issue) {
  const place = issue.file ? `<div class="place">${esc(issue.file)}${issue.line ? `:${issue.line}` : ''}</div>` : '';
  const canFix = issue.autoFixable;
  const action = canFix
    ? `<button type="button" class="fix-one" data-id="${esc(issue.id)}" aria-label="Fix ${esc(issue.title)} automatically">Fix automatically</button>`
    : '<span class="attention">Needs your attention</span>';
  return `<article class="card ${issue.severity}" data-id="${esc(issue.id)}"><div><h2>${esc(issue.title)}</h2>${place}<p>${esc(issue.message)}</p></div><div class="action">${action}</div></article>`;
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
  fixAll.hidden = !hasAutomaticFixes;
  const fixableEnv = open.filter(issue => issue.autoFixable && issue.category === 'env').length;
  verifyAll.hidden = !fixableEnv;
  revertAll.hidden = !scan.canRevert;
  downloadProject.hidden = !scan.canDownload;
  results.innerHTML = open.length ? open.map(card).join('') : '<div class="all-clear"><div>✅</div><h2>All clear!</h2><p>Your environment is healthy.</p></div>';
  renderChanges();
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
  revertAll.hidden = true;
  downloadProject.hidden = true;
  verifyAll.hidden = true;
  verifiedPanel.hidden = true;
  changes = [];
  renderChanges();
  results.innerHTML = '<div class="welcome"><div>📂</div><h2>Choose a project folder</h2><p>Drop a folder above to check its environment.</p></div>';
}
async function fixOne(button) {
  button.disabled = true; button.textContent = 'Fixing…';
  try {
    const response = await fetch('/api/fix', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: button.dataset.id }) });
    const item = await response.json();
    if (!response.ok || !item.fixed) throw new Error(item.error || item.fixMessage || 'Could not fix this issue automatically.');
    const cardEl = button.closest('.card');
    cardEl.classList.add('fixed');
    button.replaceWith(Object.assign(document.createElement('span'), { className: 'fixed-label', textContent: '✅ Fixed' }));
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
    fixAll.textContent = 'Fix all automatically';
  }
}
fixAll.addEventListener('click', fixAllSafeIssues);

const STATUS_ICON = {
  verified: '✅ verified',
  escalated: '↩ escalated',
};
function reproBox(label, run, expected) {
  if (!run) return '';
  const green = run.exitCode === 0;
  return `<div><strong>${esc(label)}</strong> ${green ? '🟢' : '🔴'} exit ${esc(run.exitCode)} `
    + `<span class="sig">stdout ${esc(String(run.stdoutHash || '').slice(0, 12))}`
    + (run.signature ? `<br>${esc(run.signature)}` : '') + '</span></div>';
}
function renderVerified(payload) {
  const receipt = payload.receipt;
  const elapsed = payload.elapsedMs ? (payload.elapsedMs / 1000).toFixed(1) : undefined;
  const rows = (payload.repairs || []).map(repair => `<li>${esc(STATUS_ICON[repair.status] || repair.status)} — ${esc(repair.title)}`
    + `<span class="sig">❯ ${esc(repair.repro?.command || '')}<br>exit ${esc(repair.repro?.before?.exitCode)} → ${esc(repair.repro?.after?.exitCode)}`
    + `${repair.repro?.flipped ? ' · flipped to zero' : repair.repro?.failureMoved ? ' · moved, not cleared' : ' · identical'}`
    + `${repair.rolledBack ? ' · change reverted' : ''}`
    + (repair.warnings?.length ? `<br>⚠ ${esc(repair.warnings.join('; '))}` : '') + '</span></li>').join('');
  const escalations = (payload.escalations || []).map(entry => `<li>⚠ ${esc(entry.title)}<span class="sig">${esc(entry.reason)}</span></li>`).join('');
  const project = payload.projectRepro
    ? `<div class="repro">${reproBox('project before', payload.projectRepro.before)}${reproBox('project after', payload.projectRepro.after)}</div>`
    : '';
  const guarantees = receipt
    ? `receipt ${esc(receipt.id)} · network calls: ${receipt.networkCalls} · env values printed: ${receipt.guarantees.secrets.envValuesPrinted}`
      + ` · redacted: ${receipt.guarantees.secrets.redactedBeforePrinting + receipt.guarantees.secrets.redactedFromOutput} · telemetry: ${esc(receipt.guarantees.telemetry)}`
    : '';
  verifiedPanel.hidden = false;
  verifiedPanel.innerHTML = `<h3>Verified repair</h3>`
    + `<div class="sla">${elapsed ? esc(elapsed) + 's <span>broken to verified</span>' : ''}</div>`
    + `<div class="verdict ${esc(receipt?.verdict || 'unchanged')}">${esc(receipt?.verdict || 'not verified')}</div>`
    + `<div class="repro"><div><strong>command</strong> ${esc(payload.projectRepro?.command || (payload.repairs?.[0]?.repro?.command ?? 'per-finding'))}</div></div>`
    + project
    + (rows ? `<strong>Repairs (kept only when the repro flipped to zero)</strong><ul>${rows}</ul>` : '')
    + (escalations ? `<strong>Needs a human (refused to guess)</strong><ul>${escalations}</ul>` : '')
    + `<div class="guarantees">${guarantees}</div>`;
}
async function runVerifiedRepair() {
  verifyAll.disabled = true;
  verifyAll.textContent = 'Verifying…';
  log.hidden = false;
  logText.textContent = '';
  verifiedPanel.hidden = true;
  const started = Date.now();
  try {
    const response = await fetch('/api/onboard', { method: 'POST' });
    if (!response.ok || !response.body) throw new Error('Could not start the verified repair.');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const packets = buffer.split('\n\n'); buffer = packets.pop();
      packets.forEach(packet => {
        const event = packet.match(/^event: (.+)$/m)?.[1];
        const raw = packet.match(/^data: (.+)$/m)?.[1];
        if (!raw) return;
        const data = JSON.parse(raw);
        if (event === 'progress' && data.line) logText.textContent += `${data.line}\n`;
        if (event === 'failure') logText.textContent += `Error: ${data.message}\n`;
        if (event === 'complete') {
          renderVerified({ ...data, elapsedMs: Date.now() - started });
          render(data.scan);
          changes = (data.repairs || []).filter(r => !r.rolledBack).map(r => ({ id: r.findingId, title: r.title, message: r.message }));
          renderChanges();
        }
      });
    }
  } catch (error) {
    logText.textContent += `Error: ${error instanceof Error ? error.message : 'verified repair failed'}\n`;
  } finally {
    verifyAll.disabled = false;
    verifyAll.textContent = 'Run verified repair';
  }
}
verifyAll.addEventListener('click', runVerifiedRepair);
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
