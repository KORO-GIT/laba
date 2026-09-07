# AGENTS.md

Правила для агента, який продовжує розробку LABA.

## ERP / Виробництво

Нова ERP розробляється в `codex/laba-erp`. Перед її продовженням прочитати `docs/ERP.md` та `docs/ERP_CONTINUATION.md`; там вказані перевірки, обмеження й точний стан розробки. `docs/CURRENT_STATE.md` залишається джерелом підтвердженого production. Дизайн ERP: темна графітово-помаранчева LABA за замовчуванням і перемикач світлої теми. Власник вимагає регулярно push коду й детального handoff у Git; секрети та реальні дані не комітити.

## Перед початком

1. Повністю прочитати `README.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md` і `docs/CURRENT_STATE.md`.
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
- Редактор `/admin` → `Дошки` зберігає workflow у `workflow_boards`, `workflow_lanes`, `workflow_source_statuses`, `workflow_card_statuses` і `workflow_card_labels`; призначення кількох статусів та кількох незалежних кольорових міток картці зберігаються відповідно в `maintenance_card_status_assignments` і `maintenance_card_label_assignments`. Не змішувати статуси роботи з мітками складності та не повертати назви колонок, відповідність статусів, кастомні статуси або мітки у hardcoded-константи.
- Системні ключі колонок незмінні, а головний адміністратор завжди має `admin` на кожній дошці. Зміна кінцевого статусу має скасувати лише застарілі pending outbox-дії, не створювати повторні дії для вже оброблених карток.
- Успішний ack accounting outbox одразу позначає картку вилученою з активної дошки, лише якщо вона досі перебуває в колонці з тим самим кінцевим статусом. Канбан оновлюється фоновим polling без кешу; не вимагати від користувача ручного reload.
- Статус `ВТРАЧЕНИЙ` належить workflow `service`. Під час синхронізації така картка показується як засіб `ТАРА`, але її `source_key`, координати рядка, номер борта та ідентифікатори не змінюються. Поле `report_number` редагується тільки в картках `Сервісу` й не повинно змішуватися з примітками.
- Усі state-changing admin API перевіряють Origin і маркер `X-Portal-Request`.
- Принтером може керувати лише `operator` або `admin`; `viewer` бачить статус.

## Production

- Сервіс: `laba-portal.service`.
- Користувач: `laba`.
- Каталог: `/opt/laba`.
- Upstream: `127.0.0.1:3020`.
- Не замінювати `/etc/caddy/Caddyfile` повністю. Лише додати/змінити окремий LABA-блок, потім `caddy validate`, backup і `systemctl reload caddy`.
- Перед оновленням створити SQLite backup через `.backup`, потім перевірити health endpoint і останні логи.
- Не вмикати production `AUTH_MODE=development` навіть тимчасово.
