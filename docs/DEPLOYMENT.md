# VPS deployment

## Контур

- каталог: `/opt/laba`;
- користувач/group: `laba:laba`;
- service: `laba-portal.service`;
- upstream: `127.0.0.1:3020`;
- база: `/opt/laba/data/portal.db`;
- reverse proxy: наявний Caddy;
- LAN route: Tailscale subnet `192.168.0.0/24` через Raspberry Pi.

Не перезаписувати наявний Caddyfile повністю й не змінювати працюючі `koro-*` або Signal services.

## Підготовка Cloudflare

1. DNS: proxied A/AAAA для `laba` і proxied wildcard `*` на origin VPS. Точні наявні записи (`star`, `task`, `scan` та інші) зберігають пріоритет.
2. SSL/TLS: Full (strict).
3. Origin Server: сертифікат для `*.zpseapil.club` і `zpseapil.club`, строк 15 років.
4. Access: Self-hosted application для `laba.zpseapil.club` і `*-laba.zpseapil.club` з login methods Cloudflare та One-time PIN.
5. Створити Allow policy `LABA authenticated users` із двома Include-правилами (OR): точний e-mail bootstrap-адміністратора і `Login Methods: One-time PIN`. Application має приймати обидва доступні identity provider.
6. Скопіювати Access application audience (AUD) і team domain у server `.env`.

Якщо portal і device hosts довелося створити двома Access applications, `CF_ACCESS_AUD` приймає обидві audience через кому.

Приватний ключ Origin Certificate створюється лише на VPS. У Cloudflare вибрати **Use my private key and CSR**, передати CSR і зберегти виданий публічний сертифікат як `/etc/caddy/certs/laba-origin.pem`:

```bash
install -d -o root -g caddy -m 0750 /etc/caddy/certs
umask 027
openssl genrsa -out /etc/caddy/certs/laba-origin-key.pem 2048
openssl req -new \
  -key /etc/caddy/certs/laba-origin-key.pem \
  -out /tmp/laba-origin.csr \
  -subj '/CN=*.zpseapil.club' \
  -addext 'subjectAltName=DNS:*.zpseapil.club,DNS:zpseapil.club'
chown root:caddy /etc/caddy/certs/laba-origin-key.pem
chmod 0640 /etc/caddy/certs/laba-origin-key.pem
```

Після встановлення сертифіката перевірити збіг публічних ключів сертифіката і private key, потім видалити тимчасовий CSR. Private key не можна вставляти в Cloudflare, консоль, логи або Git.

## Перше встановлення

```bash
set -Eeuo pipefail
useradd --system --home /opt/laba --shell /usr/sbin/nologin laba
install -d -o root -g laba -m 0750 /opt/laba
install -d -o laba -g laba -m 0700 /opt/laba/data
```

Завантажити вихідні файли без `.git`, `.env`, `node_modules`, data і certs, потім:

```bash
cd /opt/laba
npm ci --omit=dev
npm run check
chown -R root:laba /opt/laba
chown -R laba:laba /opt/laba/data
chmod 0750 /opt/laba
chmod 0700 /opt/laba/data
chmod 0600 /opt/laba/.env
cp deploy/laba-portal.service /etc/systemd/system/laba-portal.service
systemctl daemon-reload
systemctl enable --now laba-portal.service
curl --fail --silent http://127.0.0.1:3020/healthz
```

Секрети генеруються безпосередньо на VPS:

```bash
openssl rand -base64 48
openssl rand -base64 32
```

Перше значення — `SESSION_SECRET`, друге — `DEVICE_SECRET_KEY`. `BOOTSTRAP_ADMIN_EMAIL` має точно збігатися з e-mail Cloudflare Access.

Після запуску нові користувачі додаються лише через `/admin`: e-mail, роль і призначення пристроїв зберігаються в локальній базі. Access policy для кожного користувача змінювати не потрібно. One-time PIN підтверджує володіння e-mail, а локальний allowlist LABA залишається авторитетним рішенням щодо доступу.

## Caddy

