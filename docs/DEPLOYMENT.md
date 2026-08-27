# VPS deployment

## Контур

- каталог: `/opt/laba`;
- пользователь/group: `laba:laba`;
- service: `laba-portal.service`;
- upstream: `127.0.0.1:3020`;
- база: `/opt/laba/data/portal.db`;
- reverse proxy: существующий Caddy;
- LAN route: Tailscale subnet `192.168.0.0/24` через Raspberry Pi.

Не перезаписывать существующий Caddyfile целиком и не менять работающие `koro-*` или Signal services.

## Подготовка Cloudflare

1. DNS: proxied A/AAAA для `laba` и proxied wildcard `*.laba` на origin VPS.
2. SSL/TLS: Full (strict).
3. Origin Server: сертификат на `laba.zpseapil.club` и `*.laba.zpseapil.club`, срок 15 лет.
4. Access: Self-hosted application для root и wildcard. Политика Allow — только нужные identities, желательно с MFA.
5. Скопировать Access application audience (AUD) и team domain в server `.env`.

Если root и wildcard пришлось создать двумя Access applications, `CF_ACCESS_AUD` принимает обе audience через запятую.

## Первая установка

```bash
set -Eeuo pipefail
useradd --system --home /opt/laba --shell /usr/sbin/nologin laba
install -d -o root -g laba -m 0750 /opt/laba
install -d -o laba -g laba -m 0700 /opt/laba/data
```

Загрузить исходники без `.git`, `.env`, `node_modules`, data и certs, затем:

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

Секреты генерируются непосредственно на VPS:

```bash
openssl rand -base64 48
openssl rand -base64 32
```

Первое значение — `SESSION_SECRET`, второе — `DEVICE_SECRET_KEY`. `BOOTSTRAP_ADMIN_EMAIL` должен точно совпадать с e-mail Cloudflare Access.

## Caddy

Установить origin certificate в `/etc/caddy/certs/laba-origin.pem`, ключ в `/etc/caddy/certs/laba-origin-key.pem`, владелец `root:caddy`, modes `640`. Добавить содержимое `deploy/Caddyfile.snippet` к существующей конфигурации.

Всегда:

```bash
cp --preserve=mode,ownership,timestamps /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-laba-$(date -u +%Y%m%d-%H%M%S)"
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
systemctl is-active --quiet caddy
```

## Обновление

Перед заменой кода:

```bash
set -Eeuo pipefail
install -d -o laba -g laba -m 0700 /opt/laba/backups
sudo -u laba sqlite3 /opt/laba/data/portal.db ".backup '/opt/laba/backups/portal-$(date -u +%Y%m%d-%H%M%S).db'"
systemctl stop laba-portal.service
```

После загрузки новой версии не заменять `.env`, `data/` и `backups/`:

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

## Проверки

```bash
systemctl status laba-portal.service --no-pager
curl --fail http://127.0.0.1:3020/healthz
tailscale ping pilaba4b-subnet
curl --max-time 5 http://192.168.0.70:7125/server/info
caddy validate --config /etc/caddy/Caddyfile
ufw status verbose
```

Для origin-проверки нужен действительный Access JWT; прямой запрос без него должен получить `401`, даже если обойти Cloudflare.

## Rollback

1. Остановить `laba-portal.service`.
2. Вернуть предыдущую копию исходников, не трогая `.env`.
3. При необходимости заменить `portal.db` сохранённым backup вместе с соответствующими WAL/SHM только при остановленном сервисе.
4. `npm ci --omit=dev`, `npm run check`, затем запустить сервис и проверить health.

Удаление LABA не должно затрагивать `/opt/koro-*`, `/opt/signal-api`, их units или Caddy blocks.
