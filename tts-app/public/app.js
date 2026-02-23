/**
 * Claude Code Hooks Manager — Client-side logic
 * Fetches config/providers/templates from the server API and renders UI panels.
 */

// ── State ─────────────────────────────────────────────────────────────
let config = {};
let defaults = {};
let defaultTemplates = {};
let providers = [];
let templates = {};
let envStatus = {};
let availableTones = [];
let activeTemplateHook = 'stop';
let activityLogData = { entries: [], total: 0, sessions: {} };
let activityPollInterval = null;
let runningPort = null;

// ── Constants ─────────────────────────────────────────────────────────
const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

const PROVIDER_META = {
  'native': {
    displayName: 'Native',
    description: 'macOS built-in speech synthesis. No API key required.',
    envKey: null,
    url: null,
    settings: [
      { id: 'native-voice', label: 'Voice', type: 'text', configPath: 'native.voice' },
      { id: 'native-rate', label: 'Speech Rate', type: 'number', configPath: 'native.rate', min: 80, max: 400 },
    ],
  },
  'elevenlabs': {
    displayName: 'ElevenLabs',
    description: 'High-quality AI voice synthesis.',
    envKey: 'ELEVENLABS_API_KEY',
    url: 'https://elevenlabs.io',
    settings: [
      { id: 'elevenlabs-voiceId', label: 'Voice ID', type: 'text', configPath: 'elevenlabs.voiceId' },
      { id: 'elevenlabs-modelId', label: 'Model ID', type: 'text', configPath: 'elevenlabs.modelId' },
    ],
  },
  'openai': {
    displayName: 'OpenAI',
    description: 'OpenAI text-to-speech API.',
    envKey: 'OPENAI_API_KEY',
    url: 'https://platform.openai.com',
    settings: [
      { id: 'openai-voice', label: 'Voice', type: 'select', configPath: 'openai.voice',
        options: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
      { id: 'openai-model', label: 'Model', type: 'select', configPath: 'openai.model',
        options: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'] },
    ],
  },
  'unreal-speech': {
    displayName: 'Unreal Speech',
    description: 'Ultra-realistic voice synthesis.',
    envKey: 'UNREAL_SPEECH_API_KEY',
    url: 'https://unrealspeech.com',
    settings: [
      { id: 'unrealSpeech-voice', label: 'Voice', type: 'select', configPath: 'unrealSpeech.voice',
        options: ['Scarlett', 'Dan', 'Liv', 'Will', 'Amy', 'Noah', 'Ethan', 'Daniel', 'Lauren', 'Melody', 'Sierra', 'Luna', 'Hannah', 'Chloe'] },
      { id: 'unrealSpeech-temperature', label: 'Temperature', type: 'number', configPath: 'unrealSpeech.temperature', min: 0, max: 1, step: 0.05 },
    ],
  },
  'deepseek': {
    displayName: 'DeepSeek',
    description: 'DeepSeek voice synthesis.',
    envKey: 'DEEPSEEK_API_KEY',
    url: 'https://platform.deepseek.com',
    settings: [
      { id: 'deepseek-endpoint', label: 'Endpoint URL', type: 'text', configPath: 'deepseek.endpoint' },
    ],
  },
};

// ── API Helpers ───────────────────────────────────────────────────────
const api = {
  async get(path) {
    const res = await fetch(path);
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  try {
    const [configData, providerData, templateData, envData, defaultData, serverInfo] = await Promise.all([
      api.get('/api/config'),
      api.get('/api/providers'),
      api.get('/api/templates'),
      api.get('/api/env-status'),
      api.get('/api/defaults'),
      api.get('/api/server-info'),
    ]);

    config = configData;
    providers = providerData;
    templates = templateData;
    envStatus = envData;
    defaults = defaultData.config;
    defaultTemplates = defaultData.templates;
    availableTones = defaultData.availableTones || ['default', 'professional', 'concise', 'playful'];
    runningPort = serverInfo.port;

    renderProviders();
    renderTemplates();
    renderTestHarness();
    renderSettings();
    renderSecurity();
    initActivityLog();

    setStatus('Connected', 'ok');
  } catch (err) {
    setStatus('Failed to connect to server', 'error');
    console.error('Init error:', err);
  }
}

// ── Tab Navigation ────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById(`panel-${tab.dataset.panel}`).classList.add('active');
  });
});

// ── Template Tab Navigation ───────────────────────────────────────────
document.getElementById('template-tabs').addEventListener('click', (e) => {
  if (!e.target.classList.contains('template-tab')) return;
  document.querySelectorAll('.template-tab').forEach(t => t.classList.remove('active'));
  e.target.classList.add('active');
  activeTemplateHook = e.target.dataset.hook;
  renderTemplateEditor();
});

// ── Variable chip click-to-insert ─────────────────────────────────────
let lastFocusedTextarea = null;

