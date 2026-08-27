import crypto from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.mjs';

let cloudflareKeys;

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export async function authenticatedEmail(headers) {
  if (config.authMode === 'development') {
    return normalizeEmail(headers['x-dev-user-email'] ?? config.devUserEmail);
  }

  const assertion = headers['cf-access-jwt-assertion'];
  if (!assertion) throw new Error('Cloudflare Access assertion is missing');

  cloudflareKeys ??= createRemoteJWKSet(
    new URL(`https://${config.cfAccessTeamDomain}/cdn-cgi/access/certs`)
  );

  const { payload } = await jwtVerify(assertion, cloudflareKeys, {
    audience: config.cfAccessAudience,
    issuer: `https://${config.cfAccessTeamDomain}`,
    algorithms: ['RS256']
  });

  const email = normalizeEmail(payload.email);
  if (!email) throw new Error('Cloudflare Access identity has no email');
  return email;
}

function encryptionKey() {
  if (config.deviceSecretKey) {
    const decoded = Buffer.from(config.deviceSecretKey, 'base64');
    if (decoded.length !== 32) throw new Error('DEVICE_SECRET_KEY must decode to exactly 32 bytes');
    return decoded;
  }

  return crypto.createHash('sha256').update(config.sessionSecret).digest();
}

export function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(value) {
  if (!value) return '';
  const [ivEncoded, tagEncoded, dataEncoded] = value.split('.');
  if (!ivEncoded || !tagEncoded || !dataEncoded) throw new Error('Stored secret is malformed');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivEncoded, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataEncoded, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

export function isAllowedDeviceHost(host) {
  try {
    const address = ipaddr.parse(host);
    if (address.kind() !== 'ipv4') return false;
    return config.allowedSubnets.some((cidr) => {
      const [range, prefix] = ipaddr.parseCIDR(cidr);
      return range.kind() === 'ipv4' && address.match(range, prefix);
    });
  } catch {
    return false;
  }
}

export function safeSlug(value) {
  // The DNS label also contains the five-character "-laba" suffix (63 chars total max).
  return /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(String(value ?? ''));
}

export function requireSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const originHost = new URL(origin).hostname.toLowerCase();
  const requestHost = String(request.headers.host ?? '').split(':')[0].toLowerCase();
  if (originHost !== requestHost) throw new Error('Cross-origin write rejected');
}

export function accessRank(level) {
  return { none: 0, viewer: 1, operator: 2, admin: 3 }[level] ?? 0;
}
