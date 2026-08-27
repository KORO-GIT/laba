# LABA Device Portal

Закрытый портал для удалённого доступа к 3D-принтерам и камерам лаборатории. Устройства остаются в домашней сети; VPS видит их только через Tailscale subnet router на Raspberry Pi.

## Что реализовано

- адаптивная главная страница со статусами и телеметрией Moonraker;
- несколько принтеров и камер, сортировка и включение/отключение без удаления истории;
- отдельные защищённые адреса вида `k1se-01-laba.zpseapil.club` (первый уровень, покрываемый Cloudflare Universal SSL Free);
- админка устройств, пользователей, ролей и индивидуальных разрешений;
- роли `viewer`, `operator`, `admin`;
- журнал административных изменений;
- вход через Cloudflare Access (OTP/OAuth/MFA и защита от перебора на edge);
- дополнительный локальный allowlist: одной успешной авторизации Cloudflare недостаточно;
- проверка Cloudflare Access JWT по подписи, issuer и audience;
- proxy HTTP/WebSocket для Mainsail, OctoPrint и web-интерфейсов камер;
- шифрование учётных данных устройств AES-256-GCM;
- SSRF-защита: разрешены только literal IP из заданных подсетей;
- SQLite WAL, rate limiting, CSP, anti-indexing и systemd hardening.

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
                                      ├── 3D-принтеры
                                      └── камеры
```

VPS не публикует порты устройств. В интернет открыты только Caddy и защищённые домены LABA.

## Права

| Роль | Портал | Камеры | Принтеры | Админка |
|---|---|---|---|---|
| `viewer` | назначенные устройства | просмотр | только статус | нет |
| `operator` | назначенные устройства | просмотр/управление | управление | нет |
| `admin` | все устройства | полный доступ | полный доступ | да |

Cloudflare Access определяет, кто вообще может пройти к приложению. Админка LABA определяет роль и список устройств для подтверждённого e-mail.

## Локальный запуск

Нужен Node.js 22+.

```powershell
npm.cmd install
$env:AUTH_MODE="development"
$env:BOOTSTRAP_ADMIN_EMAIL="admin@local.test"
$env:DEV_USER_EMAIL="admin@local.test"
npm.cmd run dev
```

Открыть `http://127.0.0.1:8080`. Development-режим запрещён, если `NODE_ENV=production`.

Проверки:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd audit --omit=dev
```

## Добавление устройства

В `/admin` выбрать «Добавить устройство» и указать:

- уникальный slug, который станет адресом вида `<slug>-laba.zpseapil.club`;
- IP из разрешённой домашней подсети;
- web-порт и, для Moonraker, API-порт;
- интеграцию: Moonraker, OctoPrint, обычный HTTP(S) или RTSP;
- при необходимости JSON-секрет: `{"username":"...","password":"..."}` либо `{"apiKey":"..."}`.

RTSP сейчас проверяется по TCP. Для воспроизведения потока в браузере нужно добавить отдельный WebRTC/HLS-шлюз; прямой RTSP браузеры не открывают.

## Production

Точные команды, Cloudflare-настройки, backup и rollback описаны в [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Модель угроз — в [docs/SECURITY.md](docs/SECURITY.md).

Никаких production-паролей, токенов, `.env`, баз данных и сертификатов в репозитории нет.