// Track last focused template textarea (event delegation for dynamic elements)
document.addEventListener('focusin', (e) => {
  if (e.target.classList?.contains('template-textarea')) {
    lastFocusedTextarea = e.target;
    // Pulse the var-chips twice to hint they're insertable
    document.querySelectorAll('.var-chip').forEach(chip => {
      chip.classList.remove('pulse');
      // Force reflow so re-adding the class restarts the animation
      void chip.offsetWidth;
      chip.classList.add('pulse');
    });
  }
});

// Insert variable at cursor on chip click
document.querySelectorAll('.var-chip').forEach(chip => {
  chip.addEventListener('mousedown', (e) => {
    // Prevent the click from stealing focus away from the textarea
    e.preventDefault();
  });
  chip.addEventListener('click', () => {
    if (!lastFocusedTextarea) return;
    const ta = lastFocusedTextarea;
    const varText = `{{${chip.dataset.var}}}`;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + varText + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + varText.length;
    ta.focus();
  });
});

// ── Panel 1: Providers (unified: priority + keys + settings) ─────────

/** Resolve a dotted path against config.tts */
function getTTSConfigValue(path) {
  return path.split('.').reduce((o, k) => o?.[k], config.tts);
}

/** Render a single settings field (input or select) */
function renderSettingsField(f) {
  const value = getTTSConfigValue(f.configPath) ?? '';
  if (f.type === 'select') {
    const opts = (f.options || []).map(o =>
      `<option value="${o}" ${String(o) === String(value) ? 'selected' : ''}>${o}</option>`
    ).join('');
    return `<div class="form-group"><label>${f.label}</label><select id="ps-${f.id}">${opts}</select></div>`;
  }
  const attrs = [];
  if (f.min !== undefined) attrs.push(`min="${f.min}"`);
  if (f.max !== undefined) attrs.push(`max="${f.max}"`);
  if (f.step !== undefined) attrs.push(`step="${f.step}"`);
  return `<div class="form-group"><label>${f.label}</label><input type="${f.type}" id="ps-${f.id}" value="${value}" ${attrs.join(' ')}></div>`;
}

