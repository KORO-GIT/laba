import httpProxy from 'http-proxy';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { audioAgentRequest } from './audio-agent.mjs';
import { config, validateConfig } from './config.mjs';
import {
  audit,
  db,
  serializeDevice,
  serializeMaintenanceCard,
  serializeUser,
  statements
} from './database.mjs';
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
  bodyLimit: 2 * 1024 * 1024
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

const staticModuleDefinitions = {
  devices: {
    title: 'Пристрої',
    description: 'Принтери, камери та обладнання лабораторії.'
  }
};

const maintenanceModules = ['workshop', 'service'];
const moduleKeys = [...maintenanceModules, 'devices'];
const moduleAccessLevels = ['viewer', 'operator', 'admin'];
const serviceShippedLaneKey = 'shipped';
const lostAccountingStatus = 'ВТРАЧЕНИЙ';
const kyivLocation = 'КИЇВ';
const repairLocation = 'НА РЕМОНТІ';

function normalizedStatus(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('uk-UA');
}

function moduleAccess(user, module) {
  if (!moduleKeys.includes(module)) return 'none';
  if (user.email.toLowerCase() === config.bootstrapAdminEmail) return 'admin';
  return statements.moduleAccessForUserAndModule.get(user.id, module)?.access_level ?? 'none';
}

function moduleAccessMap(user) {
  return Object.fromEntries(moduleKeys.map((module) => [module, moduleAccess(user, module)]));
}

function requireModule(module, minimum = 'viewer') {
  return (request, reply, done) => {
    if (accessRank(moduleAccess(request.portalUser, module)) < accessRank(minimum)) {
      reply.code(403).send({ error: 'Немає доступу до цього розділу' });
      return;
    }
    done();
  };
}

function isInternalAccountingRequest(request) {
  return requestUrl(request.url).pathname.startsWith('/api/internal/accounting/');
}