Встановити origin certificate у `/etc/caddy/certs/laba-origin.pem`, ключ у `/etc/caddy/certs/laba-origin-key.pem`, власник `root:caddy`, modes `640`. Додати вміст `deploy/Caddyfile.snippet` до наявної конфігурації.

Завжди:

```bash
cp --preserve=mode,ownership,timestamps /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-laba-$(date -u +%Y%m%d-%H%M%S)"
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
systemctl is-active --quiet caddy
```

## Оновлення

Перед заміною коду:

```bash
set -Eeuo pipefail
install -d -o laba -g laba -m 0700 /opt/laba/backups
sudo -u laba sqlite3 /opt/laba/data/portal.db ".backup '/opt/laba/backups/portal-$(date -u +%Y%m%d-%H%M%S).db'"
systemctl stop laba-portal.service
```

Після завантаження нової версії не замінювати `.env`, `data/` і `backups/`:

```bash
cd /opt/laba
npm ci --omit=dev
npm run check
chown -R root:laba /opt/laba
chown -R laba:laba /opt/laba/data /opt/laba/backups
systemctl start laba-portal.service
curl --fail --silent http://127.0.0.1:3020/healthz
journalctl -u laba-portal.service -n 80 --no-pager
```

Версія `0.5.0` додає `devices.stream_mode` і `devices.parent_device_id` до створеної у `0.4.0` колонки `devices.stream_name`. Перед першим запуском цієї версії SQLite backup обов’язковий. Міграція не змінює наявні пристрої та не перебудовує таблицю.

Версія `0.6.0` не змінює схему БД. Вона переводить USB-камеру принтера на low-latency H.264, додає захищений same-origin MSE player під service-worker-safe префіксом `/webcam` і HLS fallback для Mainsail та підключає окремий H.264 RTSP-потік камери відеоспостереження.

Версія `0.7.0` не змінює схему БД. Вона додає адміністративний розділ Bluetooth/Audio та приватний audio agent на Raspberry Pi. Agent доступний лише VPS через Tailscale, вимагає окремий bearer credential і надає тільки allowlisted операції BlueZ, PipeWire та MPRIS.

Версія `0.8.0` не змінює схему БД. Вона додає локальний WayVNC на `192.168.0.63:5900` та admin-only noVNC у LABA. Пакет `@novnc/novnc` pinned до `1.7.0`; WebSocket-шлюз websockify слухає лише `127.0.0.1:6080` на VPS.

Версія `0.8.1` не змінює схему БД. Вона монтує модулі noVNC через явний файловий route, щоб загальний SPA fallback порталу ніколи не повертав HTML замість JavaScript-модуля.

Версія `0.8.2` не змінює схему БД. Вона виправляє нульову висоту внутрішнього viewport noVNC та встановлює перевірену збірку WayVNC `0.9.1-1+rpt5`, яка починає capture для headless-виходу labwc зі станом живлення `UNKNOWN`.

Версія `0.9.0` не змінює схему БД. Вона додає локальний адаптивний детектор подвійного хлопка з USB-мікрофона Logitech C270. Два імпульси з інтервалом `0,16–0,90` секунди виконують MPRIS `play-pause`; після спрацювання діє двосекундний cooldown.

Версія `0.10.0` не змінює схему БД. Вона розрізняє подвійний і потрійний хлопки: подвійний виконує `play-pause`, а потрійний приглушує активний MPRIS-програвач до 35%, відтворює локальний WAV «Бажаю здоров'я!» та в `finally` повертає точну попередню гучність.

Версія `0.10.1` звужує ритм жесту до `0,35–0,80` секунди та додає часово-спектральний anti-spark фільтр, щоб подвійний розряд електричної мухобойки не виконував `play-pause`.

Версія `0.11.0` не змінює схему БД. Вона додає admin-only вкладку Starlink, 15-хвилинну телеметрію та карту перешкод, а також приватний Starlink agent на Raspberry Pi. Agent використовує pinned `grpcurl` для локального endpoint тарілки, доступний лише VPS через Tailscale і проксіює тільки фіксований безпечний список операцій.