function renderProviders() {
  const list = document.getElementById('provider-list');
  const priority = config.tts?.providerPriority ?? [];
  const availMap = {};
  providers.forEach(p => availMap[p.name] = p.available);

  let html = priority.map((name, i) => {
    const meta = PROVIDER_META[name] || { displayName: name, description: '', envKey: null, settings: [] };
    const avail = availMap[name] ?? false;
    const envKey = meta.envKey;
    const keySet = envKey ? (envStatus[envKey] ?? false) : null;

    // Description with API key status as second sentence
    let desc = meta.description;
    if (envKey) {
      desc += keySet ? ' API key is configured.' : ' API key not set.';
    }

    // Chevron toggle
    const chevronHtml = `<button class="provider-expand-toggle" data-provider="${name}" title="Configure">${CHEVRON_SVG}</button>`;

    // Expandable panel contents
    const urlHtml = meta.url
      ? `<div class="provider-url"><a href="${meta.url}" target="_blank" rel="noopener">${meta.url}</a></div>`
      : '';

    const keyRowHtml = envKey
      ? `<div class="provider-key-row">
           <input type="password" placeholder="${keySet ? '(key is set — enter new value to update)' : 'Paste API key...'}" data-env-key="${envKey}">
           <button class="btn btn-sm btn-primary provider-key-save" data-env-key="${envKey}">Save Key</button>
           <span class="provider-key-status" id="key-status-${name}"></span>
         </div>`
      : '';

    const settingsHtml = meta.settings.length
      ? `<div class="provider-settings-inline">${meta.settings.map(renderSettingsField).join('')}</div>`
      : '';

    return `
      <div class="provider-item" draggable="true" data-provider="${name}">
        <div class="provider-row">
          <div class="provider-dot ${avail ? 'available' : 'unavailable'}"></div>
          <div class="provider-info">
            <span class="provider-name">${meta.displayName}</span>
            <span class="provider-desc">${desc}</span>
          </div>
          ${chevronHtml}
          <span class="provider-order">#${i + 1}</span>
          <div class="provider-arrows">
            <button data-dir="up" data-idx="${i}" title="Move up">&uarr;</button>
            <button data-dir="down" data-idx="${i}" title="Move down">&darr;</button>
          </div>
        </div>
        <div class="provider-expand-panel">
          ${urlHtml}
          ${keyRowHtml}
          ${settingsHtml}
        </div>
      </div>
    `;
  }).join('');

  // Anthropic — supplementary row (for LLM summarization, not a TTS provider)
  const anthropicKeySet = envStatus['ANTHROPIC_API_KEY'] ?? false;
  html += `
    <div class="provider-item provider-item-supplementary" data-provider="anthropic">
      <div class="provider-row">
        <div class="provider-dot ${anthropicKeySet ? 'available' : 'unavailable'}"></div>
        <div class="provider-info">
          <span class="provider-name">Anthropic</span>
          <span class="provider-desc">Used for LLM summarization. ${anthropicKeySet ? 'API key is configured.' : 'API key not set.'}</span>
        </div>
        <button class="provider-expand-toggle" data-provider="anthropic" title="Configure">${CHEVRON_SVG}</button>
      </div>
      <div class="provider-expand-panel">
        <div class="provider-url"><a href="https://console.anthropic.com" target="_blank" rel="noopener">https://console.anthropic.com</a></div>
        <div class="provider-key-row">
          <input type="password" placeholder="${anthropicKeySet ? '(key is set — enter new value to update)' : 'Paste API key...'}" data-env-key="ANTHROPIC_API_KEY">
          <button class="btn btn-sm btn-primary provider-key-save" data-env-key="ANTHROPIC_API_KEY">Save Key</button>
          <span class="provider-key-status" id="key-status-anthropic"></span>
        </div>
      </div>
    </div>
  `;

  list.innerHTML = html;

  // Arrow button handlers
  list.querySelectorAll('.provider-arrows button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      const dir = btn.dataset.dir;
      const arr = [...config.tts.providerPriority];
      const targetIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= arr.length) return;
      [arr[idx], arr[targetIdx]] = [arr[targetIdx], arr[idx]];
      config.tts.providerPriority = arr;
      saveProviderPriority(arr);
    });
  });

  // Expand/collapse toggle handlers
  list.querySelectorAll('.provider-expand-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = btn.closest('.provider-item');
      item.classList.toggle('expanded');
    });
  });

  // Individual key save handlers
  list.querySelectorAll('.provider-key-save').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const envKey = btn.dataset.envKey;
      const input = btn.parentElement.querySelector(`[data-env-key="${envKey}"]`);
      const value = input?.value?.trim();
      if (!value) return;

      const statusEl = btn.parentElement.querySelector('.provider-key-status');
      try {
        const result = await api.put('/api/env-keys', { [envKey]: value });
        if (result.ok) {
          envStatus = result.envStatus;
          providers = await api.get('/api/providers');
          input.value = '';
          renderProviders();
          renderTestHarness();
          setStatus('API key saved', 'ok');
        } else {
          if (statusEl) { statusEl.textContent = `Error: ${result.error}`; statusEl.className = 'provider-key-status error'; }
        }
      } catch (err) {
        if (statusEl) { statusEl.textContent = `Error: ${err.message}`; statusEl.className = 'provider-key-status error'; }
      }
    });
  });

  // Auto-save provider settings (voice, model, temperature, etc.) on change
  list.querySelectorAll('.provider-settings-inline select, .provider-settings-inline input').forEach(el => {
    el.addEventListener('change', async () => {
      const updates = { tts: {} };
      // Collect all current provider setting values
      const collect = (prefix, keys) => {
        const obj = {};
        let any = false;
        for (const k of keys) {
          const input = document.getElementById(`ps-${prefix}-${k}`);
          if (!input || input.value === '') continue;
          if (input.type === 'number') {
            const num = parseFloat(input.value);
            if (!isNaN(num)) { obj[k] = num; any = true; }
          } else {
            obj[k] = input.value; any = true;
          }
        }
        if (any) updates.tts[prefix] = obj;
      };
      collect('native', ['voice', 'rate']);
      collect('elevenlabs', ['voiceId', 'modelId']);
      collect('openai', ['voice', 'model']);
      collect('unrealSpeech', ['voice', 'temperature']);
      collect('deepseek', ['endpoint']);

      const result = await api.put('/api/config', updates);
      if (result.ok) {
        config = result.config;
        setStatus('Provider settings saved', 'ok');
      } else {
        setStatus(`Save failed: ${result.error}`, 'error');
      }
    });
  });

  // Drag and drop (only draggable TTS provider items)
  setupDragAndDrop(list);
}

function setupDragAndDrop(list) {
  let dragIdx = null;
  const items = list.querySelectorAll('.provider-item[draggable="true"]');

  items.forEach((item, idx) => {
    item.addEventListener('dragstart', () => {
      dragIdx = idx;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dragIdx = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragIdx === null || dragIdx === idx) return;
      const arr = [...config.tts.providerPriority];
      const [moved] = arr.splice(dragIdx, 1);
      arr.splice(idx, 0, moved);
      config.tts.providerPriority = arr;
      saveProviderPriority(arr);
    });
  });
}

async function saveProviderPriority(arr) {
  await api.put('/api/config', { tts: { providerPriority: arr } });
  renderProviders();
  setStatus('Provider priority saved', 'ok');
}

// ── Panel 2: Templates ────────────────────────────────────────────────
function renderTemplates() {
  // Populate tone dropdown
  const toneSelect = document.getElementById('template-tone');
  if (toneSelect) {
    toneSelect.innerHTML = availableTones.map(t =>
      `<option value="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</option>`
    ).join('');
    toneSelect.value = config.tts?.templateTone ?? 'default';

    // Live-switch tone on change
    toneSelect.onchange = async () => {
      const tone = toneSelect.value;
      await api.put('/api/config', { tts: { templateTone: tone } });
      config.tts.templateTone = tone;
      templates = await api.get('/api/templates');
      renderTemplateEditor();
      setStatus(`Tone changed to ${tone}`, 'ok');
    };
  }

  renderTemplateEditor();
}

