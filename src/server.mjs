import httpProxy from 'http-proxy';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { audioAgentRequest } from './audio-agent.mjs';
import { config, validateConfig } from './config.mjs';
import { audit, db, serializeDevice, serializeUser, statements } from './database.mjs';
import { clearProbeCache, probeDevice } from './probes.mjs';
import {
  accessRank,
  authenticatedEmail,
  decryptSecret,
  encryptSecret,
  isAllowedDeviceHost,
  requireSameOrigin,
  safeSlug,
  safeStreamName
} from './security.mjs';
import { starlinkAgentRequest } from './starlink-agent.mjs';

validateConfig();

const app = Fastify({
  logger: { level: config.nodeEnv === 'production' ? 'info' : 'warn' },
  trustProxy: true,
  bodyLimit: 128 * 1024
});

await app.register(cookie);
await app.register(rateLimit, {
  max: 240,
  timeWindow: '1 minute',
  ban: 3
});
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' }
});
await app.register(fastifyStatic, {
  root: config.publicDir,
  prefix: '/assets/',
  decorateReply: true,
  index: false,
  immutable: true,
  maxAge: '1h'
});

app.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  if (!request.url.startsWith('/assets/') && !request.url.startsWith('/novnc/')) {
    reply.header('Cache-Control', 'no-store');
  }
  return payload;
});

function hostOnly(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));
  return raw.split(':')[0];
}

function subdomainSlug(headers) {
  const host = hostOnly(headers['x-forwarded-host'] ?? headers.host);
  if (host.endsWith(config.deviceHostSuffix)) {
    const slug = host.slice(0, -config.deviceHostSuffix.length);
    return safeSlug(slug) ? slug : null;
  }
  return null;
}

function isPortalHost(headers) {
  const host = hostOnly(headers['x-forwarded-host'] ?? headers.host);
  return host === config.baseDomain || host === 'localhost' || host === '127.0.0.1';
}

function isBrowserCamera(device) {
  return device?.kind === 'camera' && device.driver === 'http' && Boolean(device.stream_name);
}

function browserCameraMeta(device) {
  return {
    name: device.name,
    portalUrl: `https://${config.baseDomain}/`,
    modes: device.stream_mode === 'mjpeg' ? 'mjpeg' : 'mse,hls,mjpeg'
  };
}

const embeddedCameraContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'"
].join('; ');

const browserCameraAssets = new Set([
  '/assets/styles.css',
  '/assets/favicon.svg',
  '/assets/camera.js',
  '/assets/vendor/go2rtc/video-rtc.js',
  '/assets/vendor/go2rtc/video-stream.js'
]);

const browserCameraHlsPaths = new Map([
  ['/gateway/hls/playlist.m3u8', '/api/hls/playlist.m3u8'],
  ['/gateway/hls/segment.ts', '/api/hls/segment.ts'],
  ['/gateway/hls/init.mp4', '/api/hls/init.mp4'],
  ['/gateway/hls/segment.m4s', '/api/hls/segment.m4s']
]);

const printerCameraHlsPaths = new Map([
  ['/laba-camera/api/hls/playlist.m3u8', '/api/hls/playlist.m3u8'],
  ['/laba-camera/api/hls/segment.ts', '/api/hls/segment.ts'],
  ['/laba-camera/api/hls/init.mp4', '/api/hls/init.mp4'],
  ['/laba-camera/api/hls/segment.m4s', '/api/hls/segment.m4s']
]);

function hlsSessionUpstreamUrl(url, upstreamPath) {
  const sessionIds = url.searchParams.getAll('id');
  if (sessionIds.length !== 1 || !/^[a-zA-Z0-9_-]{6,128}$/.test(sessionIds[0])) return null;

  const segmentNumbers = url.searchParams.getAll('n');
  const isSegment = upstreamPath.endsWith('/segment.ts') || upstreamPath.endsWith('/segment.m4s');
  if (segmentNumbers.length > (isSegment ? 1 : 0)) return null;
  if (segmentNumbers.length === 1 && !/^\d{1,12}$/.test(segmentNumbers[0])) return null;
  if (![...url.searchParams.keys()].every((key) => key === 'id' || (isSegment && key === 'n'))) return null;

  const params = new URLSearchParams({ id: sessionIds[0] });
  if (segmentNumbers.length === 1) params.set('n', segmentNumbers[0]);
  return `${upstreamPath}?${params}`;
}

function requestUrl(value) {
  return new URL(String(value ?? '/'), 'http://portal.invalid');
}

function userAccessMap(user) {
  if (user.role === 'admin') return null;
  return new Map(
    statements.accessForUser.all(user.id).map((row) => [row.device_id, row.access_level])
  );
}