Версія `0.11.1` не змінює схему БД. Вона посилює фільтр хлопків за фактичним профілем нічних хибних спрацювань: у жест потрапляють тільки сильні короткі транзієнти, а слабкі широкі ритмічні імпульси від музики, колонок або обладнання не формують подвійний чи потрійний хлопок.

Версія `0.12.0` не змінює схему БД. Вона переводить режим підігріву у read-only, оскільки Starlink дозволяє змінювати його лише власнику акаунта у фірмовому застосунку. Також додається заготовка вкладки фірмового роутера: доступність визначається з уже отримуваного `downstreamRouters` у телеметрії тарілки, без окремого ping, фонового процесу або додаткового мережевого опитування. У bypass-режимі вкладка сіра й недоступна.

Версія `0.12.1` не змінює схему БД. Вона уточнює, що журнал Starlink містить до 30 останніх мережевих подій, а не лише події 15-хвилинного графіка, показує для кожного запису дату й час та перекладає актуальні `OUTAGE_*`/packet-loss причини. Кнопка застосування режиму сну перенесена на окремий рядок і більше не виходить за межі картки.

Версія `0.12.2` не змінює схему БД. Вона розширює ритмічне вікно детектора хлопків до `0,18–0,90` секунди, щоб швидкий природний подвійний хлопок не втрачався. Спектральний і transient-shape фільтри електричної мухобойки залишаються активними; регресійні тести покривають швидкий і повільний людський ритм, коротку дугу та нічну ритмічну перешкоду.

Версія `0.13.0` не змінює схему БД. Вона додає в аудіовкладку вимикач детектора, повзунок чутливості `30–80%` і повзунок максимальної паузи `350–1500` мс. Налаштування передаються через окремий authenticated endpoint, перевіряються повторно на portal і Pi, записуються атомарно до `/var/lib/laba-audio-agent/clap-config.json` з mode `0600` та застосовуються без restart. Unit використовує приватний `StateDirectory=laba-audio-agent`.

## Робочий стіл Raspberry Pi

WayVNC уже входить до Raspberry Pi OS. З VPS скопіювати конфігурації та browser-only unit на Pi:

```bash
scp /opt/laba/deploy/desktop/wayvnc-config \
  /opt/laba/deploy/desktop/wayvnc-web-config \
  /opt/laba/deploy/desktop/laba-wayvnc-web.service \
  /opt/laba/deploy/desktop/laba-wayvnc-attach.py \
  /opt/laba/deploy/desktop/laba-wayvnc-attach.service \
  /opt/laba/deploy/desktop/wayvnc-power-unknown.patch \
  /opt/laba/deploy/desktop/wayvnc-patched-binary.conf \
  /opt/laba/scripts/build-wayvnc-pi.sh \
  korob@192.168.0.63:/tmp/
```

На Pi спочатку зібрати й встановити зафіксовану patched-версію WayVNC. Скрипт завантажує exact Raspberry Pi source package, перевіряє SHA-256 усіх архівів, застосовує єдиний patch і встановлює binary у `/usr/local/lib/laba/wayvnc`:

```bash
sudo /bin/sh /tmp/build-wayvnc-pi.sh /tmp/wayvnc-power-unknown.patch
```

Потім встановити exact LAN-конфігурацію та запустити vendor і LABA services. Приватні ключі й сертифікат генерує `wayvnc-generate-keys.service` безпосередньо на Pi:

```bash
sudo install -d -o root -g root -m 0755 /etc/wayvnc
sudo install -o root -g root -m 0644 /tmp/wayvnc-config /etc/wayvnc/config
sudo install -o root -g root -m 0644 /tmp/wayvnc-web-config /etc/wayvnc/laba-web-config
sudo install -o root -g root -m 0644 /tmp/laba-wayvnc-web.service /etc/systemd/system/laba-wayvnc-web.service
sudo install -o root -g root -m 0755 /tmp/laba-wayvnc-attach.py /usr/local/lib/laba-wayvnc-attach.py
sudo install -o root -g root -m 0644 /tmp/laba-wayvnc-attach.service /etc/systemd/system/laba-wayvnc-attach.service
sudo install -d -o root -g root -m 0755 /etc/systemd/system/wayvnc.service.d
sudo install -o root -g root -m 0644 /tmp/wayvnc-patched-binary.conf /etc/systemd/system/wayvnc.service.d/10-laba-patched-binary.conf
sudo systemd-analyze verify /etc/systemd/system/laba-wayvnc-web.service
sudo systemd-analyze verify /etc/systemd/system/laba-wayvnc-attach.service
sudo systemctl daemon-reload
sudo systemctl enable --now wayvnc.service laba-wayvnc-web.service laba-wayvnc-attach.service
sudo rm -- /tmp/wayvnc-config /tmp/wayvnc-web-config /tmp/laba-wayvnc-web.service \
  /tmp/laba-wayvnc-attach.py /tmp/laba-wayvnc-attach.service \
  /tmp/wayvnc-power-unknown.patch /tmp/wayvnc-patched-binary.conf \
  /tmp/build-wayvnc-pi.sh
systemctl is-active wayvnc.service laba-wayvnc-web.service laba-wayvnc-attach.service
ss -lnt | grep '192.168.0.63:5900'
ss -lnt | grep '192.168.0.63:5901'
sudo -u vnc wayvncctl --socket=/run/laba-wayvnc-web/wayvncctl.sock output-list
```

На VPS встановити websockify та unit. Порт `6080` залишається loopback, тому Caddy/UFW не змінюються:

```bash
apt-get install --yes websockify
install -o root -g root -m 0644 \
  /opt/laba/deploy/desktop/laba-desktop-gateway.service \
  /etc/systemd/system/laba-desktop-gateway.service
systemd-analyze verify /etc/systemd/system/laba-desktop-gateway.service
systemctl daemon-reload
systemctl enable --now laba-desktop-gateway.service
systemctl is-active laba-desktop-gateway.service
ss -lnt | grep '127.0.0.1:6080'
```

`DESKTOP_GATEWAY_URL` може бути відсутнім у production `.env`: безпечне значення за замовчуванням — `http://127.0.0.1:6080`. Якщо змінну вказано, LABA приймає лише HTTP origin на `127.0.0.1` без credentials/path/query/fragment. З VPS перевірити RFB-банер і переконатися, що порти не публікуються:

```bash
timeout 5 bash -c 'exec 3<>/dev/tcp/192.168.0.63/5900; head -c 12 <&3'
timeout 5 bash -c 'exec 3<>/dev/tcp/192.168.0.63/5901; head -c 12 <&3'
ss -lnt | grep -E '(:5900|:5901|:6080)'
ufw status verbose
```

Очікується `RFB 003.008` від обох endpoint’ів Pi, непорожній `output-list` для browser WayVNC та лише `127.0.0.1:6080` на VPS. Локальний клієнт використовує TLS/PAM `192.168.0.63:5900`; browser-only `5901` приймає лише VPS і ніколи не використовується напряму з LAN. Другий WayVNC запускається без `--gpu`, щоб не конфліктувати з апаратним H.264 encoder vendor WayVNC. З інтернету адміністратор відкриває `/admin` → «Робочий стіл». VNC-користувач — `korob`; пароль не зберігається в LABA.

## Bluetooth/Audio agent на Raspberry Pi

Agent працює як `laba-audio-agent.service` від користувача `korob`, слухає лише `100.69.168.10:1985` і приймає запити лише від VPS `100.68.61.33`. Plaintext-токен потрібен тільки під час первинного зв’язування; на Pi постійно зберігається зашифрований systemd credential.

Спочатку з VPS скопіювати файли до Pi:

```bash
scp /opt/laba/deploy/audio/laba-audio-agent.py \
  /opt/laba/deploy/audio/laba_clap_detector.py \
  /opt/laba/deploy/audio/assets/bazhaju-zdorovya.wav \
  /opt/laba/deploy/audio/laba-audio-agent.service \
  /opt/laba/deploy/audio/provision-token.py \
  korob@192.168.0.63:/tmp/
```

На Raspberry Pi встановити agent і створити credential:

```bash
sudo apt-get update
sudo apt-get install --yes playerctl
sudo install -d -o root -g root -m 0755 /opt/laba-audio-agent
sudo install -o root -g root -m 0755 /tmp/laba-audio-agent.py /opt/laba-audio-agent/laba-audio-agent.py
sudo install -o root -g root -m 0644 /tmp/laba_clap_detector.py /opt/laba-audio-agent/laba_clap_detector.py
sudo install -o root -g root -m 0644 /tmp/bazhaju-zdorovya.wav /opt/laba-audio-agent/bazhaju-zdorovya.wav
sudo install -o root -g root -m 0644 /tmp/laba-audio-agent.service /etc/systemd/system/laba-audio-agent.service
sudo rfkill unblock bluetooth
sudo python3 /tmp/provision-token.py
sudo systemd-analyze verify /etc/systemd/system/laba-audio-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now laba-audio-agent.service
systemctl is-active laba-audio-agent.service
```

Після успішного запуску з VPS перенести тимчасовий токен у `.env` без друку значення:

```bash
scp korob@192.168.0.63:/tmp/laba-audio-agent-token /tmp/laba-audio-agent-token
node /opt/laba/scripts/configure-audio-agent.mjs /tmp/laba-audio-agent-token
rm -- /tmp/laba-audio-agent-token
ssh korob@192.168.0.63 'sudo rm -f /tmp/laba-audio-agent-token /tmp/laba-audio-agent.py /tmp/laba_clap_detector.py /tmp/bazhaju-zdorovya.wav /tmp/laba-audio-agent.service /tmp/provision-token.py'
systemctl restart laba-portal.service
systemctl is-active laba-portal.service
```

`configure-audio-agent.mjs` додає точний `AUDIO_AGENT_URL=http://100.69.168.10:1985`, записує bearer у `AUDIO_AGENT_TOKEN` і залишає `/opt/laba/.env` з mode `0600`. Production-валидація не дозволяє запустити LABA 0.7.0 без цих двох параметрів.

Перевірки з VPS не повинні виводити credential:

```bash
node --env-file=/opt/laba/.env -e "fetch(process.env.AUDIO_AGENT_URL + '/v1/status', { headers: { Authorization: 'Bearer ' + process.env.AUDIO_AGENT_TOKEN } }).then(async (response) => { console.log(response.status); const status = await response.json(); console.log(JSON.stringify({ adapter: status.adapter, audio: status.audio, player: status.player }, null, 2)); }).catch((error) => { console.error(error.message); process.exit(1); })"
```

Очікується HTTP `200`, `adapter.available: true` і `audio.available: true`. `player.available: false` є нормальним станом, доки на Pi не запущено MPRIS-сумісний програвач. Порт `1985` не відкривати в LAN/UFW і не проксіювати через Caddy.

## Starlink agent на Raspberry Pi

Starlink Mini працює в bypass-режимі. Raspberry Pi має прямий маршрут до локального endpoint тарілки `192.168.100.1:9200`; вимкнений Starlink Router у схемі не бере участі. Перед встановленням перевірити маршрут без внесення змін:

```bash
ping -c 3 192.168.100.1
timeout 3 bash -c 'exec 3<>/dev/tcp/192.168.100.1/9200'
```

Agent працює як `laba-starlink-agent.service` від користувача `korob`, слухає лише `100.69.168.10:1986` і приймає запити лише від VPS `100.68.61.33`. Спочатку з VPS скопіювати файли до Pi:

```bash
scp /opt/laba/deploy/starlink/laba-starlink-agent.py \
  /opt/laba/deploy/starlink/laba_starlink_model.py \
  /opt/laba/deploy/starlink/laba-starlink-agent.service \
  /opt/laba/deploy/starlink/install-grpcurl.sh \
  korob@192.168.0.63:/tmp/
scp /opt/laba/deploy/starlink/provision-token.py \
  korob@192.168.0.63:/tmp/laba-starlink-provision-token.py
```

