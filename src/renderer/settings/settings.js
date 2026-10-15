const api = window.grokSettings;
const $ = (id) => document.getElementById(id);

const TOGGLES = ['polish', 'liveCaptions', 'sounds', 'handsFreeOnTap', 'restoreClipboard'];
const SELECTS = ['engine', 'style', 'insertMethod', 'pasteShortcut', 'micDeviceId'];

let state = null;

async function load() {
  state = await api.get();
  const s = state.settings;
  for (const id of TOGGLES) $(id).checked = Boolean(s[id]);
  for (const id of SELECTS) $(id).value = s[id] ?? '';
  $('language').value = s.language || '';
  $('hotkey').textContent = state.hotkeyLabel;
  $('dictionary').value = (s.dictionary || []).join('\n');
  $('polish').disabled = s.engine === 'grok-stt';
  $('vmSoundsHint').classList.toggle('hidden', !state.virtualMachine);
  document.querySelectorAll('.linux-only').forEach((el) => el.classList.toggle('hidden', state.platform !== 'linux'));
  renderKeyStatus();
  renderPerms();
}

function renderKeyStatus() {
  const src = {
    env: 'Using the XAI_API_KEY environment variable.',
    keychain: 'Key saved in your system keychain.',
    file: 'Key saved in the settings file (no system keychain was available).',
    none: 'No key yet.',
  };
  $('keyStatus').textContent = src[state.apiKeySource];
  $('apiKey').placeholder = state.apiKeySource === 'none' ? 'xai-…' : '•••••••• (saved)';
}

async function renderPerms() {
  const perms = await api.permissions();
  const ul = $('perms');
  ul.textContent = '';
  for (const p of perms) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.innerHTML = '';
    const name = document.createElement('strong');
    name.textContent = p.name;
    const detail = document.createElement('div');
    detail.className = 'hint';
    detail.textContent = p.detail || '';
    left.append(name, detail);
    const right = document.createElement('span');
    if (p.action) {
      const b = document.createElement('button');
      b.className = 'secondary';
      b.textContent = p.action;
      b.onclick = async () => { await api.openPermission(p.id); setTimeout(renderPerms, 1500); };
      right.append(b);
    } else {
      right.className = p.ok ? 'ok' : 'bad';
      right.textContent = p.ok ? '✓' : '✕';
    }
    li.append(left, right);
    ul.append(li);
  }
}

async function loadDevices() {
  const res = await api.devices();
  if (!res.ok) return;
  const sel = $('micDeviceId');
  const current = state?.settings.micDeviceId || '';
  sel.textContent = '';
  const def = new Option('System default', '');
  sel.add(def);
  for (const d of res.devices) {
    if (d.id === 'default') continue;
    sel.add(new Option(d.label, d.id));
  }
  sel.value = current;
}

async function update(patch) {
  await api.update(patch);
  await load();
}

for (const id of TOGGLES) $(id).addEventListener('change', (e) => update({ [id]: e.target.checked }));
for (const id of SELECTS) $(id).addEventListener('change', (e) => update({ [id]: e.target.value }));
$('language').addEventListener('change', (e) => update({ language: e.target.value.trim() }));

$('saveKey').onclick = async () => {
  const key = $('apiKey').value.trim();
  if (!key) return;
  await api.setApiKey(key);
  $('apiKey').value = '';
  await load();
  $('keyStatus').textContent += ' Saved.';
};

$('testKey').onclick = async () => {
  $('testKey').disabled = true;
  $('keyStatus').textContent = 'Connecting to Grok Voice…';
  const r = await api.testApiKey();
  $('keyStatus').textContent = r.ok ? `✓ Connected to ${r.model} in ${r.ms} ms.` : `✕ ${r.error}`;
  $('testKey').disabled = false;
};

$('recordHotkey').onclick = async () => {
  const dlg = $('hotkeyDialog');
  dlg.showModal();
  try {
    const r = await api.recordHotkey();
    if (r.ok) $('hotkey').textContent = r.label;
    else alert(r.error);
  } finally {
    dlg.close();
  }
};

$('saveDictionary').onclick = async () => {
  const words = $('dictionary').value.split('\n').map((w) => w.trim()).filter(Boolean).slice(0, 100);
  await update({ dictionary: words });
};

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'history') renderHistory();
  };
});

async function renderHistory() {
  const { entries, usage } = await api.history();
  $('usage').textContent = `${usage.dictations} dictations · ${usage.words.toLocaleString()} words · ≈ $${usage.monthUsd.toFixed(2)} this month · ≈ $${usage.totalUsd.toFixed(2)} all time (estimated from xAI list prices)`;
  const ul = $('historyList');
  ul.textContent = '';
  for (const e of entries) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const when = new Date(e.ts).toLocaleString();
    const left = document.createElement('span');
    left.textContent = `${when}${e.app ? ` · ${e.app}` : ''} · ${e.audioSeconds}s · ${e.engine}${e.polish && e.polish !== 'raw' ? ` · ${e.polish}` : ''}`;
    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.textContent = 'Copy';
    copy.onclick = () => api.copy(e.text);
    meta.append(left, copy);
    const text = document.createElement('p');
    text.className = 'text';
    text.textContent = e.text;
    li.append(meta, text);
    if (e.raw && e.raw !== e.text) {
      const raw = document.createElement('div');
      raw.className = 'raw';
      raw.textContent = `Heard: ${e.raw}`;
      li.append(raw);
    }
    ul.append(li);
  }
}

$('clearHistory').onclick = async () => {
  if (!confirm('Delete all local dictation history?')) return;
  await api.clearHistory();
  renderHistory();
};

api.onChange(load);
load().then(loadDevices);
