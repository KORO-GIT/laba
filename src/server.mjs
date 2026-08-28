import httpProxy from 'http-proxy';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
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
  safeSlug
} from './security.mjs';

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
      imgSrc: ["'self'", 'data:'],
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
  if (!request.url.startsWith('/assets/')) reply.header('Cache-Control', 'no-store');
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

function userAccessMap(user) {
  if (user.role === 'admin') return null;
  return new Map(
    statements.accessForUser.all(user.id).map((row) => [row.device_id, row.access_level])
  );
}

function effectiveAccess(user, deviceId) {
  if (user.role === 'admin') return 'admin';
  const grant = statements.accessForUserAndDevice.get(user.id, deviceId)?.access_level ?? 'none';
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
    const error = new Error('Пользователь не имеет доступа к порталу');
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
    return reply.code(error.statusCode ?? 401).send({ error: error.message ?? 'Unauthorized' });
  }
  // Device hosts must take priority over portal routes such as /assets/*.
  // Printer and camera UIs commonly use those same top-level paths.
  if (subdomainSlug(request.headers)) return proxyHttp(request, reply);
});

function requireAdmin(request, reply, done) {
  if (request.portalUser?.role !== 'admin') {
    reply.code(403).send({ error: 'Требуются права администратора' });
    return;
  }
  done();
}

function guardWrite(request, reply, done) {
  try {
    requireSameOrigin(request);
    if (request.headers['x-portal-request'] !== '1') throw new Error('Missing request marker');
    done();
  } catch {
    reply.code(403).send({ error: 'Запрос отклонён защитой CSRF' });
  }
}

function parseOrReply(schema, value, reply) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    reply.code(400).send({ error: 'Некорректные данные', fields: parsed.error.flatten().fieldErrors });
    return null;
  }
  return parsed.data;
}

function validateDeviceNetwork(device, reply) {
  if (!isAllowedDeviceHost(device.host)) {
    reply.code(400).send({
      error: `Адрес должен находиться в разрешённой домашней сети: ${config.allowedSubnets.join(', ')}`
    });
    return false;
  }
  return true;
}

const deviceSchema = z.object({
  slug: z.string().trim().toLowerCase().refine(safeSlug, 'Недопустимый идентификатор адреса'),
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['printer', 'camera']),
  driver: z.enum(['moonraker', 'octoprint', 'http', 'rtsp']),
  host: z.string().trim(),
  protocol: z.enum(['http', 'https', 'rtsp']),
  uiPort: z.coerce.number().int().min(1).max(65535),
  apiPort: z.union([z.coerce.number().int().min(1).max(65535), z.literal(null)]).optional(),
  secret: z.string().max(4096).optional(),
  keepSecret: z.boolean().optional().default(true),
  notes: z.string().trim().max(500).optional().default(''),
  enabled: z.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(-10000).max(10000).optional().default(0)
}).superRefine((device, context) => {
  if (device.driver === 'rtsp' && device.protocol !== 'rtsp') {
    context.addIssue({ code: 'custom', path: ['protocol'], message: 'Для RTSP выберите протокол RTSP' });
  }
  if (device.driver !== 'rtsp' && device.protocol === 'rtsp') {
    context.addIssue({ code: 'custom', path: ['protocol'], message: 'RTSP доступен только для RTSP-интеграции' });
  }
  if (device.driver === 'moonraker' && !device.apiPort) {
    context.addIssue({ code: 'custom', path: ['apiPort'], message: 'Для Moonraker нужен API-порт' });
  }
});

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
    context.addIssue({ code: 'custom', path: ['access'], message: 'Устройство указано несколько раз' });
  }
});

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
  if (request.portalUser.role !== 'admin') return reply.code(403).send({ error: 'Forbidden' });
  return reply.sendFile('admin.html');
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
    : rows.filter((device) => grants.has(device.id));

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
  if (!body || !validateDeviceNetwork(body, reply)) return;
  try {
    const result = db.prepare(`
      INSERT INTO devices
        (slug, name, kind, driver, host, protocol, ui_port, api_port, secret_enc, notes, enabled, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.slug, body.name, body.kind, body.driver, body.host, body.protocol,
      body.uiPort, body.apiPort ?? null, secretPayload(body.secret), body.notes,
      body.enabled ? 1 : 0, body.sortOrder
    );
    audit(request.portalUser.email, 'device.create', 'device', result.lastInsertRowid, { slug: body.slug });
    return reply.code(201).send(serializeDevice(statements.deviceById.get(result.lastInsertRowid), true));
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Такой поддомен уже существует' });
    throw error;
  }
});

app.patch('/api/admin/devices/:id', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const existing = statements.deviceById.get(Number(request.params.id));
  if (!existing) return reply.code(404).send({ error: 'Устройство не найдено' });
  const body = parseOrReply(deviceSchema, request.body, reply);
  if (!body || !validateDeviceNetwork(body, reply)) return;
  const encrypted = body.keepSecret && !body.secret ? existing.secret_enc : secretPayload(body.secret);
  try {
    db.prepare(`
      UPDATE devices SET
        slug = ?, name = ?, kind = ?, driver = ?, host = ?, protocol = ?, ui_port = ?,
        api_port = ?, secret_enc = ?, notes = ?, enabled = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      body.slug, body.name, body.kind, body.driver, body.host, body.protocol, body.uiPort,
      body.apiPort ?? null, encrypted, body.notes, body.enabled ? 1 : 0, body.sortOrder, existing.id
    );
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Такой поддомен уже существует' });
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
  if (!device) return reply.code(404).send({ error: 'Устройство не найдено' });
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
  if (!accessDevicesExist(body.access)) return reply.code(400).send({ error: 'Одно из устройств не существует' });
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
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Пользователь уже существует' });
    throw error;
  }
});

