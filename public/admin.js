import { initDesktop } from './desktop.js?v=0.13.0';

const state = { me: null, devices: [], users: [], audit: [], audio: null, starlink: null, starlinkMap: null };
const toast = document.querySelector('#toast');
let audioPollTimer = null;
let starlinkPollTimer = null;
let starlinkLoading = false;
let starlinkDeviceView = 'dish';

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
  return { moonraker: 'Moonraker', octoprint: 'OctoPrint', http: 'Web', rtsp: 'RTSP', go2rtc: 'go2rtc' }[driver] || driver;
}

function deviceIntegration(device) {
  return device.streamName ? 'go2rtc' : device.driver;
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

function renderParentDevices(selectedId = null) {
  const select = document.querySelector('#device-parent');
  const standalone = el('option', '', 'Окрема камера');
  standalone.value = '';
  const printers = state.devices
    .filter((device) => device.kind === 'printer')
    .map((device) => {
      const option = el('option', '', device.name);
      option.value = String(device.id);
      return option;
    });
  select.replaceChildren(standalone, ...printers);
  select.value = selectedId == null ? '' : String(selectedId);
}

function renderDevices(selectedId = Number(document.querySelector('#device-id').value || 0)) {
  const list = document.querySelector('#device-list');
  list.replaceChildren(...state.devices.map((device) => recordButton({
    symbol: device.kind === 'camera' ? 'CAM' : '3D',
    title: device.name,
    subtitle: `${device.host}:${device.uiPort} · ${driverLabel(deviceIntegration(device))}`,
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
  formValue('device-driver', device ? deviceIntegration(device) : 'moonraker');
  renderParentDevices(device?.parentDeviceId);
  formValue('device-slug', device?.slug);
  formValue('device-host', device?.host || '192.168.0.');
  formValue('device-protocol', device?.protocol || 'http');
  formValue('device-ui-port', device?.uiPort || 80);
  formValue('device-api-port', device?.apiPort);
  formValue('device-stream-name', device?.streamName);
  formValue('device-stream-mode', device?.streamMode || 'auto');
  formValue('device-sort', device?.sortOrder || 0);
  formValue('device-secret', '');
  formValue('device-notes', device?.notes);
  formValue('device-enabled', device ? device.enabled : true);
  document.querySelector('#test-device').classList.toggle('hidden', !device);
  toggleDeviceIntegration();
  renderDevices(device?.id || 0);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function devicePayload() {
  const apiPort = document.querySelector('#device-api-port').value;
  const integration = document.querySelector('#device-driver').value;
  const parentDeviceId = document.querySelector('#device-parent').value;
  return {
    name: document.querySelector('#device-name').value,
    kind: document.querySelector('#device-kind').value,
    driver: integration === 'go2rtc' ? 'http' : integration,
    slug: document.querySelector('#device-slug').value,
    host: document.querySelector('#device-host').value,
    protocol: document.querySelector('#device-protocol').value,
    uiPort: Number(document.querySelector('#device-ui-port').value),
    apiPort: apiPort ? Number(apiPort) : null,
    streamName: integration === 'go2rtc' ? document.querySelector('#device-stream-name').value : '',
    streamMode: integration === 'go2rtc' ? document.querySelector('#device-stream-mode').value : 'auto',
    parentDeviceId: document.querySelector('#device-kind').value === 'camera' && parentDeviceId
      ? Number(parentDeviceId)
      : null,
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

function toggleDeviceIntegration(applyDefaults = false) {
  const integration = document.querySelector('#device-driver').value;
  const isRtsp = integration === 'rtsp';
  const isGo2rtc = integration === 'go2rtc';
  const isCamera = document.querySelector('#device-kind').value === 'camera' || (isGo2rtc && applyDefaults);
  document.querySelector('#rtsp-hint').classList.toggle('hidden', !isRtsp);
  document.querySelector('#go2rtc-hint').classList.toggle('hidden', !isGo2rtc);
  document.querySelector('#stream-name-field').classList.toggle('hidden', !isGo2rtc);
  document.querySelector('#stream-mode-field').classList.toggle('hidden', !isGo2rtc);
  document.querySelector('#parent-device-field').classList.toggle('hidden', !isCamera);
  document.querySelector('#device-stream-name').required = isGo2rtc;
  if (isGo2rtc && applyDefaults) {
    formValue('device-kind', 'camera');
    formValue('device-host', '100.69.168.10');
    formValue('device-protocol', 'http');
    formValue('device-ui-port', 1984);
    formValue('device-stream-name', 'printer-usb-camera');
    formValue('device-stream-mode', 'auto');
  }
}

async function loadDevices() {
  state.devices = await api('/api/admin/devices');
  renderDevices();
}

function audioButton(label, className, action, device) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      state.audio = await api(
        `/api/admin/audio/bluetooth/devices/${encodeURIComponent(device.address)}/${action}`,
        { method: 'POST', body: '{}' }
      );
      renderAudio();
      showToast(action === 'remove' ? 'Пристрій видалено' : 'Bluetooth-пристрій оновлено');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
  });
  return button;
}

function renderBluetoothDevices() {
  const list = document.querySelector('#bluetooth-device-list');
  const devices = state.audio?.devices || [];
  const rows = devices.map((device) => {
    const row = el('div', `bluetooth-device${device.connected ? ' connected' : ''}`);
    const description = el('div', 'bluetooth-device-main');
    const flags = [
      device.connected ? 'під’єднано' : null,
      device.paired ? 'paired' : 'новий',
      device.audio ? 'аудіо' : null
    ].filter(Boolean).join(' · ');
    description.append(el('strong', '', device.name), el('small', '', `${device.address} · ${flags}`));
    const actions = el('div', 'bluetooth-device-actions');
    if (!device.paired) {
      actions.append(audioButton('Під’єднати', 'button button-primary', 'pair', device));
    } else if (device.connected) {
      actions.append(audioButton('Від’єднати', 'button button-ghost', 'disconnect', device));
    } else {
      actions.append(audioButton('З’єднати', 'button button-primary', 'connect', device));
    }
    if (device.paired) actions.append(audioButton('Забути', 'button button-danger', 'remove', device));
    row.append(description, actions);
    return row;
  });
  list.replaceChildren(...rows);
  if (!rows.length) list.append(el('p', 'audio-empty', 'Bluetooth-пристроїв поки не знайдено.'));
}

function renderAudio() {
  const adapter = state.audio?.adapter || {};
  const audio = state.audio?.audio || {};
  const player = state.audio?.player || {};
  const power = document.querySelector('#bluetooth-power');
  power.checked = Boolean(adapter.powered);
  power.disabled = !adapter.available;
  document.querySelector('#bluetooth-power-label').textContent = adapter.powered ? 'Увімкнено' : 'Вимкнено';
  const dot = document.querySelector('#bluetooth-status-dot');
  dot.classList.toggle('online', Boolean(adapter.powered));
  dot.classList.toggle('searching', Boolean(adapter.discovering));
  document.querySelector('#bluetooth-status').textContent = !adapter.available
    ? 'Bluetooth-адаптер недоступний'
    : adapter.discovering
      ? 'Пошук пристроїв…'
      : adapter.powered
        ? `${adapter.name || 'Raspberry Pi'} · готовий`
        : 'Адаптер вимкнено';
  document.querySelector('#scan-bluetooth').disabled = !adapter.powered || adapter.discovering;
  document.querySelector('#stop-bluetooth-scan').classList.toggle('hidden', !adapter.discovering);
  renderBluetoothDevices();

  const audioState = document.querySelector('#audio-stack-state');
  audioState.textContent = audio.available ? 'АКТИВНО' : 'НЕМАЄ';
  audioState.classList.toggle('off', !audio.available);
  const sink = document.querySelector('#audio-sink');
  const sinkOptions = (audio.sinks || []).map((item) => {
    const option = el('option', '', item.name);
    option.value = String(item.id);
    option.selected = item.id === audio.defaultSinkId;
    return option;
  });
  sink.replaceChildren(...sinkOptions);
  if (!sinkOptions.length) {
    const option = el('option', '', 'Аудіовиходи не знайдено');
    option.value = '';
    sink.append(option);
  }
  sink.disabled = !audio.available || !sinkOptions.length;
  const volume = document.querySelector('#audio-volume');
  volume.value = String(audio.volume ?? 0);
  volume.disabled = !audio.available || audio.volume == null;
  document.querySelector('#audio-volume-value').textContent = audio.volume == null ? '—' : `${audio.volume}%`;
  const mute = document.querySelector('#audio-mute');
  mute.disabled = !audio.available;
  mute.textContent = audio.muted ? 'Увімкнути звук' : 'Вимкнути звук';
  mute.dataset.muted = audio.muted ? '1' : '0';

  document.querySelector('#player-title').textContent = player.title || 'Нічого не відтворюється';
  document.querySelector('#player-meta').textContent = player.available
    ? [player.artist, player.player, player.status].filter(Boolean).join(' · ')
    : 'Сумісний MPRIS-програвач не знайдено.';
  document.querySelectorAll('[data-player-action]').forEach((button) => { button.disabled = !player.available; });

  const clap = state.audio?.clap || {};
  const clapOnline = Boolean(clap.enabled && clap.listening);
  const clapState = document.querySelector('#clap-state');
  clapState.textContent = clapOnline ? 'СЛУХАЄ' : clap.enabled ? (clap.error ? 'ПОМИЛКА' : 'ЗАПУСК') : 'ВИМК.';
  clapState.classList.toggle('off', !clapOnline);
  document.querySelector('#clap-status-dot').classList.toggle('online', clapOnline);
  document.querySelector('#clap-status').textContent = clapOnline
    ? `${clap.source || 'Webcam C270 Mono'} · 2 хлопки → Play / Pause · 3 → привітання`
    : clap.enabled ? (clap.error || 'Запуск прослуховування…') : 'Розпізнавання хлопків вимкнено';
  const clapConfig = clap.config || {};
  const sensitivity = document.querySelector('#clap-sensitivity');
  const maxInterval = document.querySelector('#clap-max-interval');
  const enabled = document.querySelector('#clap-enabled');
  if (document.activeElement !== enabled) enabled.checked = Boolean(clap.enabled);
  document.querySelector('#clap-enabled-label').textContent = clap.enabled ? 'Увімкнено' : 'Вимкнено';
  if (document.activeElement !== sensitivity) sensitivity.value = String(clapConfig.sensitivity ?? 70);
  if (document.activeElement !== maxInterval) maxInterval.value = String(clapConfig.maxIntervalMs ?? 1100);
  sensitivity.disabled = !clap.config;
  maxInterval.disabled = !clap.config;
  enabled.disabled = !clap.config;
  document.querySelector('#clap-sensitivity-value').textContent = `${sensitivity.value}%`;
  document.querySelector('#clap-max-interval-value').textContent = `${new Intl.NumberFormat('uk-UA', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(Number(maxInterval.value) / 1000)} с`;
  const lastGesture = clap.lastGestureAt ? new Date(clap.lastGestureAt).toLocaleString('uk-UA') : null;
  const lastGestureName = clap.lastGesture === 'greeting' ? 'привітання' : 'Play / Pause';
  document.querySelector('#clap-details').textContent = lastGesture
    ? `Остання команда: ${lastGestureName}, ${lastGesture}. Подвійних: ${clap.doubleClapCount || 0}, потрійних: ${clap.tripleClapCount || 0}.`
    : 'Два чіткі хлопки перемикають Play / Pause. Три — приглушують музику, відтворюють «Бажаю здоров’я!» та повертають попередню гучність. Електричні розряди відсіюються окремим акустичним фільтром.';
}

async function loadAudio({ quiet = false } = {}) {
  try {
    state.audio = await api('/api/admin/audio');
    renderAudio();
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  }
}

function startAudioPolling() {
  clearInterval(audioPollTimer);
  audioPollTimer = setInterval(() => {
    if (document.querySelector('#panel-audio').classList.contains('active')) loadAudio({ quiet: true });
  }, 4_000);
}

async function audioMutation(path, body, successMessage) {
  state.audio = await api(path, { method: 'POST', body: JSON.stringify(body) });
  renderAudio();
  if (successMessage) showToast(successMessage);
}

async function saveClapConfig(successMessage = 'Налаштування хлопків збережено') {
  await audioMutation('/api/admin/audio/clap/config', {
    enabled: document.querySelector('#clap-enabled').checked,
    sensitivity: Number(document.querySelector('#clap-sensitivity').value),
    maxIntervalMs: Number(document.querySelector('#clap-max-interval').value)
  }, successMessage);
}

function metric(value, unit, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: digits }).format(number)} ${unit}`;
}

function formatUptime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  return [days ? `${days} дн` : null, `${hours} год`, `${minutes} хв`].filter(Boolean).join(' ');
}

function kyivUtcOffsetMinutes() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((representedUtc - now.getTime()) / 60_000);
}

function minutesToTime(minutes) {
  const normalized = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function seriesPath(values, sharedMaximum = null) {
  const series = Array.isArray(values) ? values.map((value) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null) : [];
  const valid = series.filter((value) => value !== null);
  if (valid.length < 2) return '';
  const maximum = Math.max(1, sharedMaximum ?? Math.max(...valid) * 1.08);
  let drawing = false;
  return series.map((value, index) => {
    if (value === null) {
      drawing = false;
      return '';
    }
    const x = series.length === 1 ? 0 : index * 600 / (series.length - 1);
    const y = 142 - Math.min(1, Math.max(0, value / maximum)) * 134;
    const command = drawing ? 'L' : 'M';
    drawing = true;
    return `${command}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).filter(Boolean).join(' ');
}

function renderStarlinkCharts(history) {
  const series = history?.series || {};
  const ping = series.pingMs || [];
  const loss = series.lossPercent || [];
  document.querySelector('[data-series="ping"]').setAttribute('d', seriesPath(ping));
  document.querySelector('[data-series="loss"]').setAttribute('d', seriesPath(loss, Math.max(1, ...loss.filter(Number.isFinite))));
  const download = series.downloadMbps || [];
  const upload = series.uploadMbps || [];
  const trafficMaximum = Math.max(1, ...download.filter(Number.isFinite), ...upload.filter(Number.isFinite)) * 1.08;
  document.querySelector('[data-series="download"]').setAttribute('d', seriesPath(download, trafficMaximum));
  document.querySelector('[data-series="upload"]').setAttribute('d', seriesPath(upload, trafficMaximum));
}

function renderStarlinkMap() {
  const canvas = document.querySelector('#starlink-map');
  const empty = document.querySelector('#starlink-map-empty');
  const map = state.starlinkMap;
  if (!map?.rows || !map?.columns || !Array.isArray(map.snr)) {
    empty.classList.remove('hidden');
    return;
  }
  const source = document.createElement('canvas');
  source.width = map.columns;
  source.height = map.rows;
  const sourceContext = source.getContext('2d');
  const image = sourceContext.createImageData(map.columns, map.rows);
  map.snr.forEach((raw, index) => {
    const value = Number(raw);
    const pixel = index * 4;
    let color;
    if (!Number.isFinite(value) || value <= -0.75) color = [5, 6, 5, 255];
    else if (value < 0) color = [19, 23, 19, 255];
    else if (value < 0.42) color = [242, Math.round(85 + value * 100), 48, 255];
    else color = [Math.round(50 + value * 30), Math.round(90 + value * 75), Math.round(80 + value * 45), 255];
    image.data.set(color, pixel);
  });
  sourceContext.putImageData(image, 0, 0);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.beginPath();
  context.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2, 0, Math.PI * 2);
  context.clip();
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  context.restore();
  empty.classList.add('hidden');
}

