import fs from 'node:fs';

const tokenPath = process.argv[2];
if (!tokenPath) throw new Error('Token file path is required');

const token = fs.readFileSync(tokenPath, 'utf8').trim();
if (token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Audio agent token is invalid');

const envPath = '/opt/laba/.env';
const current = fs.readFileSync(envPath, 'utf8');
const values = new Map([
  ['AUDIO_AGENT_URL', 'http://100.69.168.10:1985'],
  ['AUDIO_AGENT_TOKEN', token]
]);
const seen = new Set();
const lines = current.split(/\r?\n/).map((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (!match || !values.has(match[1])) return line;
  seen.add(match[1]);
  return `${match[1]}=${values.get(match[1])}`;
});
for (const [key, value] of values) {
  if (!seen.has(key)) lines.push(`${key}=${value}`);
}
fs.writeFileSync(envPath, `${lines.filter((line, index, all) => line || index < all.length - 1).join('\n')}\n`, {
  encoding: 'utf8',
  mode: 0o600
});
fs.chmodSync(envPath, 0o600);
console.log('Configured AUDIO_AGENT_URL and AUDIO_AGENT_TOKEN in /opt/laba/.env');
