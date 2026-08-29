# Поточний стан LABA

Актуально на 2026-08-29. Це безпечний handoff для продовження роботи з іншого ПК або в новій задачі Codex. Секретів у цьому файлі немає.

## Код і production

- Репозиторій: `https://github.com/KORO-GIT/laba`, гілка `main`.
- Поточна версія застосунку: `0.12.2`.
- Production VPS: `62.238.31.125`, Ubuntu 26.04 LTS.
- Каталог: `/opt/laba`.
- Systemd unit: `laba-portal.service`.
- Сервіс слухає лише `127.0.0.1:3020`; зовнішній доступ надає Caddy.
- База: `/opt/laba/data/portal.db`, SQLite WAL.
- Production-конфігурація: `/opt/laba/.env`, власник `root:laba`, mode `0600`.
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

Starlink Mini працює в bypass-режимі; фірмовий роутер вимкнений. Raspberry Pi напряму досягає management IP тарілки `192.168.100.1`, локальний gRPC endpoint `192.168.100.1:9200` відповідає. Цей endpoint не оголошується через Caddy/UFW і доступний LABA тільки через приватний agent.

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

У LABA камера `k1se-camera` є окремим device і дочірнім пристроєм `Creality K1 SE`: dashboard показує її у підгрупі принтера, grants принтера успадковуються камерою. Окремий device `labacam` належить камері відеоспостереження і не має parent; її основний RTSP-профіль — H.264 High 1920×1080@25. Mainsail вбудовує same-origin player `/webcam/laba/player`; він передає H.264 через захищений MSE WebSocket `/webcam/laba/ws`, а префікс `/webcam` обходить navigation fallback service worker Mainsail. HLS і MJPEG маршрути принтера збережені як fallback. LABA серверно підмінює будь-який клієнтський `src` на дозволене ім’я потоку go2rtc.

WebSocket Mainsail проходить через LABA: портал перевіряє, що браузерний `Origin` збігається з адресою пристрою, видаляє службові заголовки Cloudflare та підмінює upstream `Origin` на локальну адресу принтера. Без цієї підміни Moonraker відповідає `Cross origin websockets not allowed`.

## Bluetooth та аудіо

В адмінпанелі `/admin` працює вкладка «Аудіо». Вона доступна лише ролі `admin` і дозволяє:

- увімкнути або вимкнути Bluetooth;
- виконати обмежений у часі discovery;
- спарувати, довірити, підключити, від’єднати або забути пристрій;
- вибрати PipeWire sink, змінити гучність і mute;
- керувати play/pause/next/previous/stop сумісного MPRIS-програвача.

На Pi активний `laba-audio-agent.service`. Він слухає тільки Tailscale IP `100.69.168.10:1985`, приймає тільки VPS `100.68.61.33`, перевіряє окремий bearer credential і не виконує shell. Credential Pi зашифрований у `/etc/credstore.encrypted/laba-audio-agent-token`; plaintext-копії після deployment видалені. `playerctl` встановлено, PipeWire/WirePlumber активні, Logitech C270 доступна як mono source. Адаптивний детектор локально слухає exact PipeWire source C270: два чіткі хлопки виконують MPRIS `play-pause`, а три — приглушують активний MPRIS-програвач до 35%, локально відтворюють «Бажаю здоров'я!» і повертають точну попередню гучність. Інтервал між хлопками — `0,18–0,90` секунди: це підтримує швидкий природний подвійний хлопок, не прибираючи паузу для потрійного жесту. Короткі HF-heavy імпульси електричної мухобойки відсіюються за тривалістю та спектральним співвідношенням. Додатковий transient-shape фільтр, відкалібрований за нічними production-логами, не допускає до жесту слабкі широкі ритмічні імпульси з `activeRatio > 0,58`; хлопок також має `peak >= 0,32` і `RMS >= 0,060`. Після жесту імпульси ігноруються 2 секунди. Bluetooth-контролер `PiLABA4B` увімкнений, а EDIFIER R1080BT підключена й обрана активним аудіовиходом.

YouTube Music не встановлено: офіційний IFrame API відтворює медіа в браузері користувача, а офіційного server-side playback API для подачі звуку з Pi у Bluetooth-колонку немає. MPRIS-кнопки вже готові для локального програвача; вибір між браузерним відтворенням і неофіційним headless-рішенням потрібно зробити окремо.

## Starlink

В адмінпанелі `/admin` є вкладка `Starlink`. Вона показує live ping/download/upload, 15-хвилинні середні/p95/втрати/трафік/живлення, прошивку, uptime, Ethernet/GPS/health, до 30 останніх мережевих подій та карту перешкод. Події Starlink не пов’язані з присутністю людей: це короткі втрати ping/downlink або пакетів; у списку показуються дата, час і тривалість. Керування обмежено Ignore GPS, power-save schedule, clear-map і підтвердженим reboot. Режим підігріву показується read-only із поясненням, що змінити його може лише власник акаунта у застосунку Starlink; portal і Pi agent повертають `403` без надсилання gRPC-команди. Stow/unstow capability-gated і для поточної Starlink Mini приховано, оскільки `hasActuators: HAS_ACTUATORS_NO`.