function renderStarlinkEvents(events) {
  const list = document.querySelector('#starlink-event-list');
  const eventLabels = {
    EVENT_REASON_NO_SCHEDULE: 'Зміна стану каналу',
    EVENT_REASON_OBSTRUCTED: 'Перешкода сигналу',
    EVENT_REASON_NO_DOWNLINK: 'Втрачено downlink',
    EVENT_REASON_NO_PINGS: 'Немає відповіді на ping',
    EVENT_REASON_THERMAL_SHUTDOWN: 'Температурне вимкнення',
    EVENT_REASON_OUTAGE_UNKNOWN: 'Коротка втрата зв’язку',
    EVENT_REASON_OUTAGE_NO_PINGS: 'Немає відповіді від Starlink PoP',
    EVENT_REASON_OUTAGE_NO_DOWNLINK: 'Втрачено супутниковий downlink',
    EVENT_REASON_OUTAGE_OBSTRUCTED: 'Сигнал перекрито перешкодою',
    EVENT_REASON_HIGH_DOWNLINK_PACKET_LOSS: 'Високі втрати пакетів downlink'
  };
  const rows = [...(events || [])].reverse().map((event) => {
    const row = el('div', 'starlink-event');
    const dot = el('span', 'starlink-event-dot');
    const description = el('div');
    const reason = eventLabels[event.reason] || String(event.reason || 'Подія Starlink').replace(/^EVENT_REASON_/, '').replaceAll('_', ' ');
    description.append(el('strong', '', reason), el('small', '', `Тривалість: ${metric(event.durationSeconds, 'с', 1)}`));
    const time = el('time', '', event.startedAt ? new Date(event.startedAt).toLocaleString('uk-UA', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }) : '—');
    if (event.startedAt) time.dateTime = event.startedAt;
    row.append(dot, description, time);
    return row;
  });
  list.replaceChildren(...rows);
  if (!rows.length) list.append(el('p', 'audio-empty', 'Останніх мережевих подій немає.'));
}