function renderTemplateEditor() {
  const container = document.getElementById('template-editor');
  const hookTemplates = templates[activeTemplateHook];

  if (!hookTemplates) {
    container.innerHTML = '<p class="panel-desc">No templates found for this hook.</p>';
    return;
  }

  container.innerHTML = '';

  if (activeTemplateHook === 'stop') {
    renderStopTemplates(container, hookTemplates);
  } else if (activeTemplateHook === 'subagentStop') {
    renderSubagentStopTemplates(container, hookTemplates);
  } else if (activeTemplateHook === 'notification') {
    renderNotificationTemplates(container, hookTemplates);
  } else if (activeTemplateHook === 'sessionEnd') {
    renderSessionEndTemplates(container, hookTemplates);
  }
}

function renderStopTemplates(container, t) {
  const pairs = [
    { label: 'With Activities - Single',
      withName: { path: 'withActivities.single.withName', data: t.withActivities?.single?.withName },
      withoutName: { path: 'withActivities.single.withoutName', data: t.withActivities?.single?.withoutName } },
    { label: 'With Activities - Multiple',
      withName: { path: 'withActivities.multiple.withName', data: t.withActivities?.multiple?.withName },
      withoutName: { path: 'withActivities.multiple.withoutName', data: t.withActivities?.multiple?.withoutName } },
    { label: 'No Activities',
      withName: { path: 'noActivities.withName', data: t.noActivities?.withName },
      withoutName: { path: 'noActivities.withoutName', data: t.noActivities?.withoutName } },
  ];

  pairs.forEach(p => renderNamePairedGroup(container, p));
}

function renderSubagentStopTemplates(container, t) {
  const pairs = [
    { label: 'With Description',
      withName: { path: 'withDescription.withName', data: t.withDescription?.withName },
      withoutName: { path: 'withDescription.withoutName', data: t.withDescription?.withoutName } },
    { label: 'No Description',
      withName: { path: 'noDescription.withName', data: t.noDescription?.withName },
      withoutName: { path: 'noDescription.withoutName', data: t.noDescription?.withoutName } },
  ];

  pairs.forEach(p => renderNamePairedGroup(container, p));
}

function renderNamePairedGroup(container, pair) {
  const div = document.createElement('div');
  div.className = 'template-group';

  const withNameArr = Array.isArray(pair.withName.data) ? pair.withName.data : [];
  const withoutNameArr = Array.isArray(pair.withoutName.data) ? pair.withoutName.data : [];

  div.innerHTML = `
    <h4>${pair.label}</h4>
    <div class="name-tabs">
      <button class="name-tab active" data-target="withName">With Name</button>
      <button class="name-tab" data-target="withoutName">Without Name</button>
    </div>
    <div class="name-pane active" data-name="withName">
      <textarea rows="${Math.max(3, withNameArr.length + 1)}"
        data-hook="${activeTemplateHook}"
        data-path="${pair.withName.path}"
        class="template-textarea">${withNameArr.join('\n')}</textarea>
      <div class="template-preview">Preview: <em>${renderPreview(withNameArr[0] ?? '')}</em></div>
    </div>
    <div class="name-pane" data-name="withoutName">
      <textarea rows="${Math.max(3, withoutNameArr.length + 1)}"
        data-hook="${activeTemplateHook}"
        data-path="${pair.withoutName.path}"
        class="template-textarea">${withoutNameArr.join('\n')}</textarea>
      <div class="template-preview">Preview: <em>${renderPreview(withoutNameArr[0] ?? '')}</em></div>
    </div>
  `;

  // Wire inner tab switching
  div.querySelectorAll('.name-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      div.querySelectorAll('.name-tab').forEach(t => t.classList.remove('active'));
      div.querySelectorAll('.name-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      div.querySelector(`.name-pane[data-name="${tab.dataset.target}"]`).classList.add('active');
    });
  });

  container.appendChild(div);
}

function renderArrayTemplateGroup(container, group) {
  const div = document.createElement('div');
  div.className = 'template-group';

  const dataArr = Array.isArray(group.data) ? group.data : [];
  const textareaValue = dataArr.join('\n');

  div.innerHTML = `
    <h4>${group.label}</h4>
    <textarea rows="${Math.max(3, dataArr.length + 1)}"
      data-hook="${activeTemplateHook}"
      data-path="${group.path}"
      class="template-textarea">${textareaValue}</textarea>
    <div class="template-preview">Preview: <em>${renderPreview(dataArr[0] ?? '')}</em></div>
  `;

  container.appendChild(div);
}

