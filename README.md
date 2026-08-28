# LABA Device Portal

Закритий портал для віддаленого доступу до 3D-принтерів і камер лабораторії. Пристрої залишаються в домашній мережі; VPS бачить їх лише через Tailscale subnet router на Raspberry Pi.

## Що реалізовано

- адаптивна головна сторінка зі статусами та телеметрією Moonraker;
- кілька принтерів і камер, сортування та ввімкнення/вимкнення без видалення історії;
- окремі захищені адреси виду `k1se-01-laba.zpseapil.club` (перший рівень, покритий Cloudflare Universal SSL Free);
- адмінпанель пристроїв, користувачів, ролей та індивідуальних дозволів;
- ролі `viewer`, `operator`, `admin`;
- журнал адміністративних змін;
- адміністративне керування Bluetooth Raspberry Pi: живлення, пошук, pairing, trust, підключення та видалення пристроїв;
- керування PipeWire-виходом, гучністю, mute та сумісним MPRIS-програвачем;
- локальний VNC до Raspberry Pi та адміністраторський noVNC-сеанс через LABA за окремою кнопкою;
- вхід через Cloudflare Access (OTP/OAuth/MFA та захист від перебору на edge);
- додатковий локальний allowlist: однієї успішної авторизації Cloudflare недостатньо;
- перевірка Cloudflare Access JWT за підписом, issuer та audience;
- proxy HTTP/WebSocket для Mainsail, OctoPrint і вебінтерфейсів камер;
- захищений browser-viewer камер через go2rtc: MSE, HLS або MJPEG без публікації RTSP/WebRTC-портів;
- прив’язка камери до принтера: спільна підгрупа на dashboard, успадкування доступу та відео безпосередньо в Mainsail;
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
                                      ├── Logitech C270 → uStreamer → low-latency H.264
                                                           → go2rtc на Tailscale IP Pi
                                      ├── BlueZ + PipeWire ← приватний LABA audio agent
                                      └── WayVNC :5900 (LAN TLS)
                                                 :5901 (тільки VPS) ← loopback websockify ← noVNC
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
- назву потоку `printer-usb-camera`, що точно збігається з `deploy/go2rtc/go2rtc.yaml`;
- формат `Автовибір MSE / HLS / MJPEG`;
- підгрупу принтера `Creality K1 SE`;
- Basic Auth go2rtc у секреті JSON: ім’я `laba-vps` і згенерований локально пароль.

LABA віддає власну сторінку MSE-плеєра, серверно підставляє дозволену назву потоку й проксіює лише потрібні media endpoint’и. WebUI go2rtc, `/api/config`, керування потоками й довільний параметр `src` користувачам недоступні. Для прив’язаної камери Mainsail використовує same-origin URL `/webcam/laba/player`; префікс `/webcam` входить до denylist service worker Mainsail і тому player не замінюється кешованою оболонкою PWA. LABA також зберігає HLS URL `/laba-camera/api/stream.m3u8`, snapshot URL `/laba-camera/snapshot` і MJPEG `/laba-camera/stream` як резервні варіанти. Реальна адреса go2rtc та його пароль у браузер не потрапляють.

## Bluetooth та аудіо

Адміністратор відкриває `/admin` → «Аудіо». Звідти можна ввімкнути або вимкнути Bluetooth, запустити короткий пошук, спарувати й підключити колонку, вибрати PipeWire-вихід, змінити гучність і керувати локальним MPRIS-програвачем. Перед pairing колонку потрібно вручну перевести в режим виявлення.

Браузер не звертається до Raspberry Pi напряму. LABA на VPS перевіряє роль, same-origin/CSRF, rate limit і журналює зміну, після чого звертається до окремого агента через Tailscale. Агент не приймає shell-команди та підтримує лише фіксований список операцій BlueZ, PipeWire і MPRIS.

YouTube Music поки не запускається на Pi. Офіційний [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) відтворює звук у браузері користувача, а не на серверному Raspberry Pi; офіційного server-side playback API для виведення у Bluetooth-колонку немає. Неофіційне вилучення аудіопотоку навмисно не встановлено.

## Робочий стіл Raspberry Pi

У домашній мережі VNC-клієнт підключається безпосередньо до `192.168.0.63:5900`. WayVNC слухає лише зарезервовану LAN-адресу Raspberry Pi, використовує PAM і вимагає ім’я користувача та пароль Pi.

Для доступу ззовні адміністратор відкриває `/admin` → «Робочий стіл» і натискає «Віддалене підключення». Браузерний noVNC з’єднується з exact WebSocket-шляхом LABA; сервер повторно перевіряє роль `admin` і same-origin, прибирає cookies/authorization, після чого передає VNC-трафік до `websockify` на loopback VPS. `websockify` звертається до окремого PAM endpoint `192.168.0.63:5901` через Tailscale subnet route. Systemd IP policy на Pi приймає цей endpoint лише від VPS/власного вузла Pi; інші LAN-клієнти використовують TLS endpoint `5900`. Публічні порти `5900`, `5901` і `6080` не відкриваються.

Пароль VNC вводиться у браузері після запиту Raspberry Pi, передається протоколом RFB і не записується до бази, `.env` або журналу LABA. Одночасно дозволено не більше двох віддалених сеансів; нові підключення мають окремий rate limit.

## Production

Точні команди, налаштування Cloudflare, backup і rollback описані в [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Модель загроз — у [docs/SECURITY.md](docs/SECURITY.md). Поточна production-топологія та handoff для іншого Codex — у [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md).

У репозиторії немає production-паролів, токенів, `.env`, баз даних і сертифікатів.