function showStarlinkDevice(view) {
  const routerAvailable = Boolean(state.starlink?.router?.available);
  starlinkDeviceView = view === 'router' && routerAvailable ? 'router' : 'dish';
  const dishActive = starlinkDeviceView === 'dish';
  const dishTab = document.querySelector('#starlink-dish-tab');
  const routerTab = document.querySelector('#starlink-router-tab');
  dishTab.classList.toggle('active', dishActive);
  dishTab.setAttribute('aria-selected', String(dishActive));
  routerTab.classList.toggle('active', !dishActive);
  routerTab.setAttribute('aria-selected', String(!dishActive));
  document.querySelector('#starlink-dish-view').classList.toggle('hidden', !dishActive);
  document.querySelector('#starlink-router-view').classList.toggle('hidden', dishActive);
}

function renderStarlink() {
  const data = state.starlink;
  if (!data) return;
  const history = data.history || {};
  const network = data.network || {};
  const health = data.health || {};
  const gps = data.gps || {};
  const config = data.config || {};
  const capabilities = data.capabilities || {};
  const live = document.querySelector('#starlink-live');
  live.textContent = data.connected ? 'ОНЛАЙН' : String(data.state || 'ОФЛАЙН');
  live.classList.toggle('online', Boolean(data.connected));
  live.classList.toggle('offline', !data.connected);
  document.querySelector('#starlink-dish-tab-state').textContent = data.connected ? 'ОНЛАЙН' : 'ОФЛАЙН';
  document.querySelector('#starlink-ping').textContent = metric(network.pingMs ?? history.ping?.currentMs, 'мс');
  document.querySelector('#starlink-ping-average').textContent = metric(history.ping?.averageMs, 'мс');
  document.querySelector('#starlink-p95').textContent = `p95 ${metric(history.ping?.p95Ms, 'мс')}`;
  document.querySelector('#starlink-loss').textContent = metric(history.loss?.averagePercent, '%', 2);
  document.querySelector('#starlink-loss-detail').textContent = `${metric(history.loss?.affectedSeconds, 'с', 1)} із втратами`;
  document.querySelector('#starlink-download').textContent = metric(network.downloadMbps, 'Мбіт/с');
  document.querySelector('#starlink-download-average').textContent = `середнє ${metric(history.download?.averageMbps, 'Мбіт/с')}`;
  document.querySelector('#starlink-upload').textContent = metric(network.uploadMbps, 'Мбіт/с');
  document.querySelector('#starlink-upload-average').textContent = `середнє ${metric(history.upload?.averageMbps, 'Мбіт/с')}`;
  document.querySelector('#starlink-power').textContent = metric(history.power?.currentWatts, 'Вт');
  document.querySelector('#starlink-power-average').textContent = `середнє ${metric(history.power?.averageWatts, 'Вт')}`;
  const usage = (Number(history.download?.usageMegabytes) || 0) + (Number(history.upload?.usageMegabytes) || 0);
  document.querySelector('#starlink-usage').textContent = `${metric(usage, 'МБ')} за 15 хв`;
  renderStarlinkCharts(history);

  const device = data.device || {};
  const router = data.router || {
    available: false,
    state: device.bypassMode ? 'BYPASSED' : 'NOT_DETECTED'
  };
  const routerAvailable = Boolean(router.available);
  const routerStateLabels = { ONLINE: 'ДОСТУПНИЙ', BYPASSED: 'BYPASS', NOT_DETECTED: 'НЕ ВИЯВЛЕНО' };
  const routerState = routerStateLabels[router.state] || 'НЕ ВИЯВЛЕНО';
  const routerTab = document.querySelector('#starlink-router-tab');
  routerTab.disabled = !routerAvailable;
  routerTab.classList.toggle('unavailable', !routerAvailable);
  routerTab.setAttribute('aria-disabled', String(!routerAvailable));
  document.querySelector('#starlink-router-tab-state').textContent = routerState;
  const routerHealth = document.querySelector('#starlink-router-health');
  routerHealth.textContent = routerState;
  routerHealth.classList.toggle('off', !routerAvailable);
  document.querySelector('#starlink-router-state').textContent = routerAvailable
    ? 'Фірмовий роутер виявлено'
    : router.state === 'BYPASSED' ? 'Фірмовий роутер вимкнено' : 'Фірмовий роутер не виявлено';
  document.querySelector('#starlink-router-description').textContent = routerAvailable
    ? 'Роутер виявлено у телеметрії тарілки. Розділ підготовлено для майбутнього безпечного керування Wi-Fi та клієнтами.'
    : router.state === 'BYPASSED'
      ? 'Starlink працює у bypass-режимі, тому фірмовий роутер не бере участі в мережі. Окремий ping не виконується: стан уже надходить у звичайній телеметрії тарілки.'
      : 'Фірмовий роутер не знайдено у телеметрії тарілки. Додатковий мережевий ping не виконується.';
  if (!routerAvailable && starlinkDeviceView === 'router') starlinkDeviceView = 'dish';
  showStarlinkDevice(starlinkDeviceView);
  const orientation = data.orientation || {};
  document.querySelector('#starlink-model').textContent = device.hardwareVersion || 'Starlink';
  document.querySelector('#starlink-firmware').textContent = device.softwareVersion || '—';
  document.querySelector('#starlink-uptime').textContent = formatUptime(device.uptimeSeconds);
  document.querySelector('#starlink-ethernet').textContent = metric(network.ethernetMbps, 'Мбіт/с', 0);
  document.querySelector('#starlink-gps-state').textContent = gps.inhibited
    ? 'Ignore GPS увімкнено'
    : gps.valid ? `${gps.satellites || 0} супутників` : 'Сигнал GPS невалідний';
  document.querySelector('#starlink-orientation').textContent = orientation.azimuthDegrees == null
    ? 'Фіксована Starlink Mini'
    : `${metric(orientation.azimuthDegrees, '°')} / ${metric(orientation.elevationDegrees, '°')}`;
  const healthOk = data.connected && !(health.alerts || []).length && health.hardwareSelfTest !== 'FAILED';
  const healthNode = document.querySelector('#starlink-health');
  healthNode.textContent = healthOk ? 'НОРМА' : data.connected ? 'УВАГА' : 'НЕМАЄ ЗВ’ЯЗКУ';
  healthNode.classList.toggle('off', !healthOk);
  const alerts = [
    ...(health.alerts || []).map((item) => String(item).replaceAll('_', ' ')),
    ...(health.hardwareSelfTest === 'FAILED' ? (health.hardwareSelfTestCodes || ['SELF TEST FAILED']) : [])
  ];
  const alertNodes = alerts.map((message) => el('span', 'starlink-alert', message));
  if (!alertNodes.length) alertNodes.push(el('span', 'starlink-alert ok', 'Активних попереджень немає'));
  document.querySelector('#starlink-alerts').replaceChildren(...alertNodes);

  const obstruction = data.obstruction || {};
  document.querySelector('#starlink-obstruction').textContent = metric(obstruction.fractionPercent, '%', 2);
  document.querySelector('#starlink-obstruction-detail').textContent = obstruction.currentlyObstructed
    ? 'Зараз сигнал перекриває перешкода. Помаранчеві ділянки потребують уваги.'
    : `Частка перекритого неба: ${metric(obstruction.fractionPercent, '%', 2)}. Помаранчеві ділянки — потенційні перешкоди.`;

  const gpsInput = document.querySelector('#starlink-gps-inhibit');
  gpsInput.disabled = !capabilities.gpsInhibit;
  gpsInput.checked = Boolean(gps.inhibited);
  document.querySelector('#starlink-gps-label').textContent = gps.inhibited ? 'Увімкнено' : 'Вимкнено';
  const snow = document.querySelector('#starlink-snow-mode');
  if (document.activeElement !== snow) snow.value = config.snowMeltMode || 'AUTO';
  snow.disabled = true;
  document.querySelector('#starlink-apply-snow').disabled = true;
  const sleepEnabled = document.querySelector('#starlink-sleep-enabled');
  sleepEnabled.checked = Boolean(config.powerSaveEnabled);
  sleepEnabled.disabled = !capabilities.powerSave;
  const start = document.querySelector('#starlink-sleep-start');
  if (document.activeElement !== start) start.value = minutesToTime((config.powerSaveStartMinutesUtc || 0) + kyivUtcOffsetMinutes());
  const duration = document.querySelector('#starlink-sleep-duration');
  if (document.activeElement !== duration) duration.value = String(config.powerSaveDurationMinutes || 60);
  start.disabled = duration.disabled = !capabilities.powerSave;
  document.querySelector('#starlink-apply-sleep').disabled = !capabilities.powerSave;
  document.querySelector('#starlink-stow-controls').classList.toggle('hidden', !capabilities.stow);
  renderStarlinkEvents(history.events);
}