function renderNotificationTemplates(container, t) {
  const div = document.createElement('div');
  div.className = 'template-group';

  div.innerHTML = `
    <h4>Notification</h4>
    <div class="name-tabs">
      <button class="name-tab active" data-target="withName">With Name</button>
      <button class="name-tab" data-target="withoutName">Without Name</button>
    </div>
    <div class="name-pane active" data-name="withName">
      <textarea rows="2"
        data-hook="notification"
        data-path="withName"
        class="template-textarea">${t.withName ?? ''}</textarea>
      <div class="template-preview">Preview: <em>${renderPreview(String(t.withName ?? ''))}</em></div>
    </div>
    <div class="name-pane" data-name="withoutName">
      <textarea rows="2"
        data-hook="notification"
        data-path="withoutName"
        class="template-textarea">${t.withoutName ?? ''}</textarea>
      <div class="template-preview">Preview: <em>${renderPreview(String(t.withoutName ?? ''))}</em></div>
    </div>
  `;

  div.querySelectorAll('.name-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      div.querySelectorAll('.name-tab').forEach(t => t.classList.remove('active'));
      div.querySelectorAll('.name-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      div.querySelector(`.name-pane[data-name="${tab.dataset.target}"]`).classList.add('active');
    });
  });

  container.appendChild(div);
}

function renderSimpleTemplate(container, t, hookName) {
  const fields = Object.entries(t);

  fields.forEach(([key, value]) => {
    const div = document.createElement('div');
    div.className = 'template-group';
    div.innerHTML = `
      <h4>${key}</h4>
      <textarea rows="2"
        data-hook="${hookName}"
        data-path="${key}"
        class="template-textarea">${value}</textarea>
      <div class="template-preview">Preview: <em>${renderPreview(String(value))}</em></div>
    `;
    container.appendChild(div);
  });
}

function renderSessionEndTemplates(container, t) {
  renderSimpleTemplate(container, t, 'sessionEnd');
}

function renderPreview(template) {
  const vars = {
    projectName: 'CLI-v1',
    userName: 'Elvis',
    activity: 'updated the config',
    lastActivity: 'ran the tests',
    count: '3',
    agentName: 'Explorer',
    description: 'searching the codebase',
  };
  let result = template;
  Object.entries(vars).forEach(([k, v]) => {
    result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  });
  return escapeHtml(result);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Save templates
document.getElementById('btn-save-templates').addEventListener('click', async () => {
  const textareas = document.querySelectorAll('.template-textarea');
  const overrides = {};

  textareas.forEach(ta => {
    const hook = ta.dataset.hook;
    const path = ta.dataset.path;
    const value = ta.value.trim();

    if (!overrides[hook]) overrides[hook] = {};

    // For array templates (multi-line), split by newline
    const parts = path.split('.');
    let target = overrides[hook];
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]]) target[parts[i]] = {};
      target = target[parts[i]];
    }

    const lastKey = parts[parts.length - 1];
    // Detect if original was an array (stop, subagentStop arrays)
    const originalValue = getNestedValue(templates, `${hook}.${path}`);
    if (Array.isArray(originalValue)) {
      target[lastKey] = value.split('\n').filter(l => l.trim());
    } else {
      target[lastKey] = value;
    }
  });

  await api.put('/api/templates', overrides);
  templates = await api.get('/api/templates');
  renderTemplateEditor();
  setStatus('Templates saved', 'ok');
});

// Reset templates
document.getElementById('btn-reset-templates').addEventListener('click', async () => {
  await api.put('/api/templates', {});
  templates = await api.get('/api/templates');
  renderTemplateEditor();
  setStatus('Templates reset to defaults', 'ok');
});

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Panel 3: Test Harness ─────────────────────────────────────────────
function renderTestHarness() {
  const select = document.getElementById('test-provider');
  // Clear existing options except the first
  while (select.options.length > 1) select.remove(1);

  providers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = `${p.name} ${p.available ? '' : '(unavailable)'}`;
    opt.disabled = !p.available;
    select.appendChild(opt);
  });
}

document.getElementById('btn-speak').addEventListener('click', async () => {
  const text = document.getElementById('test-text').value.trim();
  if (!text) return;

  const provider = document.getElementById('test-provider').value || undefined;
  const resultEl = document.getElementById('test-result');
  resultEl.textContent = 'Speaking...';
  resultEl.className = 'test-result';

  try {
    const result = await api.post('/api/tts/test', { text, provider });
    if (result.ok) {
      resultEl.textContent = `OK: ${result.provider} (${result.duration}ms)`;
      resultEl.className = 'test-result success';
    } else {
      resultEl.textContent = `Error: ${result.error}`;
      resultEl.className = 'test-result error';
    }
  } catch (err) {
    resultEl.textContent = `Error: ${err.message}`;
    resultEl.className = 'test-result error';
  }
});

// Quick test buttons
document.getElementById('quick-tests').addEventListener('click', (e) => {
  if (!e.target.dataset.text) return;
  document.getElementById('test-text').value = e.target.dataset.text;
  document.getElementById('btn-speak').click();
});

