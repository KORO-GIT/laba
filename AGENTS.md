# AGENTS.md

Правила для агента, который продолжает разработку LABA.

## Перед началом

1. Прочитать `README.md`, `docs/SECURITY.md` и `docs/DEPLOYMENT.md`.
2. Проверить `git status --short`; чужие изменения не удалять.
3. Не читать и не печатать production-секреты без необходимости. Никогда не коммитить `.env`, SQLite, сертификаты, ключи, логи и резервные копии.
4. Текущий VPS содержит другие production-сервисы. Не менять их каталоги, units, базы и процессы.

## Проверки

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
```

## Инварианты безопасности

- Production запускается только с `AUTH_MODE=cloudflare`.
- JWT Cloudflare Access всегда проверяется по подписи, issuer и audience.
- Пользователь должен одновременно пройти Cloudflare Access и присутствовать в локальном allowlist.
- Адрес устройства должен быть literal IPv4 из `ALLOWED_DEVICE_SUBNETS`; DNS-имена не разрешать, чтобы не открыть SSRF.
- Секреты устройств шифруются AES-256-GCM. Не писать второй механизм шифрования.
- В upstream не передаются Cloudflare assertion, Access cookie и пользовательский `Authorization`.
- Нельзя отключить последнего активного администратора.
- Все state-changing admin API проверяют Origin и маркер `X-Portal-Request`.
- Принтером может управлять только `operator` или `admin`; `viewer` видит статус.

## Production

- Сервис: `laba-portal.service`.
- Пользователь: `laba`.
- Каталог: `/opt/laba`.
- Upstream: `127.0.0.1:3020`.
- Не заменять `/etc/caddy/Caddyfile` целиком. Только добавить/изменить отдельный LABA-блок, затем `caddy validate`, backup и `systemctl reload caddy`.
- Перед обновлением создать SQLite backup через `.backup`, затем проверить health endpoint и последние логи.
- Не включать production `AUTH_MODE=development` даже временно.