На Raspberry Pi встановити exact `grpcurl 1.9.3` для Linux ARM64. Скрипт завантажує офіційний архів лише через HTTPS та перевіряє SHA-256 `b20a00c1cb82ab81ec32696766d4076e99b4cb5ca0823a71767ba64dbea0f263`:

```bash
sudo /bin/sh /tmp/install-grpcurl.sh
sudo install -d -o root -g root -m 0755 /opt/laba-starlink-agent
sudo install -o root -g root -m 0755 /tmp/laba-starlink-agent.py /opt/laba-starlink-agent/laba-starlink-agent.py
sudo install -o root -g root -m 0644 /tmp/laba_starlink_model.py /opt/laba-starlink-agent/laba_starlink_model.py
sudo install -o root -g root -m 0644 /tmp/laba-starlink-agent.service /etc/systemd/system/laba-starlink-agent.service
sudo python3 /tmp/laba-starlink-provision-token.py
sudo systemd-analyze verify /etc/systemd/system/laba-starlink-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now laba-starlink-agent.service
systemctl is-active laba-starlink-agent.service
ss -lnt | grep '100.69.168.10:1986'
```

Після успішного запуску з VPS перенести тимчасовий token у `.env`, не виводячи його значення, і видалити plaintext-копії:

```bash
scp korob@192.168.0.63:/tmp/laba-starlink-agent-token /tmp/laba-starlink-agent-token
node /opt/laba/scripts/configure-starlink-agent.mjs /tmp/laba-starlink-agent-token
rm -- /tmp/laba-starlink-agent-token
ssh korob@192.168.0.63 'sudo rm -f /tmp/laba-starlink-agent-token /tmp/laba-starlink-agent.py /tmp/laba_starlink_model.py /tmp/laba-starlink-agent.service /tmp/install-grpcurl.sh /tmp/laba-starlink-provision-token.py'
systemctl restart laba-portal.service
systemctl is-active laba-portal.service
```

`configure-starlink-agent.mjs` додає `STARLINK_AGENT_URL=http://100.69.168.10:1986`, записує bearer у `STARLINK_AGENT_TOKEN` і залишає `/opt/laba/.env` з mode `0600`. Production-валидація не дозволяє запустити LABA `0.11.0` без цих параметрів. Read-only перевірка з VPS:

```bash
node --env-file=/opt/laba/.env -e "fetch(process.env.STARLINK_AGENT_URL + '/v1/status', { headers: { Authorization: 'Bearer ' + process.env.STARLINK_AGENT_TOKEN } }).then(async (response) => { const status = await response.json(); console.log(response.status); console.log(JSON.stringify({ connected: status.connected, state: status.state, model: status.device?.hardwareVersion, bypass: status.device?.bypassMode, pingMs: status.network?.pingMs, obstructionPercent: status.obstruction?.fractionPercent }, null, 2)); if (!response.ok) process.exit(1); }).catch((error) => { console.error(error.message); process.exit(1); })"
```

Очікується HTTP `200`, `connected: true`, `bypass: true`. Порт `1986` не відкривати в LAN/UFW і не проксіювати через Caddy. Локальний gRPC API Starlink не є офіційним стабільним API; після оновлення firmware спочатку перевіряти лише status/map. Точні координати на поточній firmware заборонені політикою, а Starlink Mini не має приводів, тому LABA приховує stow/unstow.

## go2rtc на Raspberry Pi

Підготовлена конфігурація використовує go2rtc `v1.9.14` для Linux ARM64. Бінарний файл pinned за SHA-256:

```text
359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50
```

Джерело — Logitech C270 з постійним udev path `/dev/v4l/by-id/usb-046d_C270_HD_WEBCAM_200901010001-video-index0`. `laba-ustreamer.service` захоплює hardware MJPEG 1280×720@30, вимикає динамічне зниження FPS і слухає тільки loopback `127.0.0.1:8080`. `laba-h264-encoder.service` кодує browser-compatible H.264 Constrained Baseline 1280×720@25 приблизно у 2 Мбіт/с через `libx264 ultrafast/zerolatency`, використовує GOP 13, повторює SPS/PPS на кожному ключовому кадрі та слухає тільки `127.0.0.1:8556`. Це свідомий вибір: Raspberry Pi `h264_v4l2m2m` скидає GOP до 60 кадрів і не дає стабільно сформувати короткі декодовані HLS-сегменти. MJPEG залишається другим codec source тільки для snapshot і резервної сумісності.