// ── Panel 4: Settings ─────────────────────────────────────────────────
function renderSettings() {
  const c = config;

  // Server port
  setValue('server-port', c.server?.port ?? 3455);
  document.getElementById('server-port-notice').style.display = 'none';

  // Your name
  setValue('tts-userName', c.tts?.userName ?? '');

  // Template variables — Project Name
  const projectNameVal = c.project?.name ?? '';
  setValue('project-name', projectNameVal);
  const projectNameInput = document.getElementById('project-name');
  const projectNameCount = document.getElementById('project-name-count');
  projectNameCount.textContent = `${projectNameVal.length} / 50`;
  projectNameInput.addEventListener('input', () => {
    projectNameCount.textContent = `${projectNameInput.value.length} / 50`;
  });

  // Name include probability
  const nameProbSlider = document.getElementById('nameIncludeProbability');
  nameProbSlider.value = c.tts?.nameIncludeProbability ?? 0.3;
  document.getElementById('nameProb-val').textContent = nameProbSlider.value;
  nameProbSlider.addEventListener('input', () => {
    document.getElementById('nameProb-val').textContent = nameProbSlider.value;
  });

  // TTS toggles
  setChecked('tts-enabled', c.tts?.enabled ?? true);
  setChecked('toggle-stop', c.tts?.hookToggles?.stop ?? true);
  setChecked('toggle-subagentStop', c.tts?.hookToggles?.subagentStop ?? true);
  setChecked('toggle-notification', c.tts?.hookToggles?.notification ?? true);
  setChecked('toggle-sessionEnd', c.tts?.hookToggles?.sessionEnd ?? true);

  // LLM
  setValue('llm-anthropic-model', c.llm?.anthropic?.model ?? '');
  setValue('llm-anthropic-maxTokens', c.llm?.anthropic?.maxTokens ?? '');
  setValue('llm-anthropic-temperature', c.llm?.anthropic?.temperature ?? '');
  setValue('llm-openai-model', c.llm?.openai?.model ?? '');
  setValue('llm-openai-maxTokens', c.llm?.openai?.maxTokens ?? '');
  setValue('llm-openai-temperature', c.llm?.openai?.temperature ?? '');

  // Summarization
  setChecked('summarization-enabled', c.summarization?.enabled ?? true);
  setValue('summarization-maxWords', c.summarization?.maxWords ?? '');
  setSelectValue('summarization-style', c.summarization?.style ?? 'concise');

  // Queue
  setChecked('queue-enabled', c.tts?.queue?.enabled ?? true);
  const queueSlider = document.getElementById('queue-maxWaitMs');
  queueSlider.value = c.tts?.queue?.maxWaitMs ?? 30000;
  document.getElementById('queue-maxWaitMs-val').textContent = `${queueSlider.value}ms`;
  queueSlider.addEventListener('input', () => {
    document.getElementById('queue-maxWaitMs-val').textContent = `${queueSlider.value}ms`;
  });

  // Guardrails
  setChecked('guardrails-enabled', c.guardrails?.enabled ?? true);
  setChecked('guardrails-sleep-enabled', c.guardrails?.sleep?.enabled ?? true);
  setValue('guardrails-sleep-maxSeconds', c.guardrails?.sleep?.maxSeconds ?? '');
  setChecked('guardrails-subagentRepeat-enabled', c.guardrails?.subagentRepeat?.enabled ?? true);
  setValue('guardrails-subagentRepeat-maxLaunches', c.guardrails?.subagentRepeat?.maxLaunches ?? '');
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const newPort = parseInt(document.getElementById('server-port').value) || 3455;
  const projectNameRaw = getValue('project-name').trim();
  const updates = {
    server: { port: newPort },
    project: { name: projectNameRaw || null },
    tts: {
      enabled: isChecked('tts-enabled'),
      userName: getValue('tts-userName'),
      nameIncludeProbability: parseFloat(document.getElementById('nameIncludeProbability').value),
      hookToggles: {
        stop: isChecked('toggle-stop'),
        subagentStop: isChecked('toggle-subagentStop'),
        notification: isChecked('toggle-notification'),
        sessionEnd: isChecked('toggle-sessionEnd'),
      },
      queue: {
        enabled: isChecked('queue-enabled'),
        maxWaitMs: parseInt(document.getElementById('queue-maxWaitMs').value),
      },
    },
    llm: {
      anthropic: {
        model: getValue('llm-anthropic-model'),
        maxTokens: parseInt(getValue('llm-anthropic-maxTokens')) || undefined,
        temperature: parseFloat(getValue('llm-anthropic-temperature')) || undefined,
      },
      openai: {
        model: getValue('llm-openai-model'),
        maxTokens: parseInt(getValue('llm-openai-maxTokens')) || undefined,
        temperature: parseFloat(getValue('llm-openai-temperature')) || undefined,
      },
    },
    summarization: {
      enabled: isChecked('summarization-enabled'),
      maxWords: parseInt(getValue('summarization-maxWords')) || undefined,
      style: getValue('summarization-style') || undefined,
    },
    guardrails: {
      enabled: isChecked('guardrails-enabled'),
      sleep: {
        enabled: isChecked('guardrails-sleep-enabled'),
        maxSeconds: parseInt(getValue('guardrails-sleep-maxSeconds')) || undefined,
      },
      subagentRepeat: {
        enabled: isChecked('guardrails-subagentRepeat-enabled'),
        maxLaunches: parseInt(getValue('guardrails-subagentRepeat-maxLaunches')) || undefined,
      },
    },
  };

  // Also save provider settings from inline provider rows
  const psNativeVoice = getValue('ps-native-voice');
  const psNativeRate = parseInt(getValue('ps-native-rate'));
  if (psNativeVoice || psNativeRate) {
    updates.tts.native = {};
    if (psNativeVoice) updates.tts.native.voice = psNativeVoice;
    if (psNativeRate) updates.tts.native.rate = psNativeRate;
  }

  const psElVoice = getValue('ps-elevenlabs-voiceId');
  const psElModel = getValue('ps-elevenlabs-modelId');
  if (psElVoice || psElModel) {
    updates.tts.elevenlabs = {};
    if (psElVoice) updates.tts.elevenlabs.voiceId = psElVoice;
    if (psElModel) updates.tts.elevenlabs.modelId = psElModel;
  }

  const psOaiVoice = getValue('ps-openai-voice');
  const psOaiModel = getValue('ps-openai-model');
  if (psOaiVoice || psOaiModel) {
    updates.tts.openai = {};
    if (psOaiVoice) updates.tts.openai.voice = psOaiVoice;
    if (psOaiModel) updates.tts.openai.model = psOaiModel;
  }

  const psUsVoice = getValue('ps-unrealSpeech-voice');
  const psUsTemp = parseFloat(getValue('ps-unrealSpeech-temperature'));
  if (psUsVoice || !isNaN(psUsTemp)) {
    updates.tts.unrealSpeech = {};
    if (psUsVoice) updates.tts.unrealSpeech.voice = psUsVoice;
    if (!isNaN(psUsTemp)) updates.tts.unrealSpeech.temperature = psUsTemp;
  }

  const psDsEndpoint = getValue('ps-deepseek-endpoint');
  if (psDsEndpoint) {
    updates.tts.deepseek = { endpoint: psDsEndpoint };
  }

  const result = await api.put('/api/config', updates);
  if (result.ok) {
    config = result.config;
    setStatus('Settings saved', 'ok');
    // Show restart notice if port changed from the running port
    if (runningPort && newPort !== runningPort) {
      document.getElementById('server-port-notice').style.display = 'block';
    } else {
      document.getElementById('server-port-notice').style.display = 'none';
    }
  } else {
    setStatus(`Save failed: ${result.error}`, 'error');
  }
});