function effectiveAccess(user, deviceId) {
  if (user.role === 'admin') return 'admin';
  const device = statements.deviceById.get(deviceId);
  let grant = statements.accessForUserAndDevice.get(user.id, deviceId)?.access_level ?? 'none';
  if (grant === 'none' && device?.kind === 'camera' && device.parent_device_id) {
    grant = statements.accessForUserAndDevice.get(user.id, device.parent_device_id)?.access_level ?? 'none';
  }
  const roleCap = user.role === 'operator' ? 'operator' : 'viewer';
  return accessRank(grant) < accessRank(roleCap) ? grant : roleCap;
}

function canOpenDevice(user, device) {
  const level = effectiveAccess(user, device.id);
  return device.kind === 'printer'
    ? accessRank(level) >= accessRank('operator')
    : accessRank(level) >= accessRank('viewer');
}

async function resolveUser(headers) {
  const email = await authenticatedEmail(headers);
  const user = statements.userByEmail.get(email);
  if (!user || !user.enabled) {
    const error = new Error('Користувач не має доступу до порталу');
    error.statusCode = 403;
    throw error;
  }
  return user;
}

app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/healthz' && isPortalHost(request.headers)) return;
  try {
    request.portalUser = await resolveUser(request.headers);
  } catch (error) {
    return reply.code(error.statusCode ?? 401).send({ error: error.message ?? 'Не авторизовано' });
  }
  // Device hosts must take priority over portal routes such as /assets/*.
  // Printer and camera UIs commonly use those same top-level paths.
  const slug = subdomainSlug(request.headers);
  if (slug) {
    const device = statements.deviceBySlug.get(slug);
    const pathname = requestUrl(request.url).pathname;
    if (isBrowserCamera(device) && browserCameraAssets.has(pathname)) return;
    if (device?.kind === 'printer' && browserCameraAssets.has(pathname)) {
      const camera = statements.cameraByParent.get(device.id);
      if (isBrowserCamera(camera) && canOpenDevice(request.portalUser, camera)) return;
    }
    return proxyHttp(request, reply);
  }
});

function requireAdmin(request, reply, done) {
  if (request.portalUser?.role !== 'admin') {
    reply.code(403).send({ error: 'Потрібні права адміністратора' });
    return;
  }
  done();
}

function guardWrite(request, reply, done) {
  try {
    requireSameOrigin(request);
    if (request.headers['x-portal-request'] !== '1') throw new Error('Відсутня ознака запиту');
    done();
  } catch {
    reply.code(403).send({ error: 'Запит відхилено захистом CSRF' });
  }
}

function parseOrReply(schema, value, reply) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    reply.code(400).send({ error: 'Некоректні дані', fields: parsed.error.flatten().fieldErrors });
    return null;
  }
  return parsed.data;
}

function validateDeviceNetwork(device, reply) {
  if (!isAllowedDeviceHost(device.host)) {
    reply.code(400).send({
      error: `Адреса має належати дозволеній домашній мережі: ${config.allowedSubnets.join(', ')}`
    });
    return false;
  }
  return true;
}

const deviceSchema = z.object({
  slug: z.string().trim().toLowerCase().refine(safeSlug, 'Неприпустимий ідентифікатор адреси'),
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['printer', 'camera']),
  driver: z.enum(['moonraker', 'octoprint', 'http', 'rtsp']),
  host: z.string().trim(),
  protocol: z.enum(['http', 'https', 'rtsp']),
  uiPort: z.coerce.number().int().min(1).max(65535),
  apiPort: z.union([z.coerce.number().int().min(1).max(65535), z.literal(null)]).optional(),
  streamName: z.string().trim().max(128).optional().default(''),
  streamMode: z.enum(['auto', 'mjpeg']).optional().default('auto'),
  parentDeviceId: z.union([z.coerce.number().int().positive(), z.literal(null)]).optional().default(null),
  secret: z.string().max(4096).optional(),
  keepSecret: z.boolean().optional().default(true),
  notes: z.string().trim().max(500).optional().default(''),
  enabled: z.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(-10000).max(10000).optional().default(0)
}).superRefine((device, context) => {
  if (device.driver === 'rtsp' && device.protocol !== 'rtsp') {
    context.addIssue({ code: 'custom', path: ['protocol'], message: 'Для RTSP виберіть протокол RTSP' });
  }
  if (device.driver !== 'rtsp' && device.protocol === 'rtsp') {
    context.addIssue({ code: 'custom', path: ['protocol'], message: 'RTSP доступний лише для інтеграції RTSP' });
  }
  if (device.driver === 'moonraker' && !device.apiPort) {
    context.addIssue({ code: 'custom', path: ['apiPort'], message: 'Для Moonraker потрібен порт API' });
  }
  if (device.streamName && !safeStreamName(device.streamName)) {
    context.addIssue({ code: 'custom', path: ['streamName'], message: 'Неприпустиме ім\'я потоку' });
  }
  if (device.streamName && (device.kind !== 'camera' || device.driver !== 'http')) {
    context.addIssue({ code: 'custom', path: ['streamName'], message: 'Потік go2rtc доступний лише для HTTP-камери' });
  }
  if (device.streamName && !['http', 'https'].includes(device.protocol)) {
    context.addIssue({ code: 'custom', path: ['protocol'], message: 'Для go2rtc потрібен HTTP або HTTPS' });
  }
  if (device.streamMode !== 'auto' && !device.streamName) {
    context.addIssue({ code: 'custom', path: ['streamMode'], message: 'Режим потоку доступний лише для go2rtc' });
  }
  if (device.parentDeviceId && device.kind !== 'camera') {
    context.addIssue({ code: 'custom', path: ['parentDeviceId'], message: 'До принтера можна прив’язати лише камеру' });
  }
});

