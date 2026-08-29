# Security model

## Межі довіри

1. Cloudflare Access перевіряє особу та застосовує OTP/OAuth/MFA, WAF і edge rate limiting.
2. LABA криптографічно перевіряє Access JWT, після чого шукає e-mail у власній базі.
3. Роль і дозвіл на конкретний пристрій перевіряються під час кожного HTTP- та WebSocket-підключення.
4. Upstream-пристрій доступний лише VPS через Tailscale subnet route `192.168.0.0/24`.
5. Browser-viewer камери звертається до go2rtc на точному Tailscale IP Raspberry Pi `100.69.168.10`; локальна адреса USB-джерела та пароль go2rtc не передаються до браузера.
6. Bluetooth/Audio-запити доступні лише адміністратору. VPS звертається до audio agent на точному Tailscale IP Pi `100.69.168.10:1985` з окремим bearer credential; агент приймає лише джерело `100.68.61.33`.
7. WayVNC слухає зарезервовану LAN-адресу Pi: TLS/PAM endpoint `192.168.0.63:5900` для локальних VNC-клієнтів і окремий PAM endpoint `192.168.0.63:5901` лише для VPS. Віддалений браузерний доступ проходить через admin-only WebSocket LABA та `websockify` на loopback VPS `127.0.0.1:6080`.
8. Starlink-запити доступні лише адміністратору. VPS звертається до Starlink agent на точному Tailscale IP Pi `100.69.168.10:1986` з окремим bearer credential; agent приймає лише джерело `100.68.61.33`, а сам звертається тільки до тарілки `192.168.100.1:9200`.

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
- Для go2rtc LABA дозволяє лише власну сторінку viewer, п’ять exact статичних asset-шляхів плеєра, exact WebSocket `/gateway/ws` або `/webcam/laba/ws`, exact HLS-сесійні шляхи та MJPEG snapshot/резервний stream для прив’язаного Mainsail. Ім’я потоку береться з БД на сервері, а будь-який клієнтський `src` ігнорується.
- Caddy дозволяє `SAMEORIGIN` framing лише для exact `/webcam/laba/player`; усі інші сторінки LABA залишаються з `X-Frame-Options: DENY`, а сам player додатково має CSP `frame-ancestors 'self'`. Префікс `/webcam` входить до navigation denylist service worker Mainsail, тому PWA не підмінює player власною оболонкою.
- go2rtc запускається без модулів `exec`, `ffmpeg`, `webrtc`, debug та WebUI. RTSP-модуль потрібен лише як клієнт камери відеоспостереження; його сервер вимкнено через `rtsp.listen: ""`.
- uStreamer читає Logitech C270 у MJPEG 1280×720@30 і слухає тільки `127.0.0.1:8080`. Окремий sandboxed FFmpeg використовує `libx264 ultrafast/zerolatency`, кодує H.264 Constrained Baseline 1280×720@25 приблизно у 2 Мбіт/с з GOP 13 і слухає тільки `127.0.0.1:8556`. go2rtc слухає `100.69.168.10:1984`, використовує Basic Auth і systemd IP-фільтр, що дозволяє лише VPS `100.68.61.33`, власний вузол Pi та точну RTSP-камеру `192.168.0.138/32`.
- Камера, прив’язана до принтера, успадковує його grant. Mainsail отримує основний H.264/MSE потік через exact same-origin `/webcam/laba/*`; точні HLS і snapshot-шляхи `/laba-camera/api/*` та `/laba-camera/snapshot` залишаються fallback. Інші шляхи go2rtc через host принтера не проксіюються.
- Audio agent слухає лише Tailscale IP, додатково обмежений systemd `IPAddressAllow`, bearer credential і rate limit. Він формує `argv` тільки з allowlist команд та валідованих MAC/node/action, не запускає shell і не приймає довільні шляхи або команди.
- Starlink agent слухає лише Tailscale IP, має systemd IP policy для exact VPS/dish, окремий зашифрований credential, rate limit, обмеження розміру/часу відповіді й не запускає shell. `grpcurl` зафіксований за версією та SHA-256. Agent не приймає довільний gRPC payload: доступні тільки status/history/config/diagnostics/map, reboot, GPS inhibit, power-save, clear-map та capability-gated stow. Snow-melt залишається тільки read-only і будь-яка спроба запису завершується `403` до звернення до тарілки, оскільки Starlink вимагає власника акаунта. Factory reset, RF inhibit, fuse, debug і test-команди не експонуються.
- Усі Bluetooth/Audio write API вимагають роль `admin`, same-origin, `X-Portal-Request`, мають окремі rate limits і записуються до адміністративного аудиту. Статус не містить bearer credential.
- Детектор хлопків читає PCM тільки локально через exact PipeWire node Logitech C270. Аудіо не записується на диск, не передається у LABA або мережу й обробляється блоками по 20 мс. Anti-spark фільтр відсіює надкороткі HF-heavy імпульси, а transient-shape фільтр — слабкі широкі ритмічні звуки від музики, колонок або обладнання; жест вимагає ритму `0,35–0,80` секунди. Подвійний хлопок виконує allowlisted MPRIS `play-pause`; потрійний тимчасово зменшує MPRIS-гучність активного програвача, локально відтворює фіксований WAV і гарантовано намагається повернути точне попереднє значення гучності.
- Bluetooth-пристрій отримує `trust` лише під час явного pairing адміністратора. Пошук обмежений 30 секундами; після завершення BlueZ припиняє discovery.
- Exact WebSocket `/api/admin/desktop/ws` доступний лише ролі `admin`, вимагає same-origin і не приймає query-параметри. Перед websockify LABA видаляє Cloudflare assertion, `Authorization`, cookies та browser `Origin`.
- Віддалений VNC обмежений двома одночасними з’єднаннями та вісьмома спробами на хвилину для одного адміністратора; кожне прийняте з’єднання записується до аудиту.
- `websockify` слухає лише `127.0.0.1:6080`, а systemd IP policy дозволяє йому лише loopback та exact target `192.168.0.63/32`. На Pi browser endpoint `5901` має окрему systemd IP policy: лише VPS Tailscale IP та локальні адреси самого Pi. UFW/Caddy не публікують порти `5900`, `5901` або `6080`.
- noVNC підтримує PAM subtype VeNCrypt Plain, але не вкладений X509Plain. Тому `5901` дозволяє Plain лише всередині вже зашифрованого каналу HTTPS/WSS → loopback VPS → Tailscale/WireGuard; звичайний LAN endpoint `5900` зберігає X.509 encryption і не вмикає `relax_encryption`.
- Browser-only WayVNC запускається без другого GPU/H.264 encoder. Його pinned source archives перевіряються за SHA-256, а локальний patch змінює тільки запуск capture для стану живлення `UNKNOWN`. Окремий attach-agent працює як `vnc`, не має мережевих address families або capabilities, виконує лише fixed `wayvncctl output-list/attach` і прив’язує endpoint до наявного Wayland socket, доступ до якого вже надає vendor `wayvnc-control.service`.
- Облікові дані VNC запитує сам протокол RFB. LABA не зберігає їх у SQLite, `.env`, cookies, localStorage або аудиті; поле пароля очищається одразу після передачі noVNC.

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
- Програмний H.264 займає приблизно 1,1 ядра Raspberry Pi, але зменшує потік приблизно з 30 Мбіт/с MJPEG до 2 Мбіт/с. WebRTC TCP/UDP `8555` не відкривається; LABA і Mainsail використовують MSE, HLS залишається fallback.
- Безпека залежить від своєчасного оновлення uStreamer/go2rtc та ізоляції API. Компрометація root або процесу go2rtc на Pi дає доступ до відеопотоку.
- Під час Bluetooth discovery пристрої поблизу можуть бачити активність адаптера, а LABA показує адміністратору знайдені імена/MAC. Pairing слід запускати лише на короткий час і фізично перевіряти вибрану колонку.
- Локальний медіапрогравач працює з правами користувача `korob`; не слід передавати йому довільні URL або аргументи через портал. Поточний агент надає тільки MPRIS play/pause/next/previous/stop.
- Кожен пристрій у домашній LAN може спробувати підключитися до WayVNC, тому пароль користувача Pi має бути унікальним і сильним. Захист від публічного доступу не замінює сегментацію недовірених IoT-пристроїв у LAN.
- noVNC надає адміністратору повний інтерактивний сеанс Pi. Компрометація активної Cloudflare/LABA-сесії адміністратора дозволяє відкрити VNC, але Raspberry Pi все одно вимагає окремі PAM-облікові дані.
- Локальний gRPC API Starlink не є офіційним стабільним публічним API, не має власної автентифікації та може змінитися разом із firmware. Його не можна маршрутизувати з інтернету або відкривати через Caddy/UFW; після оновлення тарілки треба перевіряти read-only telemetry перед виконанням команд. У bypass-режимі router/Wi-Fi telemetry відсутня; стан вкладки роутера в LABA визначається тільки з уже отриманого `downstreamRouters`, без додаткового probe. Поточна firmware політикою забороняє точні координати; LABA не намагається обходити цю заборону.

## Секрети

Не комітити й не копіювати у звіти:

- `/opt/laba/.env`;
- `/opt/laba/data/portal.db*` і backups;
- `/etc/caddy/certs/laba-*`;
- SSH, Cloudflare, Tailscale і device credentials.
- `/etc/credstore.encrypted/go2rtc-api-password` та розшифрований runtime credential go2rtc.
- `/etc/credstore.encrypted/laba-audio-agent-token`, `AUDIO_AGENT_TOKEN` у `/opt/laba/.env` і будь-яка тимчасова plaintext-копія токена.
- `/etc/credstore.encrypted/laba-starlink-agent-token`, `STARLINK_AGENT_TOKEN` у `/opt/laba/.env` і будь-яка тимчасова plaintext-копія токена.

Ротація `DEVICE_SECRET_KEY` потребує розшифрувати й повторно зашифрувати збережені device secrets. Проста заміна ключа зробить їх нечитабельними.
