const grid = document.querySelector('#device-grid');
const emptyState = document.querySelector('#empty-state');
const refreshButton = document.querySelector('#refresh');
const toast = document.querySelector('#toast');
let devices = [];
let activeFilter = 'all';

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Помилка ${response.status}`);
  }
  return response.json();
}

function iconMarkup(kind) {
  if (kind === 'camera') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3z"/><circle cx="9.5" cy="12" r="2.5"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V3h10v5M6 18h12M8 13h8v8H8z"/><rect x="3" y="8" width="18" height="9" rx="2"/><path d="M17 11h1"/></svg>';
}

function metric(label, value) {
  if (value === null || value === undefined || value === '') return null;
  const item = document.createElement('span');
  item.className = 'metric';
  const name = document.createElement('span');
  name.textContent = `${label} `;
  const strong = document.createElement('strong');
  strong.textContent = String(value);
  item.append(name, strong);
  return item;
}

function deviceCard(device) {
  const card = document.createElement(device.canOpen ? 'a' : 'article');
  card.className = 'device-card';
  card.dataset.kind = device.kind;
  if (device.canOpen) {
    card.classList.add('device-card-link');
    card.href = device.proxyUrl;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', `Відкрити ${device.name} у новій вкладці`);
  }

  const top = document.createElement('div');
  top.className = 'device-top';
  const icon = document.createElement('span');
  icon.className = 'device-icon';
  icon.innerHTML = iconMarkup(device.kind);
  const status = document.createElement('span');
  status.className = `status-pill ${device.status.online ? 'online' : 'offline'}`;
  status.textContent = device.status.online ? 'Онлайн' : 'Не в мережі';
  top.append(icon, status);

  const title = document.createElement('h2');
  title.className = 'device-title';
  title.textContent = device.name;
  const meta = document.createElement('p');
  meta.className = 'device-meta';
  meta.textContent = device.status.message || (device.kind === 'camera' ? 'Камера' : 'Принтер');

  const telemetry = document.createElement('div');
  telemetry.className = 'telemetry';
  const data = device.status.telemetry || {};
  const values = [
    metric('Прогрес', data.progress == null ? null : `${data.progress}%`),
    metric('Сопло', data.nozzle == null ? null : `${data.nozzle}°`),
    metric('Стіл', data.bed == null ? null : `${data.bed}°`),
    metric('Відгук', device.status.latencyMs == null ? null : `${device.status.latencyMs} мс`)
  ].filter(Boolean);
  if (values.length) telemetry.append(...values);
  else {
    const state = metric('Стан', device.status.state || '—');
    if (state) telemetry.append(state);
  }

  const bottom = document.createElement('div');
  bottom.className = 'device-bottom';
  const note = document.createElement('span');
  note.className = 'device-note';
  note.textContent = device.notes || (device.kind === 'camera' ? 'Відеоспостереження' : 'Керування друком');
  if (device.canOpen) {
    const open = document.createElement('span');
    open.className = 'open-device';
    open.textContent = 'Відкрити  →';
    bottom.append(note, open);
  } else {
    const locked = document.createElement('span');
    locked.className = 'open-device disabled';
    locked.textContent = 'Лише статус';
    bottom.append(note, locked);
  }

  card.append(top, title, meta, telemetry, bottom);
  return card;
}

function render() {
  const visible = devices.filter((device) => activeFilter === 'all' || device.kind === activeFilter);
  grid.replaceChildren(...visible.map(deviceCard));
  grid.classList.toggle('hidden', visible.length === 0);
  emptyState.classList.toggle('hidden', visible.length !== 0);
}

async function loadDevices(manual = false) {
  refreshButton.disabled = true;
  try {
    devices = await api('/api/devices');
    render();
    if (manual) showToast('Статуси оновлено');
  } catch (error) {
    grid.replaceChildren();
    showToast(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
    button.classList.add('active');
    activeFilter = button.dataset.filter;
    render();
  });
});

refreshButton.addEventListener('click', () => loadDevices(true));

async function start() {
  try {
    const me = await api('/api/me');
    document.querySelector('#identity-name').textContent = me.displayName || me.email;
    document.querySelector('#admin-link').classList.toggle('hidden', me.role !== 'admin');
    await loadDevices();
    setInterval(() => loadDevices(false), 30_000);
  } catch (error) {
    showToast(error.message, true);
  }
}

start();