function isLoopbackAddress(value) {
  const address = String(value ?? '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function safeTokenEquals(actual, expected) {
  const left = Buffer.from(String(actual ?? ''));
  const right = Buffer.from(String(expected ?? ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAccountingSync(request, reply, done) {
  const token = Array.isArray(request.headers['x-laba-sync-token'])
    ? request.headers['x-laba-sync-token'][0]
    : request.headers['x-laba-sync-token'];
  if (!isLoopbackAddress(request.raw.socket.remoteAddress)
    || config.accountingSyncToken.length < 32
    || !safeTokenEquals(token, config.accountingSyncToken)) {
    reply.code(403).send({ error: 'Доступ заборонено' });
    return;
  }
  done();
}

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
  if (moduleAccess(user, 'devices') === 'admin') return null;
  return new Map(
    statements.accessForUser.all(user.id).map((row) => [row.device_id, row.access_level])
  );
}

function effectiveAccess(user, deviceId) {
  const moduleLevel = moduleAccess(user, 'devices');
  if (moduleLevel === 'admin') return 'admin';
  const device = statements.deviceById.get(deviceId);
  let grant = statements.accessForUserAndDevice.get(user.id, deviceId)?.access_level ?? 'none';
  if (grant === 'none' && device?.kind === 'camera' && device.parent_device_id) {
    grant = statements.accessForUserAndDevice.get(user.id, device.parent_device_id)?.access_level ?? 'none';
  }
  const roleCap = moduleLevel;
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
  if (isInternalAccountingRequest(request)) {
    const token = Array.isArray(request.headers['x-laba-sync-token'])
      ? request.headers['x-laba-sync-token'][0]
      : request.headers['x-laba-sync-token'];
    if (isLoopbackAddress(request.raw.socket.remoteAddress)
      && config.accountingSyncToken.length >= 32
      && safeTokenEquals(token, config.accountingSyncToken)) return;
    return reply.code(403).send({ error: 'Доступ заборонено' });
  }
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
  })).optional().default([]),
  moduleAccess: z.object({
    workshop: z.enum(['none', ...moduleAccessLevels]).optional().default('none'),
    service: z.enum(['none', ...moduleAccessLevels]).optional().default('none'),
    devices: z.enum(['none', ...moduleAccessLevels]).optional().default('none')
  }).optional().default({ workshop: 'none', service: 'none', devices: 'none' })
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

const maintenanceMoveSchema = z.object({
  lane: z.string().trim().min(1).max(64),
  beforeCardId: z.union([z.coerce.number().int().positive(), z.literal(null)]).optional().default(null)
}).strict();
const maintenanceEditSchema = z.object({
  notes: z.string().trim().max(4000),
  reportNumber: z.string().trim().max(120).optional(),
  cardStatusIds: z.array(z.coerce.number().int().positive()).max(30).optional(),
  cardLabelIds: z.array(z.coerce.number().int().positive()).max(30).optional()
}).strict().superRefine((card, context) => {
  if (card.cardStatusIds && new Set(card.cardStatusIds).size !== card.cardStatusIds.length) {
    context.addIssue({ code: 'custom', path: ['cardStatusIds'], message: 'Статуси картки повторюються' });
  }
  if (card.cardLabelIds && new Set(card.cardLabelIds).size !== card.cardLabelIds.length) {
    context.addIssue({ code: 'custom', path: ['cardLabelIds'], message: 'Мітки картки повторюються' });
  }
});
const workflowLaneSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/),
  title: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  targetStatus: z.string().trim().max(120).optional().default('')
}).strict();
const workflowCardStatusSchema = z.object({
  id: z.union([z.coerce.number().int().positive(), z.literal(null)]).optional().default(null),
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/)
}).strict();
const workflowSettingsSchema = z.object({
  title: z.string().trim().min(2).max(80),
  description: z.string().trim().max(240).optional().default(''),
  entryLaneKey: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/),
  sourceStatuses: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  cardStatuses: z.array(workflowCardStatusSchema).max(30).optional(),
  cardLabels: z.array(workflowCardStatusSchema).max(30).optional(),
  lanes: z.array(workflowLaneSchema).min(2).max(16),
  access: z.array(z.object({
    userId: z.coerce.number().int().positive(),
    level: z.enum(['none', ...moduleAccessLevels])
  }).strict()).max(500)
}).strict().superRefine((workflow, context) => {
  const laneKeys = workflow.lanes.map((lane) => lane.key);
  if (new Set(laneKeys).size !== laneKeys.length) {
    context.addIssue({ code: 'custom', path: ['lanes'], message: 'Колонки мають повторювані ключі' });
  }
  if (!laneKeys.includes(workflow.entryLaneKey)) {
    context.addIssue({ code: 'custom', path: ['entryLaneKey'], message: 'Вхідної колонки не існує' });
  }
  const statuses = workflow.sourceStatuses.map(normalizedStatus);
  if (new Set(statuses).size !== statuses.length) {
    context.addIssue({ code: 'custom', path: ['sourceStatuses'], message: 'Статуси Обліку повторюються' });
  }
  if (workflow.cardStatuses) {
    const cardStatusNames = workflow.cardStatuses.map((status) => normalizedStatus(status.name));
    if (new Set(cardStatusNames).size !== cardStatusNames.length) {
      context.addIssue({ code: 'custom', path: ['cardStatuses'], message: 'Статуси карток повторюються' });
    }
    const cardStatusIds = workflow.cardStatuses.map((status) => status.id).filter(Boolean);
    if (new Set(cardStatusIds).size !== cardStatusIds.length) {
      context.addIssue({ code: 'custom', path: ['cardStatuses'], message: 'Статус картки зазначено кілька разів' });
    }
  }
  if (workflow.cardLabels) {
    const cardLabelNames = workflow.cardLabels.map((label) => normalizedStatus(label.name));
    if (new Set(cardLabelNames).size !== cardLabelNames.length) {
      context.addIssue({ code: 'custom', path: ['cardLabels'], message: 'Мітки карток повторюються' });
    }
    const cardLabelIds = workflow.cardLabels.map((label) => label.id).filter(Boolean);
    if (new Set(cardLabelIds).size !== cardLabelIds.length) {
      context.addIssue({ code: 'custom', path: ['cardLabels'], message: 'Мітку картки зазначено кілька разів' });
    }
  }
  const userIds = workflow.access.map((grant) => grant.userId);
  if (new Set(userIds).size !== userIds.length) {
    context.addIssue({ code: 'custom', path: ['access'], message: 'Користувача зазначено кілька разів' });
  }
});
const accountingRecordSchema = z.object({
  spreadsheetId: z.string().trim().min(1).max(160),
  sheetId: z.coerce.number().int().min(0),
  rowNumber: z.coerce.number().int().min(2).max(100000),
  sourceName: z.string().trim().min(1).max(120),
  sheetName: z.string().trim().min(1).max(120),
  asset: z.string().trim().min(1).max(120),
  boardIdentifier: z.string().trim().min(1).max(160),
  identifiers: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
  status: z.string().trim().min(1).max(120),
  boardLocation: z.string().trim().max(120).optional().default(''),
  caseLocation: z.string().trim().max(120).optional().default(''),
  sourceComment: z.string().trim().max(45000).optional().default('')
}).strict();
const accountingSyncSchema = z.object({
  records: z.array(accountingRecordSchema).max(10000)
}).strict();
const accountingAckSchema = z.object({
  results: z.array(z.object({
    id: z.coerce.number().int().positive(),
    success: z.boolean(),
    error: z.string().trim().max(500).optional().default('')
  }).strict()).max(200)
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

function replaceUserModuleAccess(userId, modulePermissions) {
  db.prepare('DELETE FROM user_module_access WHERE user_id = ?').run(userId);
  const insert = db.prepare(`
    INSERT INTO user_module_access (user_id, module, access_level) VALUES (?, ?, ?)
  `);
  for (const module of moduleKeys) {
    const level = modulePermissions[module] ?? 'none';
    if (level !== 'none') insert.run(userId, module, level);
  }
}

function accessDevicesExist(access) {
  const existingIds = new Set(statements.listDevices.all().map((device) => device.id));
  return access.every((grant) => existingIds.has(grant.deviceId));
}

function enabledAdminCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1").get().count;
}

function adminUserPayload(row) {
  return {
    ...serializeUser(row),
    primaryAdmin: row.email.toLowerCase() === config.bootstrapAdminEmail
  };
}

function maintenanceDefinition(module) {
  if (!maintenanceModules.includes(module)) return null;
  const board = statements.workflowBoardByModule.get(module);
  if (!board) return null;
  return {
    key: module,
    title: board.title,
    description: board.description,
    entryLaneKey: board.entry_lane_key,
    sourceStatuses: statements.listWorkflowStatuses.all(module).map((row) => row.display_status),
    cardStatuses: statements.listWorkflowCardStatuses.all(module).map((status) => ({
      id: status.id,
      name: status.name,
      color: status.color
    })),
    cardLabels: statements.listWorkflowCardLabels.all(module).map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color
    })),
    lanes: statements.listWorkflowLanes.all(module).map((lane) => ({
      key: lane.lane_key,
      title: lane.title,
      color: lane.color,
      targetStatus: lane.target_status || '',
      system: Boolean(lane.is_system)
    }))
  };
}