function validateDeviceRelation(device, reply) {
  if (!device.parentDeviceId) return true;
  const parent = statements.deviceById.get(device.parentDeviceId);
  if (!parent || parent.kind !== 'printer') {
    reply.code(400).send({ error: 'Батьківський пристрій має бути наявним принтером' });
    return false;
  }
  return true;
}

const userSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  displayName: z.string().trim().max(80).optional().default(''),
  role: z.enum(['viewer', 'operator', 'admin']),
  enabled: z.boolean().optional().default(true),
  access: z.array(z.object({
    deviceId: z.coerce.number().int().positive(),
    level: z.enum(['viewer', 'operator'])
  })).optional().default([])
}).superRefine((user, context) => {
  const ids = user.access.map((grant) => grant.deviceId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['access'], message: 'Пристрій зазначено кілька разів' });
  }
});

const bluetoothPowerSchema = z.object({ enabled: z.boolean() }).strict();
const bluetoothScanSchema = z.object({
  enabled: z.boolean(),
  seconds: z.coerce.number().int().min(5).max(30).optional().default(15)
}).strict();
const bluetoothAddressSchema = z.string().trim().toUpperCase().regex(/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/);
const bluetoothActionSchema = z.enum(['pair', 'trust', 'untrust', 'connect', 'disconnect', 'remove']);
const audioVolumeSchema = z.object({ percent: z.coerce.number().int().min(0).max(100) }).strict();
const audioMuteSchema = z.object({ enabled: z.boolean() }).strict();
const audioSinkSchema = z.object({ nodeId: z.coerce.number().int().min(1).max(1_000_000) }).strict();
const playerActionSchema = z.object({
  action: z.enum(['play', 'pause', 'play-pause', 'next', 'previous', 'stop'])
}).strict();
const clapConfigSchema = z.object({
  enabled: z.boolean(),
  sensitivity: z.coerce.number().int().min(30).max(80),
  maxIntervalMs: z.coerce.number().int().min(350).max(1_500)
}).strict();
const starlinkConfirmSchema = z.object({ confirm: z.literal(true) }).strict();
const starlinkGpsSchema = z.object({ inhibited: z.boolean() }).strict();
const starlinkPowerSaveSchema = z.object({
  enabled: z.boolean(),
  startMinutesUtc: z.coerce.number().int().min(0).max(1439),
  durationMinutes: z.coerce.number().int().min(1).max(1440)
}).strict();

function secretPayload(raw) {
  if (!raw) return null;
  try {
    JSON.parse(raw);
    return encryptSecret(raw);
  } catch {
    return encryptSecret(JSON.stringify({ password: raw }));
  }
}

function replaceUserAccess(userId, access) {
  db.prepare('DELETE FROM user_device_access WHERE user_id = ?').run(userId);
  const insert = db.prepare(`
    INSERT INTO user_device_access (user_id, device_id, access_level) VALUES (?, ?, ?)
  `);
  for (const grant of access) insert.run(userId, grant.deviceId, grant.level);
}

function accessDevicesExist(access) {
  const existingIds = new Set(statements.listDevices.all().map((device) => device.id));
  return access.every((grant) => existingIds.has(grant.deviceId));
}

function enabledAdminCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1").get().count;
}

app.get('/healthz', async () => ({ ok: true, service: 'laba-portal' }));

app.get('/', async (request, reply) => {
  if (!isPortalHost(request.headers)) return proxyHttp(request, reply);
  return reply.sendFile('index.html');
});

app.get('/admin', async (request, reply) => {
  if (request.portalUser.role !== 'admin') return reply.code(403).send({ error: 'Доступ заборонено' });
  return reply.sendFile('admin.html');
});

