# Поточний стан LABA

Актуально на 2026-08-28. Це безпечний handoff для продовження роботи з іншого ПК або в новій задачі Codex. Секретів у цьому файлі немає.

## Код і production

- Репозиторій: `https://github.com/KORO-GIT/laba`, гілка `main`.
- Поточна версія застосунку: `0.6.0`.
- Production VPS: `62.238.31.125`, Ubuntu 26.04 LTS.
- Каталог: `/opt/laba`.
- Systemd unit: `laba-portal.service`.
- Сервіс слухає лише `127.0.0.1:3020`; зовнішній доступ надає Caddy.
- База: `/opt/laba/data/portal.db`, SQLite WAL.
- Production-конфігурація: `/opt/laba/.env`, власник `root:laba`, mode `0640`.
- Перед кожним оновленням базу копіюють у `/opt/laba/backups/` через SQLite `.backup`.

Production-паролі, SSH-дані, Cloudflare API tokens, `.env`, база, резервні копії, сертифікати та приватні ключі навмисно не зберігаються в Git. Для роботи з production користувач має окремо надати доступ.

## Адреси та доступ

- Портал: `https://laba.zpseapil.club`.
- Адмінпанель: `https://laba.zpseapil.club/admin`.
- Адреси пристроїв: `https://<slug>-laba.zpseapil.club`.
- Головний адміністратор: `dima.korobchenko@gmail.com`.
- Інтерфейс LABA, повідомлення API, статуси та документація — українською мовою.
- Сторінка автентифікації належить Cloudflare й може відображатися англійською.

Cloudflare Zero Trust містить Self-hosted application `LABA Device Portal` для:

- `laba.zpseapil.club`;
- `*-laba.zpseapil.club`.

Політика `LABA authenticated users` має два Include-правила (OR):

- точний e-mail головного адміністратора;
- `Login Methods: One-time PIN`.

Cloudflare підтверджує e-mail, але остаточний доступ визначає локальний allowlist LABA. Нового користувача додають лише через `/admin`; змінювати Access policy для нього не потрібно.

## Мережа

Домашня мережа недоступна напряму з інтернету через CGNAT. Використовується Tailscale, побудований на WireGuard:

- VPS-вузол: `laba-vps`, Tailscale IP `100.68.61.33`;
- Raspberry Pi: hostname `PiLABA4B`, LAN IP `192.168.0.63/24`;
- Tailscale subnet router: `pilaba4b-subnet`;
- оголошений маршрут: `192.168.0.0/24`;
- Windows-вузол, що використовувався під час налаштування: `laptop-motht2lb`.

VPS приймає маршрут `192.168.0.0/24`. Порти принтерів і камер не відкриваються у UFW або напряму в інтернет.

## Пристрої

Поточний 3D-принтер:

- назва: `Creality K1 SE`;
- slug: `k1se-01`;
- LAN IP: `192.168.0.70`;
- web UI: `http://192.168.0.70:80`;
- Moonraker API: `http://192.168.0.70:7125`;
- захищена адреса: `https://k1se-01-laba.zpseapil.club`.

Moonraker під час останньої перевірки повертав `klippy_state: ready`. До Raspberry Pi підключена Logitech C270, USB ID `046d:0825`, стабільний path `/dev/v4l/by-id/usb-046d_C270_HD_WEBCAM_200901010001-video-index0`. uStreamer захоплює hardware MJPEG 1280×720@30, а окремий sandboxed FFmpeg формує browser-compatible H.264 Constrained Baseline 1280×720@25 приблизно 2 Мбіт/с. `libx264` працює з `ultrafast`/`zerolatency`, GOP 13 і повтором SPS/PPS на кожному ключовому кадрі; це усуває обмеження Raspberry Pi V4L2 M2M, який ігнорував короткий GOP. `exposure_dynamic_framerate=0` запобігає падінню FPS у слабкому освітленні.

