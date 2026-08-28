const state = { me: null, devices: [], users: [], audit: [] };
const toast = document.querySelector('#toast');

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json', 'X-Portal-Request': '1' } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Помилка ${response.status}`);
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function roleLabel(role) {
  return { admin: 'Адміністратор', operator: 'Оператор', viewer: 'Спостерігач' }[role] || role;
}

function driverLabel(driver) {
  return { moonraker: 'Moonraker', octoprint: 'OctoPrint', http: 'Web', rtsp: 'RTSP' }[driver] || driver;
}

function recordButton({ symbol, title, subtitle, enabled, selected, onClick }) {
  const button = el('button', `record${selected ? ' active' : ''}`);
  button.type = 'button';
  const icon = el('span', 'record-symbol', symbol);
  const main = el('span', 'record-main');
  main.append(el('strong', '', title), el('small', '', subtitle));
  const status = el('span', `record-state${enabled ? '' : ' off'}`, enabled ? 'УВІМК.' : 'ВИМК.');
  button.append(icon, main, status);
  button.addEventListener('click', onClick);
  return button;
}

function formValue(id, value) {
  const input = document.querySelector(`#${id}`);
  if (input.type === 'checkbox') input.checked = Boolean(value);
  else input.value = value ?? '';
}

function renderDevices(selectedId = Number(document.querySelector('#device-id').value || 0)) {
  const list = document.querySelector('#device-list');
  list.replaceChildren(...state.devices.map((device) => recordButton({
    symbol: device.kind === 'camera' ? 'CAM' : '3D',
    title: device.name,
    subtitle: `${device.host}:${device.uiPort} · ${driverLabel(device.driver)}`,
    enabled: device.enabled,
    selected: device.id === selectedId,
    onClick: () => editDevice(device)
  })));
  if (!state.devices.length) list.append(el('p', 'device-meta', 'Пристроїв поки немає.'));
}