app.route({
  method: ['GET', 'HEAD'],
  url: '/novnc/*',
  handler: async (request, reply) => reply.sendFile(
    request.params['*'],
    config.novncDir,
    { immutable: true, maxAge: '1d' }
  )
});

app.get('/api/me', async (request) => {
  statements.touchUserLogin.run(request.portalUser.id);
  return {
    email: request.portalUser.email,
    displayName: request.portalUser.display_name,
    role: request.portalUser.role,
    baseDomain: config.baseDomain
  };
});

app.get('/api/devices', async (request) => {
  const rows = statements.listDevices.all().filter((device) => device.enabled);
  const grants = userAccessMap(request.portalUser);
  const visible = request.portalUser.role === 'admin'
    ? rows
    : rows.filter((device) => grants.has(device.id)
      || (device.kind === 'camera' && device.parent_device_id && grants.has(device.parent_device_id)));

  return Promise.all(visible.map(async (device) => {
    const access = effectiveAccess(request.portalUser, device.id);
    return {
      ...serializeDevice(device),
      access,
      canOpen: canOpenDevice(request.portalUser, device),
      proxyUrl: `https://${device.slug}${config.deviceHostSuffix}/`,
      status: await probeDevice(device)
    };
  }));
});

app.get('/api/admin/devices', { preHandler: requireAdmin }, async () =>
  statements.listDevices.all().map((row) => serializeDevice(row, true))
);

app.post('/api/admin/devices', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(deviceSchema, request.body, reply);
  if (!body || !validateDeviceNetwork(body, reply) || !validateDeviceRelation(body, reply)) return;
  try {
    const result = db.prepare(`
      INSERT INTO devices
        (slug, name, kind, driver, host, protocol, ui_port, api_port, stream_name,
         stream_mode, parent_device_id, secret_enc, notes, enabled, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.slug, body.name, body.kind, body.driver, body.host, body.protocol,
      body.uiPort, body.apiPort ?? null, body.streamName || null, body.streamMode,
      body.parentDeviceId, secretPayload(body.secret), body.notes,
      body.enabled ? 1 : 0, body.sortOrder
    );
    audit(request.portalUser.email, 'device.create', 'device', result.lastInsertRowid, { slug: body.slug });
    return reply.code(201).send(serializeDevice(statements.deviceById.get(result.lastInsertRowid), true));
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Такий піддомен уже існує' });
    throw error;
  }
});

app.patch('/api/admin/devices/:id', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const existing = statements.deviceById.get(Number(request.params.id));
  if (!existing) return reply.code(404).send({ error: 'Пристрій не знайдено' });
  const body = parseOrReply(deviceSchema, request.body, reply);
  if (!body || !validateDeviceNetwork(body, reply) || !validateDeviceRelation(body, reply)) return;
  const encrypted = body.keepSecret && !body.secret ? existing.secret_enc : secretPayload(body.secret);
  try {
    db.prepare(`
      UPDATE devices SET
        slug = ?, name = ?, kind = ?, driver = ?, host = ?, protocol = ?, ui_port = ?,
        api_port = ?, stream_name = ?, stream_mode = ?, parent_device_id = ?, secret_enc = ?,
        notes = ?, enabled = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      body.slug, body.name, body.kind, body.driver, body.host, body.protocol, body.uiPort,
      body.apiPort ?? null, body.streamName || null, body.streamMode, body.parentDeviceId,
      encrypted, body.notes,
      body.enabled ? 1 : 0, body.sortOrder, existing.id
    );
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Такий піддомен уже існує' });
    throw error;
  }
  clearProbeCache(existing.id);
  audit(request.portalUser.email, 'device.update', 'device', existing.id, { slug: body.slug });
  return serializeDevice(statements.deviceById.get(existing.id), true);
});

app.post('/api/admin/devices/:id/test', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const device = statements.deviceById.get(Number(request.params.id));
  if (!device) return reply.code(404).send({ error: 'Пристрій не знайдено' });
  const status = await probeDevice(device, true);
  audit(request.portalUser.email, 'device.test', 'device', device.id, { online: status.online });
  return status;
});

app.get('/api/admin/users', { preHandler: requireAdmin }, async () =>
  statements.listUsers.all().map(serializeUser)
);

app.post('/api/admin/users', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(userSchema, request.body, reply);
  if (!body) return;
  if (!accessDevicesExist(body.access)) return reply.code(400).send({ error: 'Один із пристроїв не існує' });
  try {
    let result;
    db.transaction(() => {
      result = db.prepare(`
        INSERT INTO users (email, display_name, role, enabled) VALUES (?, ?, ?, ?)
      `).run(body.email, body.displayName, body.role, body.enabled ? 1 : 0);
      replaceUserAccess(Number(result.lastInsertRowid), body.access);
      audit(request.portalUser.email, 'user.create', 'user', result.lastInsertRowid, {
        email: body.email,
        role: body.role
      });
    })();
    return reply.code(201).send(serializeUser(
      statements.listUsers.all().find((row) => row.id === Number(result.lastInsertRowid))
    ));
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Користувач уже існує' });
    throw error;
  }
});