async function loadStarlink({ quiet = false, includeMap = false } = {}) {
  if (starlinkLoading) return;
  starlinkLoading = true;
  try {
    const [status, map] = await Promise.all([
      api('/api/admin/starlink'),
      includeMap && !state.starlinkMap ? api('/api/admin/starlink/obstruction-map') : Promise.resolve(null)
    ]);
    state.starlink = status;
    if (map) state.starlinkMap = map;
    renderStarlink();
    renderStarlinkMap();
  } catch (error) {
    const live = document.querySelector('#starlink-live');
    live.textContent = 'НЕМАЄ ЗВ’ЯЗКУ';
    live.classList.remove('online');
    live.classList.add('offline');
    if (!quiet) showToast(error.message, true);
  } finally {
    starlinkLoading = false;
  }
}

function startStarlinkPolling() {
  clearInterval(starlinkPollTimer);
  starlinkPollTimer = setInterval(() => {
    if (document.querySelector('#panel-starlink').classList.contains('active')) loadStarlink({ quiet: true });
  }, 5_000);
}

async function starlinkMutation(path, body, successMessage) {
  const result = await api(path, { method: 'POST', body: JSON.stringify(body) });
  if (result?.version === 1) {
    state.starlink = result;
    renderStarlink();
  }
  if (successMessage) showToast(successMessage);
  return result;
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
    'user.update': 'Користувача змінено', 'audio.bluetooth.power': 'Живлення Bluetooth',
    'audio.bluetooth.scan': 'Пошук Bluetooth', 'audio.bluetooth.pair': 'Bluetooth pairing',
    'audio.bluetooth.connect': 'Bluetooth під’єднано', 'audio.bluetooth.disconnect': 'Bluetooth від’єднано',
    'audio.bluetooth.remove': 'Bluetooth-пристрій видалено', 'audio.volume': 'Гучність змінено',
    'audio.mute': 'Mute змінено', 'audio.default-sink': 'Аудіовихід змінено',
    'starlink.reboot': 'Starlink перезавантажено', 'starlink.gps': 'Starlink Ignore GPS змінено',
    'starlink.power-save': 'Розклад сну Starlink змінено', 'starlink.snow-melt': 'Підігрів Starlink змінено',
    'starlink.clear-obstruction-map': 'Карту перешкод очищено', 'starlink.stow': 'Starlink складено',
    'starlink.unstow': 'Starlink розкладено',
    'desktop.connect': 'Віддалений робочий стіл відкрито'
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
    if (button.dataset.panel === 'audio') await loadAudio();
    if (button.dataset.panel === 'starlink') await loadStarlink({ includeMap: true });
    if (button.dataset.panel === 'audit') await loadAudit().catch((error) => showToast(error.message, true));
  });
});