document.getElementById('btn-reset-settings').addEventListener('click', async () => {
  const result = await api.put('/api/config', defaults);
  if (result.ok) {
    config = result.config;
    renderSettings();
    renderProviders();
    setStatus('Settings reset to defaults', 'ok');
  }
});

// ── Panel 5: Security ─────────────────────────────────────────────────
function renderSecurity() {
  const s = config.security ?? {};
  document.getElementById('security-dangerousPatterns').textContent =
    JSON.stringify(s.dangerousPatterns ?? [], null, 2);
  document.getElementById('security-protectedPaths').textContent =
    JSON.stringify(s.protectedPaths ?? [], null, 2);
  document.getElementById('security-allowedPaths').textContent =
    JSON.stringify(s.allowedPaths ?? [], null, 2);
  document.getElementById('security-deniedFilePatterns').textContent =
    JSON.stringify(s.deniedFilePatterns ?? [], null, 2);
}

// ── Helpers ───────────────────────────────────────────────────────────
function setChecked(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

function isChecked(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
}

function setSelectValue(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = val;
  if (el.selectedIndex === -1 && el.options.length) {
    el.selectedIndex = 0;
  }
}

function getValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

function setStatus(msg, className) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = `status ${className || ''}`;
}

// ── Panel 6: Activity Log ─────────────────────────────────────────────

const HOOK_TYPE_COLORS = {
  stop: '#2ecc71',
  subagentStop: '#3498db',
  notification: '#f39c12',
  sessionEnd: '#e74c3c',
  test: '#9b59b6',
};

const HOOK_TYPE_LABELS = {
  stop: 'Stop',
  subagentStop: 'Subagent',
  notification: 'Notify',
  sessionEnd: 'Session End',
  test: 'Test',
};

function initActivityLog() {
  fetchActivityLog();
  startActivityPoll();

  document.getElementById('activity-refresh-btn').addEventListener('click', fetchActivityLog);

  document.getElementById('activity-clear-btn').addEventListener('click', async () => {
    if (!confirm('Clear all activity log entries?')) return;
    await api.post('/api/activity-log/clear', {});
    fetchActivityLog();
    setStatus('Activity log cleared', 'ok');
  });

  document.getElementById('activity-filter-hook').addEventListener('change', fetchActivityLog);
  document.getElementById('activity-filter-session').addEventListener('change', fetchActivityLog);

  document.getElementById('activity-auto-refresh').addEventListener('change', (e) => {
    if (e.target.checked) {
      startActivityPoll();
    } else {
      stopActivityPoll();
    }
  });
}