app.patch('/api/admin/users/:id', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const userId = Number(request.params.id);
  const existing = statements.userById.get(userId);
  if (!existing) return reply.code(404).send({ error: 'Користувача не знайдено' });
  const body = parseOrReply(userSchema, request.body, reply);
  if (!body) return;
  if (!accessDevicesExist(body.access)) return reply.code(400).send({ error: 'Один із пристроїв не існує' });
  const removesAdmin = existing.role === 'admin' && existing.enabled && (body.role !== 'admin' || !body.enabled);
  if (removesAdmin && enabledAdminCount() <= 1) {
    return reply.code(409).send({ error: 'Не можна вимкнути останнього адміністратора' });
  }
  if (existing.id === request.portalUser.id && !body.enabled) {
    return reply.code(409).send({ error: 'Не можна вимкнути власний обліковий запис' });
  }
  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE users SET email = ?, display_name = ?, role = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(body.email, body.displayName, body.role, body.enabled ? 1 : 0, userId);
      replaceUserAccess(userId, body.access);
    })();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Користувач із таким e-mail уже існує' });
    throw error;
  }
  audit(request.portalUser.email, 'user.update', 'user', userId, { email: body.email, role: body.role });
  return serializeUser(statements.listUsers.all().find((row) => row.id === userId));
});

app.get('/api/admin/audit', { preHandler: requireAdmin }, async (request) => {
  const limit = Math.min(300, Math.max(20, Number(request.query?.limit ?? 100)));
  return statements.listAudit.all(limit).map((row) => ({
    ...row,
    details: JSON.parse(row.details_json || '{}'),
    details_json: undefined
  }));
});

app.get('/api/admin/audio', {
  preHandler: requireAdmin,
  config: { rateLimit: { max: 120, timeWindow: '1 minute' } }
}, async () => audioAgentRequest('/v1/status'));

app.post('/api/admin/audio/bluetooth/power', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(bluetoothPowerSchema, request.body, reply);
  if (!body) return;
  const result = await audioAgentRequest('/v1/bluetooth/power', { method: 'POST', body });
  audit(request.portalUser.email, 'audio.bluetooth.power', 'audio', null, { enabled: body.enabled });
  return result;
});

app.post('/api/admin/audio/bluetooth/scan', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(bluetoothScanSchema, request.body, reply);
  if (!body) return;
  const result = await audioAgentRequest('/v1/bluetooth/scan', { method: 'POST', body });
  audit(request.portalUser.email, 'audio.bluetooth.scan', 'audio', null, { enabled: body.enabled });
  return result;
});

app.post('/api/admin/audio/bluetooth/devices/:address/:action', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const address = parseOrReply(bluetoothAddressSchema, request.params.address, reply);
  const action = parseOrReply(bluetoothActionSchema, request.params.action, reply);
  if (!address || !action) return;
  const result = await audioAgentRequest(
    `/v1/bluetooth/devices/${address}/${action}`,
    { method: 'POST', body: {} }
  );
  audit(request.portalUser.email, `audio.bluetooth.${action}`, 'bluetooth-device', address);
  return result;
});

app.post('/api/admin/audio/volume', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(audioVolumeSchema, request.body, reply);
  if (!body) return;
  const result = await audioAgentRequest('/v1/audio/volume', { method: 'POST', body });
  audit(request.portalUser.email, 'audio.volume', 'audio', null, { percent: body.percent });
  return result;
});

app.post('/api/admin/audio/mute', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(audioMuteSchema, request.body, reply);
  if (!body) return;
  const result = await audioAgentRequest('/v1/audio/mute', { method: 'POST', body });
  audit(request.portalUser.email, 'audio.mute', 'audio', null, { enabled: body.enabled });
  return result;
});

app.post('/api/admin/audio/default-sink', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(audioSinkSchema, request.body, reply);
  if (!body) return;
  const result = await audioAgentRequest('/v1/audio/default-sink', { method: 'POST', body });
  audit(request.portalUser.email, 'audio.default-sink', 'audio', body.nodeId);
  return result;
});

app.post('/api/admin/audio/player', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(playerActionSchema, request.body, reply);
  if (!body) return;
  const result = await audioAgentRequest('/v1/player/action', { method: 'POST', body });
  audit(request.portalUser.email, `audio.player.${body.action}`, 'audio', null);
  return result;
});