document.querySelector('#new-device').addEventListener('click', () => editDevice());
document.querySelector('#new-user').addEventListener('click', () => editUser());
document.querySelector('#device-form').addEventListener('submit', saveDevice);
document.querySelector('#user-form').addEventListener('submit', saveUser);
document.querySelector('#test-device').addEventListener('click', testDevice);
document.querySelector('#device-driver').addEventListener('change', () => toggleDeviceIntegration(true));
document.querySelector('#device-kind').addEventListener('change', () => toggleDeviceIntegration(false));
document.querySelector('#user-role').addEventListener('change', toggleAdminAccess);
document.querySelector('#refresh-audit').addEventListener('click', () => loadAudit().then(() => showToast('Журнал оновлено')).catch((error) => showToast(error.message, true)));
document.querySelector('#refresh-audio').addEventListener('click', () => loadAudio().then(() => showToast('Аудіостан оновлено')));
document.querySelector('#bluetooth-power').addEventListener('change', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await audioMutation('/api/admin/audio/bluetooth/power', { enabled: event.currentTarget.checked }, 'Bluetooth оновлено');
  } catch (error) { showToast(error.message, true); await loadAudio({ quiet: true }); }
  finally { event.currentTarget.disabled = false; }
});
document.querySelector('#scan-bluetooth').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try { await audioMutation('/api/admin/audio/bluetooth/scan', { enabled: true, seconds: 20 }, 'Пошук Bluetooth розпочато'); }
  catch (error) { showToast(error.message, true); }
  finally { event.currentTarget.disabled = false; }
});
document.querySelector('#stop-bluetooth-scan').addEventListener('click', async () => {
  try { await audioMutation('/api/admin/audio/bluetooth/scan', { enabled: false, seconds: 15 }, 'Пошук зупинено'); }
  catch (error) { showToast(error.message, true); }
});
document.querySelector('#audio-volume').addEventListener('input', (event) => {
  document.querySelector('#audio-volume-value').textContent = `${event.currentTarget.value}%`;
});
document.querySelector('#audio-volume').addEventListener('change', async (event) => {
  try { await audioMutation('/api/admin/audio/volume', { percent: Number(event.currentTarget.value) }, 'Гучність змінено'); }
  catch (error) { showToast(error.message, true); }
});
document.querySelector('#audio-mute').addEventListener('click', async (event) => {
  try { await audioMutation('/api/admin/audio/mute', { enabled: event.currentTarget.dataset.muted !== '1' }); }
  catch (error) { showToast(error.message, true); }
});
document.querySelector('#audio-sink').addEventListener('change', async (event) => {
  if (!event.currentTarget.value) return;
  try { await audioMutation('/api/admin/audio/default-sink', { nodeId: Number(event.currentTarget.value) }, 'Аудіовихід змінено'); }
  catch (error) { showToast(error.message, true); }
});
document.querySelectorAll('[data-player-action]').forEach((button) => button.addEventListener('click', async () => {
  try { await audioMutation('/api/admin/audio/player', { action: button.dataset.playerAction }); }
  catch (error) { showToast(error.message, true); }
}));
document.querySelector('#clap-enabled').addEventListener('change', async (event) => {
  event.currentTarget.disabled = true;
  try { await saveClapConfig(event.currentTarget.checked ? 'Керування хлопками увімкнено' : 'Керування хлопками вимкнено'); }
  catch (error) { showToast(error.message, true); await loadAudio({ quiet: true }); }
  finally { event.currentTarget.disabled = false; }
});
document.querySelector('#clap-sensitivity').addEventListener('input', (event) => {
  document.querySelector('#clap-sensitivity-value').textContent = `${event.currentTarget.value}%`;
});
document.querySelector('#clap-sensitivity').addEventListener('change', async () => {
  try { await saveClapConfig('Чутливість хлопків збережено'); }
  catch (error) { showToast(error.message, true); await loadAudio({ quiet: true }); }
});
document.querySelector('#clap-max-interval').addEventListener('input', (event) => {
  document.querySelector('#clap-max-interval-value').textContent = `${new Intl.NumberFormat('uk-UA', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(Number(event.currentTarget.value) / 1000)} с`;
});
document.querySelector('#clap-max-interval').addEventListener('change', async () => {
  try { await saveClapConfig('Інтервал між хлопками збережено'); }
  catch (error) { showToast(error.message, true); await loadAudio({ quiet: true }); }
});
document.querySelector('#refresh-starlink').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try { await loadStarlink({ includeMap: true }); showToast('Дані Starlink оновлено'); }
  finally { event.currentTarget.disabled = false; }
});
document.querySelector('#starlink-dish-tab').addEventListener('click', () => showStarlinkDevice('dish'));
document.querySelector('#starlink-router-tab').addEventListener('click', () => showStarlinkDevice('router'));
document.querySelector('#starlink-gps-inhibit').addEventListener('change', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await starlinkMutation('/api/admin/starlink/gps', { inhibited: event.currentTarget.checked }, 'Налаштування GPS оновлено');
  } catch (error) {
    showToast(error.message, true);
    await loadStarlink({ quiet: true });
  } finally { event.currentTarget.disabled = false; }
});
document.querySelector('#starlink-apply-sleep').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    const localMinutes = timeToMinutes(document.querySelector('#starlink-sleep-start').value);
    const startMinutesUtc = ((localMinutes - kyivUtcOffsetMinutes()) % 1440 + 1440) % 1440;
    await starlinkMutation('/api/admin/starlink/power-save', {
      enabled: document.querySelector('#starlink-sleep-enabled').checked,
      startMinutesUtc,
      durationMinutes: Number(document.querySelector('#starlink-sleep-duration').value)
    }, 'Розклад сну Starlink оновлено');
  } catch (error) { showToast(error.message, true); }
  finally { event.currentTarget.disabled = false; }
});
document.querySelector('#starlink-clear-map').addEventListener('click', async (event) => {
  if (!window.confirm('Очистити накопичену карту перешкод? Starlink почне будувати її заново.')) return;
  event.currentTarget.disabled = true;
  try {
    await starlinkMutation('/api/admin/starlink/clear-obstruction-map', { confirm: true }, 'Карту перешкод очищено');
    state.starlinkMap = null;
    document.querySelector('#starlink-map-empty').textContent = 'Карта будується заново…';
    renderStarlinkMap();
  } catch (error) { showToast(error.message, true); }
  finally { event.currentTarget.disabled = false; }
});
document.querySelector('#starlink-reboot').addEventListener('click', async (event) => {
  if (!window.confirm('Перезавантажити тарілку Starlink? Інтернет у лабораторії тимчасово зникне.')) return;
  event.currentTarget.disabled = true;
  try { await starlinkMutation('/api/admin/starlink/reboot', { confirm: true }, 'Команду перезавантаження надіслано'); }
  catch (error) { showToast(error.message, true); }
  finally { event.currentTarget.disabled = false; }
});
['stow', 'unstow'].forEach((action) => {
  document.querySelector(`#starlink-${action}`).addEventListener('click', async (event) => {
    const label = action === 'stow' ? 'скласти' : 'розкласти';
    if (!window.confirm(`Справді ${label} тарілку Starlink?`)) return;
    event.currentTarget.disabled = true;
    try {
      await starlinkMutation(`/api/admin/starlink/${action}`, { confirm: true }, `Команду «${label}» надіслано`);
      await loadStarlink({ quiet: true });
    } catch (error) { showToast(error.message, true); }
    finally { event.currentTarget.disabled = false; }
  });
});
document.querySelectorAll('[data-close-editor]').forEach((button) => button.addEventListener('click', () => button.closest('form').classList.add('hidden')));

async function start() {
  try {
    state.me = await api('/api/me');
    if (state.me.role !== 'admin') throw new Error('Потрібні права адміністратора');
    document.querySelector('#identity-name').textContent = state.me.displayName || state.me.email;
    initDesktop({ showToast });
    await Promise.all([loadDevices(), loadUsers()]);
    startAudioPolling();
    startStarlinkPolling();
  } catch (error) { showToast(error.message, true); }
}

start();