function editDevice(device = null) {
  const form = document.querySelector('#device-form');
  form.classList.remove('hidden');
  document.querySelector('#device-form-title').textContent = device ? device.name : 'Новий пристрій';
  formValue('device-id', device?.id);
  formValue('device-name', device?.name);
  formValue('device-kind', device?.kind || 'printer');
  formValue('device-driver', device?.driver || 'moonraker');
  formValue('device-slug', device?.slug);
  formValue('device-host', device?.host || '192.168.0.');
  formValue('device-protocol', device?.protocol || 'http');
  formValue('device-ui-port', device?.uiPort || 80);
  formValue('device-api-port', device?.apiPort);
  formValue('device-sort', device?.sortOrder || 0);
  formValue('device-secret', '');
  formValue('device-notes', device?.notes);
  formValue('device-enabled', device ? device.enabled : true);
  document.querySelector('#test-device').classList.toggle('hidden', !device);
  toggleRtspHint();
  renderDevices(device?.id || 0);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function devicePayload() {
  const apiPort = document.querySelector('#device-api-port').value;
  return {
    name: document.querySelector('#device-name').value,
    kind: document.querySelector('#device-kind').value,
    driver: document.querySelector('#device-driver').value,
    slug: document.querySelector('#device-slug').value,
    host: document.querySelector('#device-host').value,
    protocol: document.querySelector('#device-protocol').value,
    uiPort: Number(document.querySelector('#device-ui-port').value),
    apiPort: apiPort ? Number(apiPort) : null,
    sortOrder: Number(document.querySelector('#device-sort').value || 0),
    secret: document.querySelector('#device-secret').value,
    keepSecret: true,
    notes: document.querySelector('#device-notes').value,
    enabled: document.querySelector('#device-enabled').checked
  };
}

async function saveDevice(event) {
  event.preventDefault();
  const id = Number(document.querySelector('#device-id').value || 0);
  try {
    await api(id ? `/api/admin/devices/${id}` : '/api/admin/devices', {
      method: id ? 'PATCH' : 'POST', body: JSON.stringify(devicePayload())
    });
    await loadDevices();
    const current = id ? state.devices.find((item) => item.id === id) : state.devices.at(-1);
    if (current) editDevice(current);
    showToast('Пристрій збережено');
  } catch (error) { showToast(error.message, true); }
}

async function testDevice() {
  const id = Number(document.querySelector('#device-id').value || 0);
  if (!id) return;
  const button = document.querySelector('#test-device');
  button.disabled = true;
  try {
    const status = await api(`/api/admin/devices/${id}/test`, { method: 'POST', body: '{}' });
    showToast(status.online ? `Зв’язок є: ${status.message}` : `Немає зв’язку: ${status.message}`, !status.online);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

function toggleRtspHint() {
  document.querySelector('#rtsp-hint').classList.toggle('hidden', document.querySelector('#device-driver').value !== 'rtsp');
}

async function loadDevices() {
  state.devices = await api('/api/admin/devices');
  renderDevices();
}

function renderUsers(selectedId = Number(document.querySelector('#user-id').value || 0)) {
  const list = document.querySelector('#user-list');
  list.replaceChildren(...state.users.map((user) => recordButton({
    symbol: (user.displayName || user.email).slice(0, 2),
    title: user.displayName || user.email,
    subtitle: `${user.email} · ${roleLabel(user.role)}`,
    enabled: user.enabled,
    selected: user.id === selectedId,
    onClick: () => editUser(user)
  })));
}

function renderAccess(user = null) {
  const grants = new Map((user?.access || []).map((grant) => [grant.deviceId, grant.level]));
  const container = document.querySelector('#user-access');
  const rows = state.devices.map((device) => {
    const row = el('label', 'access-item');
    const description = el('span');
    description.append(el('strong', '', device.name), el('small', '', `${device.kind === 'camera' ? 'Камера' : 'Принтер'} · ${device.slug}`));
    const select = el('select');
    select.dataset.deviceId = String(device.id);
    [
      ['none', 'Немає доступу'],
      ['viewer', 'Перегляд'],
      ['operator', 'Керування']
    ].forEach(([value, label]) => {
      const option = el('option', '', label);
      option.value = value;
      select.append(option);
    });
    select.value = grants.get(device.id) || 'none';
    row.append(description, select);
    return row;
  });
  container.replaceChildren(...rows);
  if (!rows.length) container.append(el('p', 'device-meta', 'Спочатку додайте пристрій.'));
  toggleAdminAccess();
}

function toggleAdminAccess() {
  const isAdmin = document.querySelector('#user-role').value === 'admin';
  document.querySelectorAll('#user-access select').forEach((select) => { select.disabled = isAdmin; });
}

function editUser(user = null) {
  const form = document.querySelector('#user-form');
  form.classList.remove('hidden');
  document.querySelector('#user-form-title').textContent = user ? (user.displayName || user.email) : 'Новий користувач';
  formValue('user-id', user?.id);
  formValue('user-email', user?.email);
  formValue('user-name', user?.displayName);
  formValue('user-role', user?.role || 'viewer');
  formValue('user-enabled', user ? user.enabled : true);
  renderAccess(user);
  renderUsers(user?.id || 0);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function userPayload() {
  const access = [...document.querySelectorAll('#user-access select')]
    .filter((select) => select.value !== 'none')
    .map((select) => ({ deviceId: Number(select.dataset.deviceId), level: select.value }));
  return {
    email: document.querySelector('#user-email').value,
    displayName: document.querySelector('#user-name').value,
    role: document.querySelector('#user-role').value,
    enabled: document.querySelector('#user-enabled').checked,
    access
  };
}

async function saveUser(event) {
  event.preventDefault();
  const id = Number(document.querySelector('#user-id').value || 0);
  try {
    await api(id ? `/api/admin/users/${id}` : '/api/admin/users', {
      method: id ? 'PATCH' : 'POST', body: JSON.stringify(userPayload())
    });
    await loadUsers();
    const current = id ? state.users.find((item) => item.id === id) : state.users.at(-1);
    if (current) editUser(current);
    showToast('Користувача збережено');
  } catch (error) { showToast(error.message, true); }
}

async function loadUsers() {
  state.users = await api('/api/admin/users');
  renderUsers();
}

function formatDate(value) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date(`${value.replace(' ', 'T')}Z`));
}

function actionLabel(action) {
  return {
    'device.create': 'Пристрій додано', 'device.update': 'Пристрій змінено',
    'device.test': 'Перевірка зв’язку', 'user.create': 'Користувача додано',
    'user.update': 'Користувача змінено'
  }[action] || action;
}

async function loadAudit() {
  state.audit = await api('/api/admin/audit?limit=150');
  const body = document.querySelector('#audit-body');
  const rows = state.audit.map((entry) => {
    const row = document.createElement('tr');
    [formatDate(entry.created_at), entry.actor_email, actionLabel(entry.action), `${entry.entity_type} #${entry.entity_id || '—'}`, JSON.stringify(entry.details)]
      .forEach((value) => row.append(el('td', '', value)));
    return row;
  });
  body.replaceChildren(...rows);
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = el('td', '', 'Журнал поки порожній.');
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
}

document.querySelectorAll('.admin-tab').forEach((button) => {
  button.addEventListener('click', async () => {
    document.querySelectorAll('.admin-tab').forEach((tab) => tab.classList.remove('active'));
    document.querySelectorAll('.admin-panel').forEach((panel) => panel.classList.remove('active'));
    button.classList.add('active');
    document.querySelector(`#panel-${button.dataset.panel}`).classList.add('active');
    if (button.dataset.panel === 'audit') await loadAudit().catch((error) => showToast(error.message, true));
  });
});

document.querySelector('#new-device').addEventListener('click', () => editDevice());
document.querySelector('#new-user').addEventListener('click', () => editUser());
document.querySelector('#device-form').addEventListener('submit', saveDevice);
document.querySelector('#user-form').addEventListener('submit', saveUser);
document.querySelector('#test-device').addEventListener('click', testDevice);
document.querySelector('#device-driver').addEventListener('change', toggleRtspHint);
document.querySelector('#user-role').addEventListener('change', toggleAdminAccess);
document.querySelector('#refresh-audit').addEventListener('click', () => loadAudit().then(() => showToast('Журнал оновлено')).catch((error) => showToast(error.message, true)));
document.querySelectorAll('[data-close-editor]').forEach((button) => button.addEventListener('click', () => button.closest('form').classList.add('hidden')));

async function start() {
  try {
    state.me = await api('/api/me');
    if (state.me.role !== 'admin') throw new Error('Потрібні права адміністратора');
    document.querySelector('#identity-name').textContent = state.me.displayName || state.me.email;
    await Promise.all([loadDevices(), loadUsers()]);
  } catch (error) { showToast(error.message, true); }
}

start();