function moduleDefinition(module) {
  return maintenanceDefinition(module) ?? staticModuleDefinitions[module] ?? null;
}

function workflowAdminPayload(module) {
  const definition = maintenanceDefinition(module);
  if (!definition) return null;
  const grants = new Map(
    statements.listModuleAccess.all(module).map((row) => [row.user_id, row.access_level])
  );
  return {
    ...definition,
    access: statements.listUsers.all().map((row) => ({
      userId: row.id,
      level: row.email.toLowerCase() === config.bootstrapAdminEmail
        ? 'admin'
        : grants.get(row.id) ?? 'none'
    }))
  };
}

function accountingActionForLane(card, lane) {
  if (!lane) return null;
  if (card.module === 'service' && lane.key === serviceShippedLaneKey) {
    const lostContainer = normalizedStatus(card.source_status) === lostAccountingStatus;
    return {
      actionKind: 'locations',
      sourceLane: lane.key,
      targetStatus: '',
      targetBoardLocation: lostContainer ? null : repairLocation,
      targetCaseLocation: lostContainer ? kyivLocation : repairLocation
    };
  }
  const targetStatus = String(lane.targetStatus || '').trim();
  if (!targetStatus) return null;
  return {
    actionKind: 'status',
    sourceLane: lane.key,
    targetStatus,
    targetBoardLocation: null,
    targetCaseLocation: null
  };
}

function accountingActionMatches(row, action) {
  return row.action_kind === action.actionKind
    && row.source_lane === action.sourceLane
    && row.target_status === action.targetStatus
    && (row.target_board_location ?? null) === action.targetBoardLocation
    && (row.target_case_location ?? null) === action.targetCaseLocation;
}

