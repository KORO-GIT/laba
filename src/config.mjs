import path from 'node:path';

const cwd = process.cwd();

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8080),
  baseDomain: (process.env.BASE_DOMAIN ?? 'laba.zpseapil.club').toLowerCase(),
  deviceHostSuffix: (process.env.DEVICE_HOST_SUFFIX ?? '-laba.zpseapil.club').toLowerCase(),
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
  desktopGatewayUrl: process.env.DESKTOP_GATEWAY_URL ?? 'http://127.0.0.1:6080',
  audioAgentUrl: (process.env.AUDIO_AGENT_URL ?? '').replace(/\/$/, ''),
  audioAgentToken: process.env.AUDIO_AGENT_TOKEN ?? '',
  starlinkAgentUrl: (process.env.STARLINK_AGENT_URL ?? '').replace(/\/$/, ''),
  starlinkAgentToken: process.env.STARLINK_AGENT_TOKEN ?? '',
  allowedSubnets: (process.env.ALLOWED_DEVICE_SUBNETS ?? '192.168.0.0/24')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  dbPath: process.env.DB_PATH ?? path.join(cwd, 'data', 'portal.db'),
  publicDir: path.join(cwd, 'public'),
  novncDir: path.join(cwd, 'node_modules', '@novnc', 'novnc')
};

export function validateConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }

  if (!['development', 'cloudflare'].includes(config.authMode)) {
    throw new Error('AUTH_MODE must be development or cloudflare');
  }

  if (!/^-[a-z0-9.-]+$/.test(config.deviceHostSuffix)) {
    throw new Error('DEVICE_HOST_SUFFIX must start with a hyphen and contain only DNS characters');
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
    if (!config.audioAgentUrl) missing.push('AUDIO_AGENT_URL');
    if (config.audioAgentToken.length < 32) missing.push('AUDIO_AGENT_TOKEN');
    if (!config.starlinkAgentUrl) missing.push('STARLINK_AGENT_URL');
    if (config.starlinkAgentToken.length < 32) missing.push('STARLINK_AGENT_TOKEN');
    if (missing.length) throw new Error(`Missing production settings: ${missing.join(', ')}`);
    const decoded = Buffer.from(config.deviceSecretKey, 'base64');
    if (decoded.length !== 32) throw new Error('DEVICE_SECRET_KEY must decode to exactly 32 bytes');
  }

  if (config.audioAgentUrl) {
    const url = new URL(config.audioAgentUrl);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('AUDIO_AGENT_URL must be an HTTP origin without credentials, path, query, or fragment');
    }
  }

  if (config.starlinkAgentUrl) {
    const url = new URL(config.starlinkAgentUrl);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('STARLINK_AGENT_URL must be an HTTP origin without credentials, path, query, or fragment');
    }
  }

  const desktopGatewayUrl = new URL(config.desktopGatewayUrl);
  if (
    desktopGatewayUrl.protocol !== 'http:'
    || desktopGatewayUrl.hostname !== '127.0.0.1'
    || desktopGatewayUrl.username
    || desktopGatewayUrl.password
    || desktopGatewayUrl.search
    || desktopGatewayUrl.hash
    || desktopGatewayUrl.pathname !== '/'
  ) {
    throw new Error('DESKTOP_GATEWAY_URL must be an HTTP origin on 127.0.0.1 without credentials, path, query, or fragment');
  }
}
