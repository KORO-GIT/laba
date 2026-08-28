# AGENTS.md

Правила для агента, який продовжує розробку LABA.

## Перед початком

1. Прочитати `README.md`, `docs/SECURITY.md` і `docs/DEPLOYMENT.md`.
2. Перевірити `git status --short`; чужі зміни не видаляти.
3. Не читати й не друкувати production-секрети без потреби. Ніколи не комітити `.env`, SQLite, сертифікати, ключі, логи та резервні копії.
4. Поточний VPS містить інші production-сервіси. Не змінювати їхні каталоги, units, бази та процеси.

## Перевірки

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
```

## Інваріанти безпеки

- Production запускається лише з `AUTH_MODE=cloudflare`.
- JWT Cloudflare Access завжди перевіряється за підписом, issuer та audience.
- Користувач має одночасно пройти Cloudflare Access і бути присутнім у локальному allowlist.
- Адреса пристрою має бути literal IPv4 з `ALLOWED_DEVICE_SUBNETS`; DNS-імена не дозволяти, щоб не відкрити SSRF.
- Секрети пристроїв шифруються AES-256-GCM. Не створювати другий механізм шифрування.
- В upstream не передаються Cloudflare assertion, Access cookie і користувацький `Authorization`.
- Не можна вимкнути останнього активного адміністратора.
- Усі state-changing admin API перевіряють Origin і маркер `X-Portal-Request`.
- Принтером може керувати лише `operator` або `admin`; `viewer` бачить статус.

## Production

- Сервис: `laba-portal.service`.
- Користувач: `laba`.
- Каталог: `/opt/laba`.
- Upstream: `127.0.0.1:3020`.
- Не замінювати `/etc/caddy/Caddyfile` повністю. Лише додати/змінити окремий LABA-блок, потім `caddy validate`, backup і `systemctl reload caddy`.
- Перед оновленням створити SQLite backup через `.backup`, потім перевірити health endpoint і останні логи.
- Не вмикати production `AUTH_MODE=development` навіть тимчасово.
