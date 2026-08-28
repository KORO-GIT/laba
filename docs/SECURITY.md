# Security model

## Межі довіри

1. Cloudflare Access перевіряє особу та застосовує OTP/OAuth/MFA, WAF і edge rate limiting.
2. LABA криптографічно перевіряє Access JWT, після чого шукає e-mail у власній базі.
3. Роль і дозвіл на конкретний пристрій перевіряються під час кожного HTTP- та WebSocket-підключення.
4. Upstream-пристрій доступний лише VPS через Tailscale subnet route `192.168.0.0/24`.

Портал не довіряє лише заголовку `Cf-Access-Authenticated-User-Email`: використовується підписаний `Cf-Access-Jwt-Assertion`, перевіряються RS256, issuer та audience.

## Засоби контролю

- Production не запускається в development auth mode.
- Пристрої задаються лише literal IPv4 з `ALLOWED_DEVICE_SUBNETS`. Це унеможливлює DNS rebinding і proxy до довільних адрес.
- Cloudflare assertion, cookie `CF_Authorization` і вхідний `Authorization` видаляються до upstream.
- Необов’язковий upstream secret зберігається лише у вигляді AES-256-GCM з окремим 32-byte ключем.
- Адміністративні зміни потребують same-origin і спеціального заголовка, обмежені rate limit та записуються до аудиту.
- Cross-site state-changing запити до device proxy відхиляються за Fetch Metadata.
- HTML/API не кешуються; indexing заборонено на рівні meta/header/Caddy.
- Сервіс слухає лише loopback, працює без Linux capabilities і з systemd sandbox.
- UFW не відкриває додаткових портів для LABA або пристроїв.

## Cloudflare

- Створити Self-hosted Access application для `laba.zpseapil.club` і часткової wildcard-зони `*-laba.zpseapil.club` (одна audience) або дві apps та вказати обидві audience через кому.
- Підключити два login method: наявний Cloudflare IdP і One-time PIN.
- Політика `LABA authenticated users` використовує два Include-правила (OR): точний e-mail bootstrap-адміністратора і `Login Methods: One-time PIN`. Це дає змогу додавати користувачів лише через адмінпанель LABA, без ручної зміни Access policy.
- Правило One-time PIN саме по собі приймає будь-який підтверджений e-mail. Це навмисно: доступ до даних надає другий незалежний бар’єр — локальний allowlist LABA. Не видаляти локальну перевірку та не використовувати `AUTH_MODE=development` у production.
- Рекомендований session duration — 8–24 години. Для IdP, що підтримує MFA, його слід увімкнути.
- Додати окрему WAF/rate-limit політику для `/cdn-cgi/access/login` та адміністративних API, якщо це підтримує тариф.
- DNS `laba` і wildcard `*` мають бути proxied. Точні наявні DNS-записи мають пріоритет; Caddy відхиляє невідомі wildcard-хости.
- SSL/TLS mode — Full (strict). Origin certificate покриває `*.zpseapil.club`; приватний ключ зберігається лише на VPS з mode `640`, доступний `root:caddy`.

## Залишкові ризики

- Mainsail/OctoPrint і web UI камер стають доступними користувачам із роллю керування. Їхні власні вразливості все ще важливі, тому firmware потрібно оновлювати.
- Адміністратор LABA за визначенням може змінювати призначення та upstream credentials.
- Компрометація VPS або tailnet дає шлях до домашньої підмережі; Tailscale ACL слід обмежити лише потрібними вузлами/маршрутом.
- RTSP не можна безпечно показати у звичайному браузері без медіашлюзу. Під час додавання камери бажано використовувати go2rtc з WebRTC і без прямої публікації RTSP.

## Секрети

Не комітити й не копіювати у звіти:

- `/opt/laba/.env`;
- `/opt/laba/data/portal.db*` і backups;
- `/etc/caddy/certs/laba-*`;
- SSH, Cloudflare, Tailscale і device credentials.

Ротація `DEVICE_SECRET_KEY` потребує розшифрувати й повторно зашифрувати збережені device secrets. Проста заміна ключа зробить їх нечитабельними.
