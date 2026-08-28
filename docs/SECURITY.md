# Security model

## Границы доверия

1. Cloudflare Access проверяет личность и применяет OTP/OAuth/MFA, WAF и edge rate limiting.
2. LABA криптографически проверяет Access JWT, после чего ищет e-mail в собственной базе.
3. Роль и разрешение на конкретное устройство проверяются при каждом HTTP и WebSocket подключении.
4. Upstream-устройство доступно только VPS через Tailscale subnet route `192.168.0.0/24`.

Портал не доверяет одному только заголовку `Cf-Access-Authenticated-User-Email`: используется подписанный `Cf-Access-Jwt-Assertion`, проверяются RS256, issuer и audience.

## Контроли

- Production не стартует в development auth mode.
- Устройства задаются только literal IPv4 из `ALLOWED_DEVICE_SUBNETS`. Это исключает DNS rebinding и proxy к произвольным адресам.
- Cloudflare assertion, `CF_Authorization` cookie и входящий `Authorization` удаляются до upstream.
- Опциональный upstream secret хранится только в AES-256-GCM виде с отдельным 32-byte ключом.
- Административные изменения требуют same-origin и специальный заголовок, ограничены rate limit и записываются в аудит.
- Cross-site state-changing запросы к device proxy отклоняются по Fetch Metadata.
- HTML/API не кэшируются; indexing запрещён на уровне meta/header/Caddy.
- Сервис слушает только loopback, работает без Linux capabilities и с systemd sandbox.
- UFW не открывает дополнительные порты для LABA или устройств.

## Cloudflare

- Создать Self-hosted Access application для `laba.zpseapil.club` и частичной wildcard-зоны `*-laba.zpseapil.club` (одна audience) либо две apps и указать обе audience через запятую.
- Подключить два login method: существующий Cloudflare IdP и One-time PIN.
- Политика `LABA authenticated users` использует два Include-правила (OR): точный e-mail bootstrap-администратора и `Login Methods: One-time PIN`. Это позволяет добавлять пользователей только через админку LABA, без ручного изменения Access policy.
- Правило One-time PIN само по себе принимает любой подтверждённый e-mail. Это намеренно: доступ к данным выдаёт второй независимый барьер — локальный allowlist LABA. Не удалять локальную проверку и не использовать `AUTH_MODE=development` в production.
- Рекомендуемый session duration — 8–24 часа. Для IdP, поддерживающего MFA, его следует включить.
- Добавить отдельную WAF/rate-limit политику для `/cdn-cgi/access/login` и административных API, если это поддерживает тариф.
- DNS `laba` и wildcard `*` должны быть proxied. Точные существующие DNS-записи имеют приоритет; Caddy отклоняет неизвестные wildcard-хосты.
- SSL/TLS mode — Full (strict). Origin certificate покрывает `*.zpseapil.club`; приватный ключ хранится только на VPS с mode `640`, доступен `root:caddy`.

## Остаточные риски

- Mainsail/OctoPrint и web UI камер становятся доступны пользователям с ролью управления. Их собственные уязвимости всё ещё важны, поэтому firmware нужно обновлять.
- Администратор LABA по определению может менять назначения и upstream credentials.
- Компрометация VPS или tailnet даёт путь в домашнюю подсеть; Tailscale ACL следует ограничить только нужными узлами/маршрутом.
- RTSP нельзя безопасно показать в обычном браузере без медиашлюза. При добавлении камеры предпочтителен go2rtc с WebRTC и без прямой публикации RTSP.

## Секреты

Не коммитить и не копировать в отчёты:

- `/opt/laba/.env`;
- `/opt/laba/data/portal.db*` и backups;
- `/etc/caddy/certs/laba-*`;
- SSH, Cloudflare, Tailscale и device credentials.

Ротация `DEVICE_SECRET_KEY` требует расшифровать и заново зашифровать сохранённые device secrets. Простая замена ключа сделает их нечитаемыми.