app.post('/api/admin/audio/clap/config', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(clapConfigSchema, request.body, reply);
  if (!body) return;
  const result = await audioAgentRequest('/v1/clap/config', { method: 'POST', body });
  audit(request.portalUser.email, 'audio.clap.config', 'audio', null, body);
  return result;
});

app.get('/api/admin/starlink', {
  preHandler: requireAdmin,
  config: { rateLimit: { max: 120, timeWindow: '1 minute' } }
}, async () => starlinkAgentRequest('/v1/status'));

app.get('/api/admin/starlink/obstruction-map', {
  preHandler: requireAdmin,
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async () => starlinkAgentRequest('/v1/obstruction-map'));

app.post('/api/admin/starlink/reboot', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }
}, async (request, reply) => {
  const body = parseOrReply(starlinkConfirmSchema, request.body, reply);
  if (!body) return;
  const result = await starlinkAgentRequest('/v1/reboot', { method: 'POST', body });
  audit(request.portalUser.email, 'starlink.reboot', 'starlink', null);
  return result;
});

app.post('/api/admin/starlink/gps', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }
}, async (request, reply) => {
  const body = parseOrReply(starlinkGpsSchema, request.body, reply);
  if (!body) return;
  const result = await starlinkAgentRequest('/v1/gps', { method: 'POST', body });
  audit(request.portalUser.email, 'starlink.gps', 'starlink', null, body);
  return result;
});

app.post('/api/admin/starlink/power-save', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }
}, async (request, reply) => {
  const body = parseOrReply(starlinkPowerSaveSchema, request.body, reply);
  if (!body) return;
  const result = await starlinkAgentRequest('/v1/power-save', { method: 'POST', body });
  audit(request.portalUser.email, 'starlink.power-save', 'starlink', null, body);
  return result;
});

app.post('/api/admin/starlink/snow-melt', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }
}, async (_request, reply) => reply.code(403).send({
  error: 'Змінювати підігрів може лише власник акаунта у застосунку Starlink'
}));

app.post('/api/admin/starlink/clear-obstruction-map', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }
}, async (request, reply) => {
  const body = parseOrReply(starlinkConfirmSchema, request.body, reply);
  if (!body) return;
  const result = await starlinkAgentRequest('/v1/clear-obstruction-map', { method: 'POST', body });
  audit(request.portalUser.email, 'starlink.clear-obstruction-map', 'starlink', null);
  return result;
});

app.post('/api/admin/starlink/:action', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 4, timeWindow: '10 minutes' } }
}, async (request, reply) => {
  const action = parseOrReply(z.enum(['stow', 'unstow']), request.params.action, reply);
  const body = parseOrReply(starlinkConfirmSchema, request.body, reply);
  if (!action || !body) return;
  const result = await starlinkAgentRequest(`/v1/${action}`, { method: 'POST', body });
  audit(request.portalUser.email, `starlink.${action}`, 'starlink', null);
  return result;
});

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true });

function sanitizeProxyHeaders(proxyRequest, request) {
  proxyRequest.removeHeader('cf-access-jwt-assertion');
  proxyRequest.removeHeader('authorization');
  const cookies = String(request.headers.cookie ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item && !item.toLowerCase().startsWith('cf_authorization='));
  if (cookies.length) proxyRequest.setHeader('cookie', cookies.join('; '));
  else proxyRequest.removeHeader('cookie');
  const device = request.portalDevice;
  if (!device?.secret_enc) return;
  try {
    const secret = JSON.parse(decryptSecret(device.secret_enc));
    if (secret.username && secret.password) {
      const basic = Buffer.from(`${secret.username}:${secret.password}`).toString('base64');
      proxyRequest.setHeader('Authorization', `Basic ${basic}`);
    }
    if (secret.apiKey && device.driver === 'octoprint') {
      proxyRequest.setHeader('X-Api-Key', secret.apiKey);
    }
  } catch {
    // A malformed optional credential must not take down the proxy.
  }
}

proxy.on('proxyReq', sanitizeProxyHeaders);
proxy.on('proxyReqWs', (proxyRequest, request) => {
  sanitizeProxyHeaders(proxyRequest, request);
  if (request.portalDesktop) {
    proxyRequest.removeHeader('cookie');
    proxyRequest.removeHeader('origin');
    return;
  }
  // Moonraker rejects a public browser Origin unless it is explicitly listed
  // in the printer's local configuration. The portal validates that public
  // Origin first, then presents the upstream target as same-origin.
  proxyRequest.setHeader('Origin', new URL(proxyTarget(request.portalDevice)).origin);
});

proxy.on('proxyRes', (proxyResponse, request) => {
  if (!isBrowserCamera(request.portalDevice)) return;
  delete proxyResponse.headers['set-cookie'];
  proxyResponse.headers['cache-control'] = 'no-store';
  proxyResponse.headers['x-robots-tag'] = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
});