У Starlink-розділі підготовлено окрему вкладку фірмового роутера. Її стан береться з поля `downstreamRouters` уже наявної телеметрії тарілки, тому додаткових ping, таймерів або мережевих запитів немає. У поточному bypass-режимі вкладка показує `BYPASS`, залишається сірою та недоступною; майбутні кнопки Wi-Fi, клієнтів і перезавантаження відображаються лише як вимкнена заготовка.

На Pi `laba-starlink-agent.service` слухає лише Tailscale IP `100.69.168.10:1986`, приймає тільки VPS `100.68.61.33`, перевіряє окремий bearer credential і звертається тільки до `192.168.100.1:9200`. Agent використовує pinned/checksummed `grpcurl 1.9.3`, не запускає shell і не приймає довільні method/payload. Credential зашифрований у `/etc/credstore.encrypted/laba-starlink-agent-token`; plaintext-копії після deployment видалені.

Остання live-перевірка після deployment: hardware `mini1_panda_prod2`, firmware `2026.08.13.mr84512`, API version `42`, bypass підтверджено, Ethernet `1000 Мбіт/с`, перешкоди близько `3,68%`; історія містить 900 односекундних samples і стискається до 180 точок для графіків. Запит точних координат повертає `PermissionDenied: Disabled due to policy`, тому LABA показує лише доступність/стан GPS. Bypass означає, що статистики фірмового роутера й Wi-Fi немає.

## Віддалений робочий стіл

Raspberry Pi має зарезервовану адресу `192.168.0.63`. Vendor WayVNC слухає TLS/PAM `192.168.0.63:5900`; у локальній мережі до цієї адреси підключається звичайний VNC-клієнт. Vendor service та окремий `laba-wayvnc-web.service` використовують перевірену patched-збірку Raspberry Pi WayVNC `0.9.1-1+rpt5`: для headless-виходу labwc зі станом живлення `UNKNOWN` capture починається одразу, а `ext_image_copy_capture` залишається ввімкненим. Browser endpoint без другого GPU encoder слухає `192.168.0.63:5901`, використовує PAM/VeNCrypt Plain і systemd IP policy, яка приймає лише VPS та власні адреси Pi. `laba-wayvnc-attach.service` прив’язує endpoint до активного Wayland compositor і відновлює прив’язку після рестарту сесії. Plain потрібен через обмеження noVNC і знаходиться лише всередині HTTPS/WSS та Tailscale/WireGuard.

В адмінпанелі `/admin` є вкладка «Робочий стіл». Після натискання «Віддалене підключення» noVNC `1.7.0` відкриває exact same-origin WebSocket LABA. Шлях доступний лише адміністратору, має окремі ліміти та аудит. На VPS websockify слухає тільки `127.0.0.1:6080` і через Tailscale subnet route з’єднується лише з `192.168.0.63:5901`. Пароль Pi вводиться після RFB-запиту, у LABA не зберігається. Порти `5900`, `5901` і `6080` не відкриті в Caddy/UFW.

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
- Перевести конкретну Bluetooth-колонку в pairing mode, знайти її у `/admin` → «Аудіо» та натиснути «Спарувати».
- За потреби відкалібрувати пороги хлопків під інше розташування камери або гучність колонок; поточний профіль перевірено на Webcam C270 під час відтворення YouTube Music.
- Після зміни пароля користувача Pi перевірити обидва VNC-шляхи: локальний `192.168.0.63:5900` та кнопку в LABA.
- Оновлювати pinned go2rtc та пакет uStreamer тільки після перевірки changelog і повторного тесту exact API allowlist.
- За потреби посилити Tailscale ACL так, щоб VPS мав доступ лише до потрібних LAN-вузлів і портів.

Остання production-перевірка: LABA `0.12.2`, `laba-starlink-agent`, `laba-audio-agent`, `laba-desktop-gateway`, Caddy і `tailscaled` active; портал слухає тільки `127.0.0.1:3020`, desktop gateway — `127.0.0.1:6080`, Starlink agent — тільки `100.69.168.10:1986`. Детектор хлопків перевірено регресійними тестами швидкого й повільного людського ритму, електричної дуги та широкої нічної ритмічної перешкоди; хибні жести не формуються, а подвійний і потрійний тестові хлопки проходять. Starlink router status визначено як `BYPASSED` без додаткового probe; snow-melt write повертає `403` на portal і agent. Журнал Starlink позначено як список до 30 останніх мережевих подій із датою/часом, а power-save layout перевірено без виходу кнопки за межі картки. Із desktop gateway прибрано process-level `--idle-timeout`, який завершував enabled unit із кодом 0 після простою; gateway тепер постійно готовий до кнопки noVNC. Starlink agent повернув HTTP `200` для status/map лише з VPS із credential і `401` без credential; карта має `123×123`/`15129` значень. `systemd-analyze security` оцінив Starlink unit як `2.8 OK`; тимчасові plaintext tokens і probe-файли видалені. На VPS повторно пройшли `npm run check`, `npm test` — 6/6 та `npm audit --omit=dev` — 0 відомих вразливостей.
