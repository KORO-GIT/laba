import path from 'node:path';

const cwd = process.cwd();

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8080),
  baseDomain: (process.env.BASE_DOMAIN ?? 'laba.zpseapil.club').toLowerCase(),
  authMode: process.env.AUTH_MODE ?? 'development',
  bootstrapAdminEmail: (process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@local.test').toLowerCase(),
  devUserEmail: (process.env.DEV_USER_EMAIL ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@local.test').toLowerCase(),
  cfAccessTeamDomain: (process.env.CF_ACCESS_TEAM_DOMAIN ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, ''),
  cfAccessAudience: (process.env.CF_ACCESS_AUD ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET ?? 'development-only-session-secret-change-me',
  deviceSecretKey: process.env.DEVICE_SECRET_KEY ?? '',
  allowedSubnets: (process.env.ALLOWED_DEVICE_SUBNETS ?? '192.168.0.0/24')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  dbPath: process.env.DB_PATH ?? path.join(cwd, 'data', 'portal.db'),
  publicDir: path.join(cwd, 'public')
};

export function validateConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }

  if (!['development', 'cloudflare'].includes(config.authMode)) {
    throw new Error('AUTH_MODE must be development or cloudflare');
  }

  if (config.nodeEnv === 'production' && config.authMode !== 'cloudflare') {
    throw new Error('Production requires AUTH_MODE=cloudflare');
  }

  if (config.authMode === 'cloudflare') {
    const missing = [];
    if (!config.cfAccessTeamDomain) missing.push('CF_ACCESS_TEAM_DOMAIN');
    if (!config.cfAccessAudience.length) missing.push('CF_ACCESS_AUD');
    if (config.sessionSecret.length < 32) missing.push('SESSION_SECRET');
    if (!config.deviceSecretKey) missing.push('DEVICE_SECRET_KEY');
    if (missing.length) throw new Error(`Missing production settings: ${missing.join(', ')}`);
    const decoded = Buffer.from(config.deviceSecretKey, 'base64');
    if (decoded.length !== 32) throw new Error('DEVICE_SECRET_KEY must decode to exactly 32 bytes');
  }
}