proxy.on('error', (error, request, response) => {
  app.log.warn({ err: error, host: request.headers.host }, 'Device proxy error');
  if (response?.writeHead && !response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  if (response?.end) response.end('Пристрій тимчасово недоступний');
  else response?.destroy?.();
});

function proxyTarget(device) {
  if (device.protocol === 'rtsp') return null;
  return `${device.protocol}://${device.host}:${device.ui_port}`;
}

function proxyBrowserCameraHttp(request, reply, device) {
  const url = requestUrl(request.raw.url);
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
    return reply.sendFile('camera.html');
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/gateway/meta') {
    return reply.send(browserCameraMeta(device));
  }
  const upstreamHlsPath = browserCameraHlsPaths.get(url.pathname);
  if ((request.method === 'GET' || request.method === 'HEAD') && upstreamHlsPath) {
    const upstreamUrl = hlsSessionUpstreamUrl(url, upstreamHlsPath);
    if (!upstreamUrl) {
      return reply.code(400).send({ error: 'Некоректна HLS-сесія' });
    }
    request.raw.url = upstreamUrl;
    request.raw.portalDevice = device;
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target: proxyTarget(device) });
    return;
  }
  return reply.code(404).send({ error: 'Шлях відеошлюзу не дозволено' });
}

function isSameOriginWebSocket(headers) {
  try {
    const origin = new URL(String(headers.origin ?? ''));
    const requestHost = hostOnly(headers['x-forwarded-host'] ?? headers.host);
    return ['http:', 'https:'].includes(origin.protocol) && hostOnly(origin.host) === requestHost;
  } catch {
    return false;
  }
}

const desktopConnectionAttempts = new Map();
let activeDesktopConnections = 0;

function allowDesktopConnection(email, socket) {
  const now = Date.now();
  const recent = (desktopConnectionAttempts.get(email) ?? [])
    .filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= 8 || activeDesktopConnections >= 2) return false;

  recent.push(now);
  desktopConnectionAttempts.set(email, recent);
  activeDesktopConnections += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeDesktopConnections = Math.max(0, activeDesktopConnections - 1);
  };
  socket.once('close', release);
  socket.once('error', release);
  return true;
}

async function proxyHttp(request, reply) {
  const slug = subdomainSlug(request.headers);
  if (!slug) return reply.code(404).send({ error: 'Невідомий хост порталу' });
  const device = statements.deviceBySlug.get(slug);
  if (!device || !device.enabled) return reply.code(404).send({ error: 'Пристрій не знайдено' });
  if (!canOpenDevice(request.portalUser, device)) return reply.code(403).send({ error: 'Немає доступу до пристрою' });
  const pathname = requestUrl(request.raw.url).pathname;
  if (device.kind === 'printer' && (request.method === 'GET' || request.method === 'HEAD')
    && pathname === '/webcam/laba/player') {
    const camera = statements.cameraByParent.get(device.id);
    if (!isBrowserCamera(camera) || !canOpenDevice(request.portalUser, camera)) {
      return reply.code(404).send({ error: 'Камеру принтера не налаштовано' });
    }
    reply.header('Content-Security-Policy', embeddedCameraContentSecurityPolicy);
    return reply.sendFile('camera.html');
  }
  if (device.kind === 'printer' && request.method === 'GET' && pathname === '/webcam/laba/meta') {
    const camera = statements.cameraByParent.get(device.id);
    if (!isBrowserCamera(camera) || !canOpenDevice(request.portalUser, camera)) {
      return reply.code(404).send({ error: 'Камеру принтера не налаштовано' });
    }
    return reply.send(browserCameraMeta(camera));
  }
  if (device.kind === 'printer' && (request.method === 'GET' || request.method === 'HEAD')
    && pathname === '/laba-camera/api/stream.m3u8') {
    const camera = statements.cameraByParent.get(device.id);
    if (!isBrowserCamera(camera) || !canOpenDevice(request.portalUser, camera)) {
      return reply.code(404).send({ error: 'Камеру принтера не налаштовано' });
    }
    request.raw.url = `/api/stream.m3u8?src=${encodeURIComponent(camera.stream_name)}&mp4`;
    request.raw.portalDevice = camera;
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target: proxyTarget(camera) });
    return;
  }
  const printerHlsPath = printerCameraHlsPaths.get(pathname);
  if (device.kind === 'printer' && (request.method === 'GET' || request.method === 'HEAD') && printerHlsPath) {
    const camera = statements.cameraByParent.get(device.id);
    if (!isBrowserCamera(camera) || !canOpenDevice(request.portalUser, camera)) {
      return reply.code(404).send({ error: 'Камеру принтера не налаштовано' });
    }
    const upstreamUrl = hlsSessionUpstreamUrl(requestUrl(request.raw.url), printerHlsPath);
    if (!upstreamUrl) return reply.code(400).send({ error: 'Некоректна HLS-сесія' });
    request.raw.url = upstreamUrl;
    request.raw.portalDevice = camera;
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target: proxyTarget(camera) });
    return;
  }
  if (device.kind === 'printer' && (request.method === 'GET' || request.method === 'HEAD')
    && ['/laba-camera/stream', '/laba-camera/snapshot'].includes(pathname)) {
    const camera = statements.cameraByParent.get(device.id);
    if (!isBrowserCamera(camera) || !canOpenDevice(request.portalUser, camera)) {
      return reply.code(404).send({ error: 'Камеру принтера не налаштовано' });
    }
    const upstreamPath = pathname.endsWith('/snapshot') ? '/api/frame.jpeg' : '/api/stream.mjpeg';
    request.raw.url = `${upstreamPath}?src=${encodeURIComponent(camera.stream_name)}`;
    request.raw.portalDevice = camera;
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target: proxyTarget(camera) });
    return;
  }
  if (isBrowserCamera(device)) return proxyBrowserCameraHttp(request, reply, device);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    && request.headers['sec-fetch-site'] === 'cross-site') {
    return reply.code(403).send({ error: 'Міжсайтовий запит до пристрою відхилено' });
  }
  const target = proxyTarget(device);
  if (!target) return reply.code(503).send({ error: 'Відеошлюз камери ще не налаштовано' });
  request.raw.portalDevice = device;
  reply.hijack();
  proxy.web(request.raw, reply.raw, { target });
}