function startActivityPoll() {
  stopActivityPoll();
  activityPollInterval = setInterval(fetchActivityLog, 5000);
}

function stopActivityPoll() {
  if (activityPollInterval) {
    clearInterval(activityPollInterval);
    activityPollInterval = null;
  }
}

async function fetchActivityLog() {
  try {
    const params = new URLSearchParams();
    const hookFilter = document.getElementById('activity-filter-hook').value;
    const sessionFilter = document.getElementById('activity-filter-session').value;
    if (hookFilter) params.set('hookType', hookFilter);
    if (sessionFilter) params.set('sessionId', sessionFilter);

    activityLogData = await api.get(`/api/activity-log?${params.toString()}`);
    updateActivitySessionFilter();
    renderActivityLog();
    updateActivityBadge();
  } catch (err) {
    console.error('Activity log fetch error:', err);
  }
}

function updateActivitySessionFilter() {
  const select = document.getElementById('activity-filter-session');
  const current = select.value;
  const sessions = activityLogData.sessions || {};

  // Keep first option
  while (select.options.length > 1) select.remove(1);

  for (const [sid, count] of Object.entries(sessions)) {
    const opt = document.createElement('option');
    opt.value = sid;
    const label = sid === 'test-harness' ? 'Test Harness' : sid.slice(0, 12) + '...';
    opt.textContent = `${label} (${count})`;
    select.appendChild(opt);
  }

  // Restore selection if still valid
  if (current && sessions[current]) {
    select.value = current;
  }
}

function updateActivityBadge() {
  const badge = document.getElementById('activity-badge');
  const total = activityLogData.total || 0;
  if (total > 0) {
    badge.textContent = total > 999 ? '999+' : total;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function renderActivityLog() {
  const container = document.getElementById('activity-log-container');
  const entries = activityLogData.entries || [];

  if (!entries.length) {
    container.innerHTML = '<p class="panel-desc" style="text-align:center; padding:2rem;">No activity log entries yet. Use the Test Harness or run Claude Code with hooks to generate entries.</p>';
    return;
  }

  // Group by session
  const sessionGroups = new Map();
  for (const entry of entries) {
    if (!sessionGroups.has(entry.sessionId)) {
      sessionGroups.set(entry.sessionId, []);
    }
    sessionGroups.get(entry.sessionId).push(entry);
  }

  let html = '';
  for (const [sessionId, sessionEntries] of sessionGroups) {
    const sessionLabel = sessionId === 'test-harness' ? 'Test Harness' : sessionId.slice(0, 16) + '...';
    const latestTime = sessionEntries[0]?.timestamp;
    const relTime = timeAgo(latestTime);

    // Sub-group by agent within session
    const agentGroups = new Map();
    for (const entry of sessionEntries) {
      const agentKey = entry.agentName || 'Main Agent';
      if (!agentGroups.has(agentKey)) {
        agentGroups.set(agentKey, []);
      }
      agentGroups.get(agentKey).push(entry);
    }

    html += `
      <div class="activity-session-group">
        <div class="activity-session-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="activity-chevron">${CHEVRON_SVG}</span>
          <span class="activity-session-id">${escapeHtml(sessionLabel)}</span>
          <span class="activity-session-count">${sessionEntries.length} ${sessionEntries.length === 1 ? 'entry' : 'entries'}</span>
          <span class="activity-session-time">${escapeHtml(relTime)}</span>
        </div>
        <div class="activity-session-body">
    `;

    for (const [agentKey, agentEntries] of agentGroups) {
      html += `
        <div class="activity-agent-group">
          <div class="activity-agent-header">${escapeHtml(agentKey)} <span class="activity-agent-count">(${agentEntries.length})</span></div>
      `;

      for (const entry of agentEntries) {
        const color = HOOK_TYPE_COLORS[entry.hookType] || '#888';
        const label = HOOK_TYPE_LABELS[entry.hookType] || entry.hookType;
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const duration = entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : '';
        const statusIcon = entry.success ? '' : ' <span style="color:var(--error);">[FAILED]</span>';

        html += `
          <div class="activity-entry ${entry.success ? '' : 'activity-entry-error'}">
            <div class="activity-entry-meta">
              <span class="activity-hook-badge" style="background:${color}">${escapeHtml(label)}</span>
              <span class="activity-time">${escapeHtml(time)}</span>
              <span class="activity-provider">${escapeHtml(entry.provider)}</span>
              ${duration ? `<span class="activity-duration">${escapeHtml(duration)}</span>` : ''}
              ${statusIcon}
            </div>
            <div class="activity-message">${escapeHtml(entry.message)}</div>
            ${entry.error ? `<div class="activity-error">${escapeHtml(entry.error)}</div>` : ''}
          </div>
        `;
      }

      html += '</div>'; // agent-group
    }

    html += '</div></div>'; // session-body, session-group
  }

  container.innerHTML = html;
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Boot ──────────────────────────────────────────────────────────────
init();