function enqueueAccountingAction(cardId, action) {
  if (!action) return;
  db.prepare(`
    INSERT OR IGNORE INTO accounting_outbox (
      card_id, action_kind, source_lane, target_status,
      target_board_location, target_case_location
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    cardId,
    action.actionKind,
    action.sourceLane,
    action.targetStatus,
    action.targetBoardLocation,
    action.targetCaseLocation
  );
}

function reconcileWorkflowOutbox(module) {
  const definition = maintenanceDefinition(module);
  if (!definition) return;
  const lanes = new Map(definition.lanes.map((lane) => [lane.key, lane]));
  const cards = db.prepare(`
    SELECT id, module, lane, source_status
    FROM maintenance_cards
    WHERE module = ? AND removed_at IS NULL
  `).all(module);
  const pending = db.prepare(`
    SELECT o.*, c.module, c.lane, c.source_status, c.removed_at
    FROM accounting_outbox o
    JOIN maintenance_cards c ON c.id = o.card_id
    WHERE c.module = ? AND o.state = 'pending'
  `).all(module);
  const pendingByCard = new Map();
  for (const action of pending) {
    const actions = pendingByCard.get(action.card_id) || [];
    actions.push(action);
    pendingByCard.set(action.card_id, actions);
  }
  const cancel = db.prepare(`
    UPDATE accounting_outbox SET state = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND state = 'pending'
  `);
  db.transaction(() => {
    for (const card of cards) {
      const desired = accountingActionForLane(card, lanes.get(card.lane));
      const current = pendingByCard.get(card.id) || [];
      let matching = false;
      for (const action of current) {
        if (desired && !matching && accountingActionMatches(action, desired)) {
          matching = true;
        } else {
          cancel.run(action.id);
        }
      }
      if (desired && !matching) enqueueAccountingAction(card.id, desired);
      pendingByCard.delete(card.id);
    }
    for (const actions of pendingByCard.values()) {
      for (const action of actions) cancel.run(action.id);
    }
  })();
}

function maintenanceCardPayload(row) {
  const events = statements.listMaintenanceEvents.all(row.id, 12).map((event) => ({
    id: event.id,
    actorEmail: event.actor_email,
    action: event.action,
    fromLane: event.from_lane,
    toLane: event.to_lane,
    createdAt: event.created_at
  }));
  const cardStatuses = statements.listMaintenanceCardStatuses.all(row.id).map((status) => ({
    id: status.id,
    name: status.name,
    color: status.color
  }));
  const cardLabels = statements.listMaintenanceCardLabels.all(row.id).map((label) => ({
    id: label.id,
    name: label.name,
    color: label.color
  }));
  return serializeMaintenanceCard(row, events, cardStatuses, cardLabels);
}

function reorderMaintenanceLane(module, cardId, lane, beforeCardId) {
  const rows = db.prepare(`
    SELECT id FROM maintenance_cards
    WHERE module = ? AND lane = ? AND removed_at IS NULL AND id != ?
    ORDER BY sort_order, id
  `).all(module, lane, cardId);
  let targetIndex = rows.length;
  if (beforeCardId) {
    const index = rows.findIndex((row) => row.id === beforeCardId);
    if (index >= 0) targetIndex = index;
  }
  rows.splice(targetIndex, 0, { id: cardId });
  const update = db.prepare(`
    UPDATE maintenance_cards SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  rows.forEach((row, index) => update.run((index + 1) * 100, row.id));
}

function synchronizeAccountingRecords(records) {
  const normalized = records.map((record) => {
    const status = normalizedStatus(record.status);
    const boardLocation = normalizedStatus(record.boardLocation);
    const caseLocation = normalizedStatus(record.caseLocation);
    const sourceModule = statements.workflowModuleByStatus.get(status)?.module ?? null;
    const lostContainer = sourceModule === 'service' && status === lostAccountingStatus;
    const lostContainerInKyiv = lostContainer && caseLocation === kyivLocation;
    const serviceBoardInRepair = sourceModule === 'service'
      && !lostContainer
      && boardLocation === repairLocation
      && caseLocation === repairLocation;
    const completedService = lostContainerInKyiv || serviceBoardInRepair;
    const module = completedService ? null : sourceModule;
    return {
      ...record,
      asset: lostContainer ? 'ТАРА' : record.asset,
      status,
      boardLocation,
      caseLocation,
      module,
      entryLaneKey: module ? statements.workflowBoardByModule.get(module)?.entry_lane_key : null,
      sourceKey: `${record.spreadsheetId}:${record.sheetId}:${record.rowNumber}`
    };
  });
  const uniqueKeys = new Set(normalized.map((record) => record.sourceKey));
  if (uniqueKeys.size !== normalized.length) throw new Error('Синхронізація містить дублікати рядків');

  const insert = db.prepare(`
    INSERT INTO maintenance_cards (
      module, source_key, source_spreadsheet_id, source_sheet_id, source_row_number,
      source_name, source_sheet_name, asset, board_identifier, identifiers_json,
      source_status, source_comment, lane, sort_order, last_seen_at, removed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(module, source_key) DO UPDATE SET
      source_spreadsheet_id = excluded.source_spreadsheet_id,
      source_sheet_id = excluded.source_sheet_id,
      source_row_number = excluded.source_row_number,
      source_name = excluded.source_name,
      source_sheet_name = excluded.source_sheet_name,
      asset = excluded.asset,
      board_identifier = excluded.board_identifier,
      identifiers_json = excluded.identifiers_json,
      source_status = excluded.source_status,
      source_comment = excluded.source_comment,
      lane = CASE WHEN maintenance_cards.removed_at IS NOT NULL THEN excluded.lane ELSE maintenance_cards.lane END,
      sort_order = CASE WHEN maintenance_cards.removed_at IS NOT NULL THEN excluded.sort_order ELSE maintenance_cards.sort_order END,
      last_seen_at = CURRENT_TIMESTAMP,
      removed_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);
  const retire = db.prepare(`
    UPDATE maintenance_cards SET removed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE source_key = ? AND module = ? AND removed_at IS NULL
  `);

  db.transaction(() => {
    normalized.forEach((record, index) => {
      for (const module of ['workshop', 'service']) {
        if (record.module === module) {
          insert.run(
            module,
            record.sourceKey,
            record.spreadsheetId,
            record.sheetId,
            record.rowNumber,
            record.sourceName,
            record.sheetName,
            record.asset,
            record.boardIdentifier,
            JSON.stringify([...new Set(record.identifiers)]),
            record.status,
            record.sourceComment,
            record.entryLaneKey,
            (index + 1) * 100
          );
        } else {
          retire.run(record.sourceKey, module);
        }
      }
    });
  })();

  return statements.pendingAccountingActions.all(200).map((row) => ({
    id: row.id,
    cardId: row.card_id,
    actionKind: row.action_kind,
    targetStatus: row.target_status,
    targetBoardLocation: row.target_board_location,
    targetCaseLocation: row.target_case_location,
    attempts: row.attempts,
    source: {
      spreadsheetId: row.source_spreadsheet_id,
      sheetId: row.source_sheet_id,
      rowNumber: row.source_row_number,
      boardIdentifier: row.board_identifier,
      currentStatus: row.source_status
    }
  }));
}

app.get('/healthz', async () => ({ ok: true, service: 'laba-portal' }));

app.get('/', async (request, reply) => {
  if (!isPortalHost(request.headers)) return proxyHttp(request, reply);
  return reply.sendFile('index.html');
});

app.get('/devices', { preHandler: requireModule('devices') }, async (request, reply) => {
  if (!isPortalHost(request.headers)) return proxyHttp(request, reply);
  return reply.sendFile('devices.html');
});

for (const module of ['workshop', 'service']) {
  app.get(`/${module}`, { preHandler: requireModule(module) }, async (request, reply) => {
    if (!isPortalHost(request.headers)) return proxyHttp(request, reply);
    return reply.sendFile('maintenance.html');
  });
}

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
    modules: moduleAccessMap(request.portalUser),
    baseDomain: config.baseDomain
  };
});

app.get('/api/modules', async (request) => ({
  modules: moduleKeys
    .map((key) => ({ key, ...moduleDefinition(key), access: moduleAccess(request.portalUser, key) }))
    .filter((module) => module.access !== 'none')
}));

app.get('/api/devices', { preHandler: requireModule('devices') }, async (request) => {
  const rows = statements.listDevices.all().filter((device) => device.enabled);
  const grants = userAccessMap(request.portalUser);
  const visible = moduleAccess(request.portalUser, 'devices') === 'admin'
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

app.get('/api/maintenance/:module', async (request, reply) => {
  const module = String(request.params.module || '');
  const definition = maintenanceDefinition(module);
  if (!definition) return reply.code(404).send({ error: 'Розділ не знайдено' });
  const access = moduleAccess(request.portalUser, module);
  if (accessRank(access) < accessRank('viewer')) {
    return reply.code(403).send({ error: 'Немає доступу до цього розділу' });
  }
  const cards = statements.listMaintenanceCards.all(module).map(maintenanceCardPayload);
  const sync = db.prepare(`
    SELECT MAX(last_seen_at) AS last_sync_at FROM maintenance_cards WHERE module = ?
  `).get(module);
  const outbox = db.prepare(`
    SELECT
      SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM accounting_outbox o
    JOIN maintenance_cards c ON c.id = o.card_id
    WHERE c.module = ?
  `).get(module);
  return {
    module,
    title: definition.title,
    description: definition.description,
    lanes: definition.lanes,
    cardStatuses: definition.cardStatuses,
    cardLabels: definition.cardLabels,
    access,
    canEdit: accessRank(access) >= accessRank('operator'),
    cards,
    sync: {
      lastAt: sync.last_sync_at,
      pending: Number(outbox.pending || 0),
      failed: Number(outbox.failed || 0)
    }
  };
});

app.post('/api/maintenance/:module/cards/:id/move', {
  preHandler: guardWrite,
  config: { rateLimit: { max: 120, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const module = String(request.params.module || '');
  const definition = maintenanceDefinition(module);
  if (!definition) return reply.code(404).send({ error: 'Розділ не знайдено' });
  if (accessRank(moduleAccess(request.portalUser, module)) < accessRank('operator')) {
    return reply.code(403).send({ error: 'Потрібні права виконавця' });
  }
  const card = statements.maintenanceCardById.get(Number(request.params.id));
  if (!card || card.module !== module || card.removed_at) {
    return reply.code(404).send({ error: 'Картку не знайдено' });
  }
  const body = parseOrReply(maintenanceMoveSchema, request.body, reply);
  if (!body) return;
  const targetLane = definition.lanes.find((lane) => lane.key === body.lane);
  if (!targetLane) return reply.code(400).send({ error: 'Невідома колонка' });
  if (body.beforeCardId) {
    const before = statements.maintenanceCardById.get(body.beforeCardId);
    if (!before || before.module !== module || before.lane !== body.lane || before.removed_at) {
      return reply.code(400).send({ error: 'Некоректне місце картки' });
    }
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE maintenance_cards SET lane = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(body.lane, card.id);
    reorderMaintenanceLane(module, card.id, body.lane, body.beforeCardId);
    if (card.lane !== body.lane) {
      db.prepare(`
        INSERT INTO maintenance_events (card_id, actor_email, action, from_lane, to_lane)
        VALUES (?, ?, 'lane.change', ?, ?)
      `).run(card.id, request.portalUser.email, card.lane, body.lane);
    }
    if (card.lane !== body.lane) {
      db.prepare(`
        UPDATE accounting_outbox SET state = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE card_id = ? AND state = 'pending'
      `).run(card.id);
    }
    if (card.lane !== body.lane) {
      enqueueAccountingAction(card.id, accountingActionForLane(card, targetLane));
    }
  })();
  audit(request.portalUser.email, 'maintenance.move', 'maintenance-card', card.id, {
    module, from: card.lane, to: body.lane
  });
  return maintenanceCardPayload(statements.maintenanceCardById.get(card.id));
});

app.patch('/api/maintenance/:module/cards/:id', {
  preHandler: guardWrite,
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const module = String(request.params.module || '');
  const definition = maintenanceDefinition(module);
  if (!definition) return reply.code(404).send({ error: 'Розділ не знайдено' });
  if (accessRank(moduleAccess(request.portalUser, module)) < accessRank('operator')) {
    return reply.code(403).send({ error: 'Потрібні права виконавця' });
  }
  const card = statements.maintenanceCardById.get(Number(request.params.id));
  if (!card || card.module !== module || card.removed_at) {
    return reply.code(404).send({ error: 'Картку не знайдено' });
  }
  const body = parseOrReply(maintenanceEditSchema, request.body, reply);
  if (!body) return;
  if (module !== 'service' && body.reportNumber !== undefined) {
    return reply.code(400).send({ error: 'Номер рапорта доступний лише в Сервісі' });
  }
  const previousStatusIds = statements.listMaintenanceCardStatuses.all(card.id).map((status) => status.id);
  const nextStatusIds = body.cardStatusIds ?? previousStatusIds;
  const allowedStatusIds = new Set(definition.cardStatuses.map((status) => status.id));
  if (!nextStatusIds.every((statusId) => allowedStatusIds.has(statusId))) {
    return reply.code(400).send({ error: 'Один зі статусів не належить цій дошці' });
  }
  const previousLabelIds = statements.listMaintenanceCardLabels.all(card.id).map((label) => label.id);
  const nextLabelIds = body.cardLabelIds ?? previousLabelIds;
  const allowedLabelIds = new Set(definition.cardLabels.map((label) => label.id));
  if (!nextLabelIds.every((labelId) => allowedLabelIds.has(labelId))) {
    return reply.code(400).send({ error: 'Одна з міток не належить цій дошці' });
  }
  const notesChanged = body.notes !== card.notes;
  const nextReportNumber = module === 'service' ? body.reportNumber ?? card.report_number : card.report_number;
  const reportNumberChanged = nextReportNumber !== card.report_number;
  const statusesChanged = previousStatusIds.length !== nextStatusIds.length
    || previousStatusIds.some((statusId) => !nextStatusIds.includes(statusId));
  const labelsChanged = previousLabelIds.length !== nextLabelIds.length
    || previousLabelIds.some((labelId) => !nextLabelIds.includes(labelId));
  db.transaction(() => {
    db.prepare(`
      UPDATE maintenance_cards
      SET notes = ?, report_number = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(body.notes, nextReportNumber, card.id);
    if (statusesChanged) {
      db.prepare('DELETE FROM maintenance_card_status_assignments WHERE card_id = ?').run(card.id);
      const assign = db.prepare(`
        INSERT INTO maintenance_card_status_assignments (card_id, status_id) VALUES (?, ?)
      `);
      nextStatusIds.forEach((statusId) => assign.run(card.id, statusId));
    }
    if (labelsChanged) {
      db.prepare('DELETE FROM maintenance_card_label_assignments WHERE card_id = ?').run(card.id);
      const assign = db.prepare(`
        INSERT INTO maintenance_card_label_assignments (card_id, label_id) VALUES (?, ?)
      `);
      nextLabelIds.forEach((labelId) => assign.run(card.id, labelId));
    }
    if (notesChanged) {
      db.prepare(`
        INSERT INTO maintenance_events (card_id, actor_email, action) VALUES (?, ?, 'notes.update')
      `).run(card.id, request.portalUser.email);
    }
    if (reportNumberChanged) {
      db.prepare(`
        INSERT INTO maintenance_events (card_id, actor_email, action) VALUES (?, ?, 'report-number.update')
      `).run(card.id, request.portalUser.email);
    }
  })();
  audit(request.portalUser.email, 'maintenance.update', 'maintenance-card', card.id, {
    module,
    notesChanged,
    reportNumberChanged,
    cardStatusIds: nextStatusIds,
    cardLabelIds: nextLabelIds
  });
  return maintenanceCardPayload(statements.maintenanceCardById.get(card.id));
});

