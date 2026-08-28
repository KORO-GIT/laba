# LABA Device Portal

Закритий портал для віддаленого доступу до 3D-принтерів і камер лабораторії. Пристрої залишаються в домашній мережі; VPS бачить їх лише через Tailscale subnet router на Raspberry Pi.

## Що реалізовано

- адаптивна головна сторінка зі статусами та телеметрією Moonraker;
- кілька принтерів і камер, сортування та ввімкнення/вимкнення без видалення історії;
- окремі захищені адреси виду `k1se-01-laba.zpseapil.club` (перший рівень, покритий Cloudflare Universal SSL Free);
- адмінпанель пристроїв, користувачів, ролей та індивідуальних дозволів;
- ролі `viewer`, `operator`, `admin`;
- журнал адміністративних змін;
- вхід через Cloudflare Access (OTP/OAuth/MFA та захист від перебору на edge);
- додатковий локальний allowlist: однієї успішної авторизації Cloudflare недостатньо;
- перевірка Cloudflare Access JWT за підписом, issuer та audience;
- proxy HTTP/WebSocket для Mainsail, OctoPrint і вебінтерфейсів камер;
- захищений browser-viewer камер через go2rtc: MSE, HLS або MJPEG без публікації RTSP/WebRTC-портів;
- шифрування облікових даних пристроїв AES-256-GCM;
- SSRF-захист: дозволено лише literal IP із заданих підмереж;
- SQLite WAL, rate limiting, CSP, anti-indexing і systemd hardening.

## Схема

```text
Браузер
   │ HTTPS + Cloudflare Access
   ▼
Cloudflare ──► Caddy на VPS ──► LABA (127.0.0.1:3020)
                                      │
                                      │ Tailscale / WireGuard
                                      ▼
                              Raspberry Pi subnet router
                                      │ 192.168.0.0/24
                                      ├── 3D-принтери
                                      ├── камери
                                      └── go2rtc на Tailscale IP Pi
```

VPS не публікує порти пристроїв. В інтернет відкриті лише Caddy та захищені домени LABA.

## Права

| Роль | Портал | Камери | Принтери | Адмінпанель |
|---|---|---|---|---|
| `viewer` | призначені пристрої | перегляд | лише статус | ні |
| `operator` | призначені пристрої | перегляд/керування | керування | ні |
| `admin` | усі пристрої | повний доступ | повний доступ | так |

Cloudflare Access підтверджує особу та захищає форму входу. Адмінпанель LABA є головним списком доступу: вона визначає, чи дозволений підтверджений e-mail, його роль і список пристроїв.

## Додавання користувача

1. Адміністратор відкриває `/admin`, додає точний e-mail, обирає роль і призначає пристрої.
2. Користувач відкриває `https://laba.zpseapil.club`, вводить той самий e-mail і отримує одноразовий код від Cloudflare.
3. Після перевірки коду LABA повторно звіряє e-mail із локальним allowlist. Користувач, якого немає в адмінпанелі або якого вимкнено, доступу не отримує.

Для додавання звичайного користувача змінювати Cloudflare вручну не потрібно. Учасники Cloudflare-акаунта також можуть використовувати наявний вхід Cloudflare. Завершити сесію можна через `/cdn-cgi/access/logout`.

## Локальний запуск

Потрібен Node.js 22+.

```powershell
npm.cmd install
$env:AUTH_MODE="development"
$env:BOOTSTRAP_ADMIN_EMAIL="admin@local.test"
$env:DEV_USER_EMAIL="admin@local.test"
npm.cmd run dev
```

Відкрити `http://127.0.0.1:8080`. Development-режим заборонений, якщо `NODE_ENV=production`.

Перевірки:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd audit --omit=dev
```

## Додавання пристрою

У `/admin` вибрати «Додати пристрій» і вказати:

- унікальний slug, який стане адресою виду `<slug>-laba.zpseapil.club`;
- IP із дозволеної домашньої підмережі;
- вебпорт і, для Moonraker, порт API;
- інтеграцію: Moonraker, OctoPrint, звичайний HTTP(S) або RTSP;
- за потреби JSON-секрет: `{"username":"...","password":"..."}` або `{"apiKey":"..."}`.

Для прямої діагностики RTSP вибрати інтеграцію `RTSP-потік`: LABA перевірить TCP-порт, але браузер такий потік не відкриє.

Для захищеного перегляду вибрати `go2rtc — браузерне відео` та вказати:

- адресу шлюзу `100.69.168.10` — Tailscale IP Raspberry Pi;
- HTTP-порт `1984`;
- назву потоку `camera-01`, що точно збігається з `deploy/go2rtc/go2rtc.yaml`;
- Basic Auth go2rtc у секреті JSON: ім’я `laba-vps` і згенерований локально пароль.

LABA віддає власну сторінку плеєра, серверно підставляє дозволену назву потоку й проксіює лише WebSocket MSE/MJPEG та потрібні HLS-сегменти. WebUI go2rtc, `/api/config`, керування потоками й довільний параметр `src` користувачам недоступні. Облікові дані самої камери зберігаються тільки на Raspberry Pi як зашифрований systemd credential.

## Production

Точні команди, налаштування Cloudflare, backup і rollback описані в [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Модель загроз — у [docs/SECURITY.md](docs/SECURITY.md). Поточна production-топологія та handoff для іншого Codex — у [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md).

У репозиторії немає production-паролів, токенів, `.env`, баз даних і сертифікатів.