На Pi `laba-ustreamer.service` слухає тільки `127.0.0.1:8080`, `laba-h264-encoder.service` — тільки `127.0.0.1:8556`, а go2rtc `v1.9.14` — Tailscale IP `100.69.168.10:1984`. RTSP-server, WebRTC, exec і вбудований ffmpeg go2rtc вимкнені. Потоки `printer-usb-camera` та `labacam-01` доступні LABA через Basic Auth і exact API allowlist; systemd egress go2rtc окремо дозволяє лише VPS, loopback/Tailscale та `192.168.0.138/32`. Пароль RTSP-камери передається go2rtc через зашифрований systemd credential, а не зберігається відкритим текстом у YAML.

У LABA камера `k1se-camera` є окремим device і дочірнім пристроєм `Creality K1 SE`: dashboard показує її у підгрупі принтера, grants принтера успадковуються камерою. Окремий device `labacam` належить камері відеоспостереження і не має parent; її основний RTSP-профіль — H.264 High 1920×1080@25. Mainsail використовує same-origin HLS `/laba-camera/api/stream.m3u8` і `/laba-camera/snapshot`; LABA жорстко прив’язує master playlist до дозволеного потоку go2rtc та примусово вмикає fMP4 HLS для Media Source Extensions у Chromium.

WebSocket Mainsail проходить через LABA: портал перевіряє, що браузерний `Origin` збігається з адресою пристрою, видаляє службові заголовки Cloudflare та підмінює upstream `Origin` на локальну адресу принтера. Без цієї підміни Moonraker відповідає `Cross origin websockets not allowed`.

## Caddy і сусідні сервіси

На VPS уже працювали інші production-домени до появи LABA. Їх не можна змінювати під час оновлення порталу:

- `star.zpseapil.club` → `koro-kanban.service`;
- `task.zpseapil.club` → `koro-task.service`;
- `scan.zpseapil.club` → `koro-signal-sheets-sync.service`;
- Signal gateway/API та інші наявні блоки Caddy.

LABA використовує окремі точний і wildcard-блоки Caddy. Origin Certificate і ключ знаходяться в `/etc/caddy/certs/laba-origin.pem` та `/etc/caddy/certs/laba-origin-key.pem`; приватний ключ не копіювати з VPS і не комітити. Перед reload завжди виконувати backup Caddyfile, `caddy fmt` і `caddy validate`.

## Як продовжити з іншого ПК

1. Клонувати репозиторій і перейти на `main`.
2. Повністю прочитати `AGENTS.md`, `README.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md` і цей файл.
3. Виконати `git status --short` та не видаляти чужі зміни.
4. Встановити Node.js 22+, потім виконати `npm ci`, `npm run check`, `npm test`, `npm audit --omit=dev`.
5. Для локального запуску використовувати лише `AUTH_MODE=development` за прикладом у README.
6. Для production не змінювати `.env`, `data/`, `backups/`, сертифікати або сусідні сервіси. Дотримуватися процедури з `docs/DEPLOYMENT.md`.
7. Перед оновленням перевірити, що локальний `main`, `origin/main` і `/opt/laba` не розходяться.

## Найближчі наступні кроки

- Завершити вхід головного адміністратора через One-time PIN на новий e-mail, якщо поточна Access-сесія закінчилася.
- Після зміни положення або освітлення камери перевірити різкість, експозицію і стабільні 25 FPS H.264 під час реального друку.
- Оновлювати pinned go2rtc та пакет uStreamer тільки після перевірки changelog і повторного тесту exact API allowlist.
- За потреби посилити Tailscale ACL так, щоб VPS мав доступ лише до потрібних LAN-вузлів і портів.

Остання перевірка: LABA, Caddy, `koro-*`, Signal sync і `tailscaled` були active; Caddyfile валідний; `npm test` — 6/6; `npm audit --omit=dev` — 0 відомих вразливостей.
