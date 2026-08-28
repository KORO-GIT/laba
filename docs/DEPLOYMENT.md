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
chmod 0640 /opt/laba/.env
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

Версія `0.4.0` автоматично додає nullable-колонку `devices.stream_name`. Перед першим запуском цієї версії SQLite backup обов’язковий. Міграція не змінює наявні пристрої та не перебудовує таблицю.

## go2rtc на Raspberry Pi

Підготовлена конфігурація використовує go2rtc `v1.9.14` для Linux ARM64. Бінарний файл pinned за SHA-256:

```text
359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50
```

Встановлення виконувати лише після визначення реального IP камери, RTSP path і перевірки потоку. RTSP URL з логіном і паролем не вводити в аргументи процесу, shell history, YAML або Git. Він має потрапити до encrypted systemd credential `CAMERA_RTSP_URL`.

Підготовлені файли:

- `deploy/go2rtc/go2rtc.yaml` — API тільки на Tailscale IP Pi `100.69.168.10:1984`, exact allowlist endpoint’ів, без WebUI, RTSP-server, WebRTC, exec і ffmpeg;
- `deploy/go2rtc/go2rtc.service` — DynamicUser, encrypted credentials, IP-фільтр і systemd sandbox;
- назва потоку — `camera-01`;
- API user — `laba-vps`;
- секрети — `GO2RTC_API_PASSWORD` і `CAMERA_RTSP_URL` у `/etc/credstore.encrypted/`.

systemd створює для unit приватний `CREDENTIALS_DIRECTORY`; go2rtc при його наявності сам підставляє `${GO2RTC_API_PASSWORD}` і `${CAMERA_RTSP_URL}` із однойменних credential-файлів. Дублювати секрети в `Environment=`, YAML або wrapper script не потрібно.

Після встановлення gateway до production `ALLOWED_DEVICE_SUBNETS` треба додати лише `100.69.168.10/32`, не весь CGNAT-діапазон `100.64.0.0/10`. У LABA пристрій налаштовується як камера go2rtc з host `100.69.168.10`, port `1984`, stream `camera-01`. Пароль go2rtc зберігається в AES-256-GCM secret LABA; пароль камери в LABA не копіюється.

Перевірки до ввімкнення пристрою в адмінпанелі:

```bash
systemd-analyze verify /etc/systemd/system/go2rtc.service
systemctl status go2rtc.service --no-pager
ss -lntp | grep '100.69.168.10:1984'
journalctl -u go2rtc.service -n 50 --no-pager
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
