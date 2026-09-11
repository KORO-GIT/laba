# AGENTS.md

Правила для агента, який продовжує розробку LABA.

## ERP / Виробництво

Бібліотека інструкцій **0.27.0 розгорнута**, runtime `42a1dff40eb6352abc542309d1ab9299d0432604`, старт 2026-09-08 07:12:21 UTC. Вона включає виправлення відступів `0.26.2-spacing1`; main JS tag `0.27.0-spacing1`, materials CSS/import tag `0.26.2-spacing1`. Код оновлено в `/opt/laba` без заміни каталогу/живої БД; перевірені резервні копії та повний handoff — `docs/CURRENT_STATE.md` і `docs/ERP_CONTINUATION.md`. Старий staging `a481f5e` застарів і не використовується. Історична відмова попередньої спроби не є поточним станом.

Перед змінами читати `docs/ERP_GUIDES.md`. `/erp#guides` → «Інструкції», адміністратор → «Нова інструкція». Draft/published розділені; тільки ERP admin редагує та завантажує фото, майстри читають публікації. Спочатку зберегти чернетку, потім додавати фото. Зображення приватні, у SQLite backup, не в public/Git. Sharp exact `0.35.4`; не послаблювати `.npmrc ignore-scripts=true`, ACL/квоти/перекодування. Перед release перевіряти Linux Sharp також від runtime-користувача `laba`; запускати `scripts/erp-guides-browser-check.mjs`, materials, notifications і scrollbars. Не створювати тестові записи у production. Package version не є підтвердженням production; наступні docs-only commits не змінюють runtime SHA.

Відступи пояснення норм включено в 0.27.0: не змінювати глобальні `.task-context` для цього блоку; mobile заголовок має 17px.

Скролбари ERP `0.26.2` розгорнуто (`8670895`, 2026-09-07 21:39:22 UTC), гілку `codex/erp-scrollbars` об'єднано/push у `main`. Стилі тільки в `public/erp-scrollbars.css`: нативна прокрутка, dark/light, forced-colors зберігає системні контролі. Для регресії запускати `scripts/erp-scrollbars-browser-check.mjs` та перевірку повідомлень; Chrome headless потребує `ignoreDefaultArgs:['--hide-scrollbars']`. Не замінювати прокрутку JS-обробниками. Підтверджений runtime/backup — у CURRENT_STATE.

Hotfix повідомлень `0.26.1` розгорнуто (`7c925e7`, 2026-09-07 21:27:25 UTC) і fast-forward об'єднано/push у `main`. Native modal `showModal()` має browser top layer: ERP toast переноситься у sticky заголовок відкритого діалогу, а не підіймається body z-index. При змінах діалогів/помилок запускати `scripts/erp-notifications-browser-check.mjs`; зберігати введені поля та єдиний live region. Backend/схема/дані цим hotfix не змінені. Деталі deployment і handoff — `docs/CURRENT_STATE.md` та `docs/ERP_CONTINUATION.md`.

Норми матеріалів та поповнення `0.26.0` розгорнуто (`70508a0`, 2026-09-07 21:13:53 UTC); `codex/erp-material-planning` fast-forward об'єднано й push у `main`. Нову роботу починати з актуальної `origin/main`. Перед змінами складу/норм/прийомки прочитати `docs/ERP_MATERIALS.md`: нові партії мають `quantity_scale=1000`, старі збережено зі scale=1. Не запускати старий ERP writable поверх нових кількостей. Підтверджений deployment дивитися тільки в `CURRENT_STATE.md`.

Робочі команди `0.25.0` розгорнуто (`c947dcb`); `codex/erp-teams` fast-forward об'єднано в `main`. Деталі в `docs/ERP_TEAMS.md`; прочитати перед змінами призначень, часу, змін, QC або ролей. Нову роботу починати з актуальної `origin/main`. Не робити семантично несумісний rollback старої ERP поверх спільних таймерів.

Перший ERP-контур `0.24.0` розгорнуто; `codex/laba-erp` fast-forward об'єднана в `main`. Продовжувати з актуальної `origin/main`, нові зміни вести в окремій `codex/*` гілці. Перед роботою прочитати `docs/ERP.md` та `docs/ERP_CONTINUATION.md`; там вказані перевірки, обмеження й наступні етапи. `docs/CURRENT_STATE.md` — джерело підтвердженого production, не номер у package.json. Дизайн ERP: темна графітово-помаранчева LABA за замовчуванням і перемикач світлої теми. Власник вимагає регулярно push коду й детального handoff у Git; секрети та реальні дані не комітити.

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
- Успішний ack status-дії accounting outbox прибирає картку з активної дошки, лише якщо вона досі в тій самій кінцевій колонці. Виняток: `Сервіс → shipped` залишається видимим після підтвердження розташувань. Двосторонні правила — `docs/SERVICE_SYNC.md`: розташування борта `КИЇВ`/`НА РЕМОНТІ`, для `ТАРИ` саме розташування тари `КИЇВ`. Не повертати старе приховування таких карток і не створювати outbox-відлуння на отриманий snapshot. Канбан оновлюється фоновим polling без кешу; не вимагати ручного reload.
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
