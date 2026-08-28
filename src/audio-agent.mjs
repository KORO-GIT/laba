import { config } from './config.mjs';

export class AudioAgentError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function audioAgentRequest(path, { method = 'GET', body } = {}) {
  if (!config.audioAgentUrl || !config.audioAgentToken) {
    throw new AudioAgentError('Аудіоагент Raspberry Pi не налаштовано', 503);
  }
  if (!/^\/v1\/[a-z0-9/:.-]+$/i.test(path)) {
    throw new AudioAgentError('Некоректний шлях аудіоагента', 500);
  }

  let response;
  try {
    response = await fetch(`${config.audioAgentUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.audioAgentToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45_000)
    });
  } catch (error) {
    throw new AudioAgentError(
      error?.name === 'TimeoutError'
        ? 'Аудіоагент Raspberry Pi не відповів вчасно'
        : 'Немає з’єднання з аудіоагентом Raspberry Pi'
    );
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new AudioAgentError(payload.error || `Аудіоагент повернув помилку ${response.status}`, statusCode);
  }
  return payload;
}