Сервіси навмисно не мають жорсткого `Requires=` між USB-захопленням, H.264-кодером і go2rtc. Після холодного старту USB-камера може з'явитися пізніше за `multi-user.target`: uStreamer продовжує повторні спроби, FFmpeg окремо повторює підключення до loopback-джерела, а go2rtc одразу лишається доступним для незалежної IP-камери. `StartLimitIntervalSec=0` і `Restart=always` не дають разовій помилці порядку запуску залишити відео вимкненим до ручного рестарту.

Підготовлені файли:

- `deploy/go2rtc/laba-ustreamer.service` — захоплення C270 через hardware MJPEG без мережевої публікації;
- `deploy/go2rtc/laba-h264-encoder.service` — low-latency H.264-кодування в sandboxed FFmpeg без доступу до відеопристроїв;
- `deploy/go2rtc/go2rtc.yaml` — API тільки на Tailscale IP Pi `100.69.168.10:1984`, exact allowlist endpoint’ів, без WebUI, RTSP-server, WebRTC, exec і вбудованого ffmpeg;
- `deploy/go2rtc/go2rtc.service` — DynamicUser, encrypted credentials, IP-фільтр і systemd sandbox;
- назви потоків — `printer-usb-camera` і `labacam-01`;
- API user — `laba-vps`;
- секрети — `GO2RTC_API_PASSWORD` у `/etc/credstore.encrypted/go2rtc-api-password` і `LABACAM_PASSWORD` у `/etc/credstore.encrypted/labacam-password`.

systemd створює для unit приватний `CREDENTIALS_DIRECTORY`; go2rtc при його наявності сам підставляє `${GO2RTC_API_PASSWORD}` і `${LABACAM_PASSWORD}` з однойменних credential-файлів. Дублювати секрети у `Environment=`, YAML або wrapper script не потрібно.

Встановлення на Pi виконується від root:

```bash
apt-get install --yes ustreamer v4l-utils ffmpeg curl jq
curl --fail --location --output /tmp/go2rtc_linux_arm64 \
  https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_arm64
echo '359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50  /tmp/go2rtc_linux_arm64' | sha256sum --check
install -o root -g root -m 0755 /tmp/go2rtc_linux_arm64 /usr/local/bin/go2rtc
install -d -o root -g root -m 0755 /etc/go2rtc /etc/credstore.encrypted
install -o root -g root -m 0644 deploy/go2rtc/go2rtc.yaml /etc/go2rtc/go2rtc.yaml
install -o root -g root -m 0644 deploy/go2rtc/laba-ustreamer.service /etc/systemd/system/laba-ustreamer.service
install -o root -g root -m 0644 deploy/go2rtc/laba-h264-encoder.service /etc/systemd/system/laba-h264-encoder.service
install -o root -g root -m 0644 deploy/go2rtc/go2rtc.service /etc/systemd/system/go2rtc.service
openssl rand -base64 36 | systemd-creds encrypt --name=GO2RTC_API_PASSWORD - /etc/credstore.encrypted/go2rtc-api-password
read -rsp 'Пароль admin камери відеоспостереження: ' LABACAM_PASSWORD
printf '%s' "$LABACAM_PASSWORD" | systemd-creds encrypt --name=LABACAM_PASSWORD - /etc/credstore.encrypted/labacam-password
unset LABACAM_PASSWORD
echo
rm -- /tmp/go2rtc_linux_arm64
systemctl daemon-reload
systemctl enable --now laba-ustreamer.service laba-h264-encoder.service go2rtc.service
```

До production `ALLOWED_DEVICE_SUBNETS` додається лише `100.69.168.10/32`, не весь CGNAT-діапазон `100.64.0.0/10`. У LABA камера принтера має slug `k1se-camera`, host `100.69.168.10`, port `1984`, stream `printer-usb-camera`, mode `auto` і parent `Creality K1 SE`. Slug `labacam` використовує окремий H.264-потік `labacam-01` і не має parent. Пароль go2rtc зберігається в AES-256-GCM secret LABA.