app.patch('/api/admin/users/:id', {
  preHandler: [requireAdmin, guardWrite],
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const userId = Number(request.params.id);
  const existing = statements.userById.get(userId);
  if (!existing) return reply.code(404).send({ error: 'Пользователь не найден' });
  const body = parseOrReply(userSchema, request.body, reply);
  if (!body) return;
  if (!accessDevicesExist(body.access)) return reply.code(400).send({ error: 'Одно из устройств не существует' });
  const removesAdmin = existing.role === 'admin' && existing.enabled && (body.role !== 'admin' || !body.enabled);
  if (removesAdmin && enabledAdminCount() <= 1) {
    return reply.code(409).send({ error: 'Нельзя отключить последнего администратора' });
  }
  if (existing.id === request.portalUser.id && !body.enabled) {
    return reply.code(409).send({ error: 'Нельзя отключить собственную учётную запись' });
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
    if (String(error.message).includes('UNIQUE')) return reply.code(409).send({ error: 'Пользователь с таким e-mail уже существует' });
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

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true });

proxy.on('proxyReq', (proxyRequest, request) => {
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
});

proxy.on('error', (error, request, response) => {
  app.log.warn({ err: error, host: request.headers.host }, 'Device proxy error');
  if (response?.writeHead && !response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  if (response?.end) response.end('Устройство временно недоступно');
  else response?.destroy?.();
});

function proxyTarget(device) {
  if (device.protocol === 'rtsp') return null;
  return `${device.protocol}://${device.host}:${device.ui_port}`;
}

async function proxyHttp(request, reply) {
  const slug = subdomainSlug(request.headers);
  if (!slug) return reply.code(404).send({ error: 'Unknown portal host' });
  const device = statements.deviceBySlug.get(slug);
  if (!device || !device.enabled) return reply.code(404).send({ error: 'Устройство не найдено' });
  if (!canOpenDevice(request.portalUser, device)) return reply.code(403).send({ error: 'Нет доступа к устройству' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    && request.headers['sec-fetch-site'] === 'cross-site') {
    return reply.code(403).send({ error: 'Межсайтовый запрос к устройству отклонён' });
  }
  const target = proxyTarget(device);
  if (!target) return reply.code(503).send({ error: 'Видеошлюз камеры ещё не настроен' });
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
    return reply.code(404).send({ error: 'Not found' });
  }
});

app.server.on('upgrade', async (request, socket, head) => {
  try {
    const slug = subdomainSlug(request.headers);
    if (!slug) throw new Error('Unknown host');
    const user = await resolveUser(request.headers);
    const device = statements.deviceBySlug.get(slug);
    if (!device || !device.enabled || !canOpenDevice(user, device)) throw new Error('Forbidden');
    const target = proxyTarget(device);
    if (!target) throw new Error('No browser stream configured');
    request.portalDevice = device;
    proxy.ws(request, socket, head, { target });
  } catch {
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
  reply.code(status).send({ error: status === 500 ? 'Внутренняя ошибка сервиса' : error.message });
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