app.post('/api/internal/accounting/sync', {
  preHandler: requireAccountingSync,
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(accountingSyncSchema, request.body, reply);
  if (!body) return;
  try {
    const actions = synchronizeAccountingRecords(body.records);
    return { ok: true, received: body.records.length, actions };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});

app.post('/api/internal/accounting/ack', {
  preHandler: requireAccountingSync,
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const body = parseOrReply(accountingAckSchema, request.body, reply);
  if (!body) return;
  const find = db.prepare(`
    SELECT o.*, c.id AS maintenance_card_id
    FROM accounting_outbox o
    JOIN maintenance_cards c ON c.id = o.card_id
    WHERE o.id = ? AND o.state = 'pending'
  `);
  const applied = db.prepare(`
    UPDATE accounting_outbox
    SET state = 'applied', attempts = attempts + 1, last_error = NULL,
      updated_at = CURRENT_TIMESTAMP, applied_at = CURRENT_TIMESTAMP
    WHERE id = ? AND state = 'pending'
  `);
  const failed = db.prepare(`
    UPDATE accounting_outbox
    SET state = CASE WHEN attempts + 1 >= 10 THEN 'failed' ELSE 'pending' END,
      attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND state = 'pending'
  `);
  const retireAppliedCard = db.prepare(`
    UPDATE maintenance_cards
    SET removed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND removed_at IS NULL AND lane = ?
  `);
  let accepted = 0;
  db.transaction(() => {
    for (const result of body.results) {
      const action = find.get(result.id);
      if (!action) continue;
      if (result.success) {
        applied.run(result.id);
        retireAppliedCard.run(action.maintenance_card_id, action.source_lane);
      } else {
        failed.run(result.error || 'Помилка синхронізації', result.id);
      }
      accepted += 1;
    }
  })();
  return { ok: true, accepted };
});

app.get('/api/admin/workflows', { preHandler: requireAdmin }, async () => ({
  boards: maintenanceModules.map(workflowAdminPayload),
  users: statements.listUsers.all().map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
    primaryAdmin: row.email.toLowerCase() === config.bootstrapAdminEmail
  }))
}));

