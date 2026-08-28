import { config } from './config.mjs';

export class StarlinkAgentError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function starlinkAgentRequest(path, { method = 'GET', body, timeout = 30_000 } = {}) {
  if (!config.starlinkAgentUrl || !config.starlinkAgentToken) {
    throw new StarlinkAgentError('Starlink-агент Raspberry Pi не налаштовано', 503);
  }
  if (!/^\/v1\/[a-z0-9/.-]+$/i.test(path)) {
    throw new StarlinkAgentError('Некоректний шлях Starlink-агента', 500);
  }

  let response;
  try {
    response = await fetch(`${config.starlinkAgentUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.starlinkAgentToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    throw new StarlinkAgentError(
      error?.name === 'TimeoutError'
        ? 'Starlink-агент Raspberry Pi не відповів вчасно'
        : 'Немає з’єднання зі Starlink-агентом Raspberry Pi'
    );
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new StarlinkAgentError(payload.error || `Starlink-агент повернув помилку ${response.status}`, statusCode);
  }
  return payload;
}