Під час первинного налаштування пароль gateway тимчасово передається на VPS у root-only файл на tmpfs і читається deployment-скриптом без потрапляння до argv або shell history:

```bash
GO2RTC_API_PASSWORD_FILE=/run/laba-go2rtc-api-password \
  node --env-file=/opt/laba/.env /opt/laba/scripts/configure-usb-camera.mjs
shred --remove --zero /run/laba-go2rtc-api-password
```

Для наступних оновлень уже наявної `k1se-camera` достатньо запустити скрипт без `GO2RTC_API_PASSWORD_FILE`; він збереже поточний AES-256-GCM secret і оновить лише несекретні параметри камери:

```bash
node --env-file=/opt/laba/.env /opt/laba/scripts/configure-usb-camera.mjs
```

Moonraker/Mainsail вбудовує low-latency MSE player дочірньої LABA-камери на тому самому origin принтера. Шлях `/webcam/laba/player` не перехоплюється navigation fallback service worker Mainsail, а CSP і `X-Frame-Options: SAMEORIGIN` дозволяють лише потрібний same-origin iframe. Оновлювати слід наявний database webcam за `uid`, щоб не створити дублікат:

```bash
CAM_UID="$(curl --fail --silent http://192.168.0.70:7125/server/webcams/list | jq -r '.result.webcams[] | select(.name == "LABA USB Camera") | .uid' | head -n 1)"
test -n "$CAM_UID"
jq -nc --arg uid "$CAM_UID" '{uid:$uid,name:"LABA USB Camera",location:"printer",service:"iframe",enabled:true,target_fps:25,target_fps_idle:5,stream_url:"/webcam/laba/player",snapshot_url:"/laba-camera/snapshot",flip_horizontal:false,flip_vertical:false,rotation:0,aspect_ratio:"16:9"}' \
  | curl --fail --request POST http://192.168.0.70:7125/server/webcams/item \
      --header 'Content-Type: application/json' --data-binary @-
unset CAM_UID
```

Перевірки до ввімкнення пристрою в адмінпанелі:

```bash
systemd-analyze verify /etc/systemd/system/go2rtc.service
systemd-analyze verify /etc/systemd/system/laba-ustreamer.service
systemd-analyze verify /etc/systemd/system/laba-h264-encoder.service
systemctl status laba-ustreamer.service --no-pager
systemctl status laba-h264-encoder.service --no-pager
systemctl status go2rtc.service --no-pager
ss -lntp | grep '127.0.0.1:8080'
ss -lntp | grep '127.0.0.1:8556'
ss -lntp | grep '100.69.168.10:1984'
journalctl -u laba-ustreamer.service -u laba-h264-encoder.service -u go2rtc.service -n 80 --no-pager
```

На VPS перевірити, що API без Basic Auth повертає `401`, а WebUI та config endpoint не відкриті. Не додавати UFW-правило для `1984`, `554`, `8554` або `8555` на VPS чи Archer.

## Перевірки

```bash
systemctl status laba-portal.service --no-pager
curl --fail http://127.0.0.1:3020/healthz
tailscale ping pilaba4b-subnet
curl --max-time 5 http://192.168.0.70:7125/server/info
caddy validate --config /etc/caddy/Caddyfile
ufw status verbose
```

Для origin-перевірки потрібен дійсний Access JWT; прямий запит без нього має отримати `401`, навіть якщо обійти Cloudflare.

## Rollback

1. Зупинити `laba-portal.service`.
2. Повернути попередню копію вихідних файлів, не змінюючи `.env`.
3. За потреби замінити `portal.db` збереженим backup разом із відповідними WAL/SHM лише при зупиненому сервісі.
4. `npm ci --omit=dev`, `npm run check`, потім запустити сервіс і перевірити health.

Видалення LABA не має зачіпати `/opt/koro-*`, `/opt/signal-api`, їхні units або Caddy blocks.