app.route({
  method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  url: '/*',
  handler: async (request, reply) => {
    if (!isPortalHost(request.headers)) return proxyHttp(request, reply);
    if (request.method === 'GET' || request.method === 'HEAD') return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Не знайдено' });
  }
});

app.server.on('upgrade', async (request, socket, head) => {
  try {
    const url = requestUrl(request.url);
    if (isPortalHost(request.headers) && url.pathname === '/api/admin/desktop/ws') {
      if (url.search) throw new Error('Desktop websocket query rejected');
      if (!isSameOriginWebSocket(request.headers)) throw new Error('Cross-origin websocket rejected');
      const user = await resolveUser(request.headers);
      if (user.role !== 'admin') throw new Error('Forbidden');
      if (!allowDesktopConnection(user.email, socket)) throw new Error('Desktop websocket rate limit exceeded');
      request.url = '/';
      request.portalDesktop = true;
      audit(user.email, 'desktop.connect', 'raspberry-pi', null, { host: '192.168.0.63' });
      proxy.ws(request, socket, head, { target: config.desktopGatewayUrl });
      return;
    }
    const slug = subdomainSlug(request.headers);
    if (!slug) throw new Error('Unknown host');
    if (!isSameOriginWebSocket(request.headers)) throw new Error('Cross-origin websocket rejected');
    const user = await resolveUser(request.headers);
    const device = statements.deviceBySlug.get(slug);
    if (!device || !device.enabled || !canOpenDevice(user, device)) throw new Error('Forbidden');
    if (device.kind === 'printer' && url.pathname === '/webcam/laba/ws') {
      const camera = statements.cameraByParent.get(device.id);
      if (!isBrowserCamera(camera) || !canOpenDevice(user, camera)) throw new Error('Printer camera unavailable');
      request.url = `/api/ws?src=${encodeURIComponent(camera.stream_name)}`;
      request.portalDevice = camera;
      proxy.ws(request, socket, head, { target: proxyTarget(camera) });
      return;
    }
    const target = proxyTarget(device);
    if (!target) throw new Error('No browser stream configured');
    if (isBrowserCamera(device)) {
      if (url.pathname !== '/gateway/ws') throw new Error('Gateway websocket path rejected');
      request.url = `/api/ws?src=${encodeURIComponent(device.stream_name)}`;
    }
    request.portalDevice = device;
    proxy.ws(request, socket, head, { target });
  } catch (error) {
    app.log.warn({ err: error, host: request.headers.host }, 'Device websocket rejected');
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

app.setErrorHandler((error, request, reply) => {
  app.log.error({ err: error, method: request.method, url: request.url }, 'Unhandled request error');
  if (reply.sent) return;
  const status = Number(error.statusCode) >= 400 && Number(error.statusCode) < 500
    ? Number(error.statusCode)
    : 500;
  reply.code(status).send({ error: status === 500 ? 'Внутрішня помилка сервісу' : error.message });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}

await app.listen({ host: '127.0.0.1', port: config.port });
app.log.info(`Laba portal listening on 127.0.0.1:${config.port}`);
