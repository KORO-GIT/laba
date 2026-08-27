import net from 'node:net';
import { decryptSecret } from './security.mjs';

const cache = new Map();
const CACHE_TTL_MS = 8_000;
const PROBE_TIMEOUT_MS = 2_500;

function secretObject(device) {
  if (!device.secret_enc) return {};
  try {
    return JSON.parse(decryptSecret(device.secret_enc));
  } catch {
    return {};
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    redirect: 'manual'
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function tcpProbe(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const finish = (error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(new Error('Timeout')));
    socket.once('connect', () => finish());
    socket.once('error', finish);
  });
}

function roundTemperature(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

async function moonrakerProbe(device) {
  const base = `${device.protocol}://${device.host}:${device.api_port ?? 7125}`;
  const info = await fetchJson(`${base}/server/info`);
  const state = info?.result?.klippy_state ?? 'unknown';
  let telemetry = {};

  try {
    const objects = await fetchJson(
      `${base}/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed`
    );
    const status = objects?.result?.status ?? {};
    telemetry = {
      jobState: status.print_stats?.state ?? null,
      filename: status.print_stats?.filename ?? null,
      progress: Number.isFinite(status.virtual_sdcard?.progress)
        ? Math.round(status.virtual_sdcard.progress * 100)
        : null,
      nozzle: roundTemperature(status.extruder?.temperature),
      nozzleTarget: roundTemperature(status.extruder?.target),
      bed: roundTemperature(status.heater_bed?.temperature),
      bedTarget: roundTemperature(status.heater_bed?.target)
    };
  } catch {
    // Server health is still valid when optional telemetry is unavailable.
  }

  return {
    online: state !== 'disconnected' && state !== 'error',
    state,
    message: state === 'ready' ? 'Готов к работе' : `Klipper: ${state}`,
    telemetry
  };
}

async function octoprintProbe(device) {
  const secret = secretObject(device);
  const headers = secret.apiKey ? { 'X-Api-Key': secret.apiKey } : {};
  const base = `${device.protocol}://${device.host}:${device.api_port ?? device.ui_port}`;
  const version = await fetchJson(`${base}/api/version`, { headers });
  return {
    online: true,
    state: 'ready',
    message: version?.server ? `OctoPrint ${version.server}` : 'OctoPrint доступен',
    telemetry: {}
  };
}

async function httpProbe(device) {
  const response = await fetch(`${device.protocol}://${device.host}:${device.ui_port}/`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    redirect: 'manual'
  });
  return {
    online: response.status < 500,
    state: 'online',
    message: `HTTP ${response.status}`,
    telemetry: {}
  };
}

async function uncachedProbe(device) {
  const started = performance.now();
  let result;

  if (!device.enabled) {
    result = { online: false, state: 'disabled', message: 'Отключено', telemetry: {} };
  } else if (device.driver === 'moonraker') {
    result = await moonrakerProbe(device);
  } else if (device.driver === 'octoprint') {
    result = await octoprintProbe(device);
  } else if (device.driver === 'rtsp') {
    await tcpProbe(device.host, device.ui_port || 554);
    result = { online: true, state: 'online', message: 'RTSP доступен', telemetry: {} };
  } else {
    result = await httpProbe(device);
  }

  return {
    ...result,
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
    checkedAt: new Date().toISOString()
  };
}

export async function probeDevice(device, force = false) {
  const cached = cache.get(device.id);
  if (!force && cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.value;

  let value;
  try {
    value = await uncachedProbe(device);
  } catch (error) {
    value = {
      online: false,
      state: 'offline',
      message: error?.name === 'TimeoutError' ? 'Тайм-аут подключения' : 'Нет соединения',
      telemetry: {},
      latencyMs: null,
      checkedAt: new Date().toISOString()
    };
  }

  cache.set(device.id, { time: Date.now(), value });
  return value;
}

export function clearProbeCache(deviceId) {
  cache.delete(Number(deviceId));
}