app.patch('/api/admin/workflows/:module', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const module = String(request.params.module || '');
  const current = maintenanceDefinition(module);
  if (!current) return reply.code(404).send({ error: 'Дошку не знайдено' });
  const body = parseOrReply(workflowSettingsSchema, request.body, reply);
  if (!body) return;

  const existingLanes = statements.listWorkflowLanes.all(module);
  const incomingKeys = new Set(body.lanes.map((lane) => lane.key));
  const missingSystemLane = existingLanes.find((lane) => lane.is_system && !incomingKeys.has(lane.lane_key));
  if (missingSystemLane) {
    return reply.code(409).send({ error: `Системну колонку «${missingSystemLane.title}» не можна видалити` });
  }
  const removedCustomLanes = existingLanes.filter((lane) => !lane.is_system && !incomingKeys.has(lane.lane_key));
  for (const lane of removedCustomLanes) {
    const cards = db.prepare(`
      SELECT COUNT(*) AS count FROM maintenance_cards
      WHERE module = ? AND lane = ? AND removed_at IS NULL
    `).get(module, lane.lane_key).count;
    if (cards > 0) {
      return reply.code(409).send({
        error: `Спочатку перенесіть картки з колонки «${lane.title}»`
      });
    }
  }

  const normalizedStatuses = body.sourceStatuses.map(normalizedStatus);
  const cardStatuses = body.cardStatuses ?? current.cardStatuses;
  const cardLabels = body.cardLabels ?? current.cardLabels;
  const conflictingStatus = normalizedStatuses.find((status) => {
    const assigned = statements.workflowModuleByStatus.get(status);
    return assigned && assigned.module !== module;
  });
  if (conflictingStatus) {
    const other = maintenanceDefinition(statements.workflowModuleByStatus.get(conflictingStatus).module);
    return reply.code(409).send({
      error: `Статус «${conflictingStatus}» уже використовується дошкою «${other?.title || 'Інша дошка'}»`
    });
  }

  const users = statements.listUsers.all();
  const userIds = new Set(users.map((user) => user.id));
  if (!body.access.every((grant) => userIds.has(grant.userId))) {
    return reply.code(400).send({ error: 'Один із користувачів більше не існує' });
  }
  const bootstrapAdmin = users.find((user) => user.email.toLowerCase() === config.bootstrapAdminEmail);
  const existingCardStatuses = statements.listWorkflowCardStatuses.all(module);
  const existingCardStatusIds = new Set(existingCardStatuses.map((status) => status.id));
  if (!cardStatuses.every((status) => status.id === null || existingCardStatusIds.has(status.id))) {
    return reply.code(400).send({ error: 'Один зі статусів картки більше не існує' });
  }
  const existingCardLabels = statements.listWorkflowCardLabels.all(module);
  const existingCardLabelIds = new Set(existingCardLabels.map((label) => label.id));
  if (!cardLabels.every((label) => label.id === null || existingCardLabelIds.has(label.id))) {
    return reply.code(400).send({ error: 'Одна з міток картки більше не існує' });
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE workflow_boards
      SET title = ?, description = ?, entry_lane_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE module = ?
    `).run(body.title, body.description, body.entryLaneKey, module);

    const upsertLane = db.prepare(`
      INSERT INTO workflow_lanes
        (module, lane_key, title, color, sort_order, target_status, is_system)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(module, lane_key) DO UPDATE SET
        title = excluded.title,
        color = excluded.color,
        sort_order = excluded.sort_order,
        target_status = excluded.target_status,
        updated_at = CURRENT_TIMESTAMP
    `);
    body.lanes.forEach((lane, index) => upsertLane.run(
      module,
      lane.key,
      lane.title,
      lane.color.toLowerCase(),
      (index + 1) * 10,
      module === 'service' && lane.key === serviceShippedLaneKey
        ? null
        : lane.targetStatus ? normalizedStatus(lane.targetStatus) : null
    ));
    const deleteLane = db.prepare('DELETE FROM workflow_lanes WHERE module = ? AND lane_key = ? AND is_system = 0');
    removedCustomLanes.forEach((lane) => deleteLane.run(module, lane.lane_key));

    db.prepare('DELETE FROM workflow_source_statuses WHERE module = ?').run(module);
    const insertStatus = db.prepare(`
      INSERT INTO workflow_source_statuses (normalized_status, display_status, module)
      VALUES (?, ?, ?)
    `);
    normalizedStatuses.forEach((status) => insertStatus.run(status, status, module));

    const retainedCardStatusIds = new Set(cardStatuses.map((status) => status.id).filter(Boolean));
    const deleteCardStatus = db.prepare('DELETE FROM workflow_card_statuses WHERE module = ? AND id = ?');
    existingCardStatuses
      .filter((status) => !retainedCardStatusIds.has(status.id))
      .forEach((status) => deleteCardStatus.run(module, status.id));
    const reserveCardStatusName = db.prepare(`
      UPDATE workflow_card_statuses
      SET normalized_name = '__LABA_TMP_' || id || '_' || hex(randomblob(8))
      WHERE module = ? AND id = ?
    `);
    existingCardStatuses
      .filter((status) => retainedCardStatusIds.has(status.id))
      .forEach((status) => reserveCardStatusName.run(module, status.id));
    const updateCardStatus = db.prepare(`
      UPDATE workflow_card_statuses
      SET name = ?, normalized_name = ?, color = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE module = ? AND id = ?
    `);
    const insertCardStatus = db.prepare(`
      INSERT INTO workflow_card_statuses (module, name, normalized_name, color, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    cardStatuses.forEach((status, index) => {
      const name = status.name.trim().replace(/\s+/g, ' ');
      const normalizedName = normalizedStatus(name);
      const color = status.color.toLowerCase();
      if (status.id) updateCardStatus.run(name, normalizedName, color, (index + 1) * 10, module, status.id);
      else insertCardStatus.run(module, name, normalizedName, color, (index + 1) * 10);
    });

    const retainedCardLabelIds = new Set(cardLabels.map((label) => label.id).filter(Boolean));
    const deleteCardLabel = db.prepare('DELETE FROM workflow_card_labels WHERE module = ? AND id = ?');
    existingCardLabels
      .filter((label) => !retainedCardLabelIds.has(label.id))
      .forEach((label) => deleteCardLabel.run(module, label.id));
    const reserveCardLabelName = db.prepare(`
      UPDATE workflow_card_labels
      SET normalized_name = '__LABA_TMP_' || id || '_' || hex(randomblob(8))
      WHERE module = ? AND id = ?
    `);
    existingCardLabels
      .filter((label) => retainedCardLabelIds.has(label.id))
      .forEach((label) => reserveCardLabelName.run(module, label.id));
    const updateCardLabel = db.prepare(`
      UPDATE workflow_card_labels
      SET name = ?, normalized_name = ?, color = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE module = ? AND id = ?
    `);
    const insertCardLabel = db.prepare(`
      INSERT INTO workflow_card_labels (module, name, normalized_name, color, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    cardLabels.forEach((label, index) => {
      const name = label.name.trim().replace(/\s+/g, ' ');
      const normalizedName = normalizedStatus(name);
      const color = label.color.toLowerCase();
      if (label.id) updateCardLabel.run(name, normalizedName, color, (index + 1) * 10, module, label.id);
      else insertCardLabel.run(module, name, normalizedName, color, (index + 1) * 10);
    });

    if (bootstrapAdmin) {
      db.prepare('DELETE FROM user_module_access WHERE module = ? AND user_id != ?')
        .run(module, bootstrapAdmin.id);
    } else {
      db.prepare('DELETE FROM user_module_access WHERE module = ?').run(module);
    }
    const insertAccess = db.prepare(`
      INSERT INTO user_module_access (user_id, module, access_level)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, module) DO UPDATE SET access_level = excluded.access_level
    `);
    for (const grant of body.access) {
      if (grant.userId !== bootstrapAdmin?.id && grant.level !== 'none') {
        insertAccess.run(grant.userId, module, grant.level);
      }
    }
    if (bootstrapAdmin) insertAccess.run(bootstrapAdmin.id, module, 'admin');

    reconcileWorkflowOutbox(module);
  })();

  audit(request.portalUser.email, 'workflow.update', 'workflow-board', module, {
    title: body.title,
    entryLaneKey: body.entryLaneKey,
    laneKeys: body.lanes.map((lane) => lane.key),
    sourceStatuses: normalizedStatuses,
    cardStatuses: cardStatuses.map((status) => status.name),
    cardLabels: cardLabels.map((label) => label.name),
    accessCount: body.access.filter((grant) => grant.level !== 'none').length
  });
  return workflowAdminPayload(module);
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
  statements.listUsers.all().map(adminUserPayload)
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
      replaceUserModuleAccess(Number(result.lastInsertRowid), body.moduleAccess);
      audit(request.portalUser.email, 'user.create', 'user', result.lastInsertRowid, {
        email: body.email,
        role: body.role
      });
    })();
    return reply.code(201).send(adminUserPayload(
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
  const isBootstrapAdmin = existing.email.toLowerCase() === config.bootstrapAdminEmail;
  if (isBootstrapAdmin && (
    body.email !== config.bootstrapAdminEmail
    || body.role !== 'admin'
    || !body.enabled
    || moduleKeys.some((module) => body.moduleAccess[module] !== 'admin')
  )) {
    return reply.code(409).send({ error: 'Головний адміністратор повинен мати повний доступ до всіх розділів' });
  }
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
      replaceUserModuleAccess(userId, body.moduleAccess);
    })();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Користувач із таким e-mail уже існує' });
    throw error;
  }
  audit(request.portalUser.email, 'user.update', 'user', userId, { email: body.email, role: body.role });
  return adminUserPayload(statements.listUsers.all().find((row) => row.id === userId));
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
