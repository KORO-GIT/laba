# Поточний стан LABA

Актуально на 2026-09-08 за Києвом, після deployment 0.27.0 о 07:12 UTC (10:12 за Києвом). Це безпечний handoff для продовження роботи з іншого ПК або в новій задачі Codex. Секретів у цьому файлі немає.

## Код і production

**Поточна production-версія — 0.27.0, бібліотека інструкцій розгорнута.** Наведений нижче історичний стан «не розгорнуто» більше не актуальний.

- Git handoff завершено: після повторного fetch `origin/main` лишалася `e27d2e4`; `codex/erp-instructions` fast-forward об'єднано в **`main=69672b7` і push підтверджено**. Локальний checkout повернуто на clean main. Цей наступний запис є docs-only; runtime залишається `42a1dff`. Нову роботу починати з актуальної `origin/main`, не з історичних staging/гілок.
- Runtime SHA **`42a1dff40eb6352abc542309d1ab9299d0432604`**. Старт `laba-portal` **2026-09-08 07:12:21 UTC**, health 200 підтверджено 07:12:22 UTC. Це merge актуального `main=e27d2e4` в `codex/erp-instructions`, зі збереженням бібліотеки та UI spacing hotfix; код/тести після merge не відрізняються від `96d1a9e`. Наступні docs-only commits не є runtime SHA.
- Archive **`/tmp/laba-0.27.0-42a1dff.tar.gz`**, SHA-256 **`16063119247fd978dd8c72bdf7cbc70461073db6fb1f548db533c2173967aa20`**. Усі **108 файлів** production побайтово звірено через SHA-256 з цим release. Перевірений staging `/opt/laba-stage-42a1dff` містить тільки код/dependencies, без production `.env`, даних і backups. Старий staging `a481f5e` не використовували й не видаляли.
- Оновлено код **на місці в `/opt/laba`**, без swap каталогу. Зупинявся тільки LABA. Після stop створено новий SQLite backup актуальної бази **`/opt/laba/backups/portal-20260908-before-0.27.0-42a1dff.db`** (root:root 600, quick_check/FK ok). Попередній фактичний код (101 файл base `8670895` + 4 spacing assets `c607018`) збережено та перевірено у **`/opt/laba/backups/source-20260908-before-0.27.0-42a1dff.tar.gz`** (root-only 600), без env/data/node_modules. Живу БД не підміняли: її inode і checksum `.env` збережені. Rollback не знадобився, старі backups не видаляли.
- На VPS виконано `npm ci --omit=dev`; `.npmrc ignore-scripts=true` збережено. Linux Sharp `0.35.4` працює також під `laba`. Після запуску quick_check/FK ok, **усі 23 попередні ERP-таблиці та значення їхніх рядків повністю збігаються зі свіжим backup**. Збережено 4 вироби та 1 команду; під час перевірки 0 інструкцій/0 фото, marker `erp_guides_v1` є. Жодних production тестових записів агент не створював.
- Windows та свіжий VPS staging: clean install/check/test/audit — **40/40, audit 0**. Міграція disposable backup production двічі зберегла всі 39 старих таблиць/значення. Browser guides: draft/photo/ordering/preview/publish/search/ACL/409/archive/restore, desktop 1440 dark/light, mobile 390 dark/360 light та mobile editor. Materials: повний 150-unit workflow і 8 empty/filled layout cases; notifications і нативні scrollbars/forced-colors/touch regression пройшли.
- VPS in-memory smoke 3000 виробів/9000 tasks: setup 646 ms, owner median/p95 10/13 ms, worker 10/15 ms. Synthetic 16MP JPEG → 2000×2000 WebP: RSS приблизно 124 MiB. Це вузькі smoke, не concurrent SLA або гарантія для всіх зображень. MemoryCurrent LABA після старту приблизно 49 MiB, MemoryMax 512 MiB не змінювався.
- Захист збережено: `AUTH_MODE=cloudflare`, без JWT `/erp`, context/guides API, image endpoint та guides JS/CSS повертають 401. `sqlite-write-path-ok`, root 750 / env 640 / data 700 / DB 660, upstream тільки `127.0.0.1:3020`. Журнал err після старту порожній. LABA, `koro-kanban`, `koro-task`, `koro-signal-sheets-sync`, `caddy` active; Caddy SHA-256 незмінний **`e317ddf8b5ad832ab20339f3606a242ebc1af2fdd55d97536186af9bd3203396`**. Інші служби, units, Caddy, Pi, порти та секрети не змінювалися.
- Live Chrome: відкрито **`https://laba.zpseapil.club/erp#guides`**, підтверджено навігацію «Інструкції», заголовок «Корисні матеріали», кнопку адміністратора «Нова інструкція», фільтри та порожню бібліотеку. Редактор у live повторно не перевірено: browser connector втратив debugger connection; повний редактор/upload перевірено тільки на synthetic localhost. Нічого не вводили/не зберігали в production. Окремої адмінки бібліотеки на `/admin` немає — керування в самому розділі, з ERP admin ACL.
- Наступний крок користувача: створити власну інструкцію, зберегти чернетку, додати фото, опублікувати для майстрів. Workflow/ліміти/backup — `ERP_GUIDES.md`. Бібліотека навмисно без вигаданих інструкцій. Offsite backup досі не налаштовано; Git містить код і документацію, але не робочі фото/дані.

## Історія до deployment 0.27.0 (не поточний стан)

Усі нижчі твердження про production 0.26.2, заблокований deployment, staging a481f5e та ще не об'єднані гілки описують попередні checkpoints. Для поточного release використовувати розділ вище.

- **Новіше підтвердження,2026-09-07 22:06:28UTC:** production лишається backend/base8670895/package0.26.2, але4 UI assets (`erp.html`, `erp.js`, `erp-materials.js/css`) вже мають hotfixc607018/`0.26.2-spacing1`. Без stop/restart, start21:39:22UTC незмінний. Пояснення норм вирівняно з заголовком:18px вертикально,22px desktop/17px mobile; backend/дані/текст не змінені. Backup БД `/opt/laba/backups/portal-20260907-2206-before-spacing1.db` root600,4 оригінали UI `/opt/laba/backups/ui-spacing-c607018/` root-only700. Звірено101 файл (base+4patch), health200/unauth401/FK/quick_check/5active/Caddy/permissions ok,4units/1crew збережено. main отримавc607018+docs4ad79b0, push підтверджено. Рядки нижче про незміннийmainf552/усі101base867 є історією ДО цього окремого UI patch.
- Hotfix також перенесено cherry-pick у **цю feature-гілку** зі збереженням guide import та versiontag `erp.js?v=0.27.0-spacing1`; бібліотека0.27.0 досі НЕ розгорнута. Старий stageda481f5e/archive для deployment більше не використовувати: він не містить виправлення відступів. Перед наступним release новий staging, актуальні Gitmain/VPS хеші та звичайна інтеграція гілок без force; main тепер має власну історію hotfix, не припускати можливість ff-only без попередньої звірки. Materials browser8 layout cases + повний150-unit workflow і notifications regression пройшли.
- **0.27.0 ГОТОВО У GIT, АЛЕ НЕ РОЗГОРНУТО.** Гілка `codex/erp-instructions` від cleanmain=f55226b, код **a481f5e35fa2a9bc24460739e7796914357219de**, push підтверджено. Бібліотека інструкцій/фото для майстрів; workflow/обмеження — `ERP_GUIDES.md`. Windows clean npm ci/check/test/audit:40/40, audit0. Browser guides1440 dark/light,390dark/360light + mobile editor, draft/publish/photo/search/archive/409 пройшли. Regression notifications, scrollbars, crews та materials пройшли. Фото й текст у тестах синтетичні; production-записів не створювали.
- VPS staging **`/opt/laba-stage-a481f5e`**: усі108 файлів звірено з Git archive; `npm ci/check/test/audit` пройшли,40/40, audit0, Linux sharp0.35.4 працює без install hooks. Archive **`/tmp/laba-0.27.0-a481f5e.tar.gz`**, SHA-256 **d9312d14afd5ae39ce45026f7701ccd3b66fd13ee07e7b608a8ee4b8b7c1578c**. Каталог root:root700, без `.env`, `data/`, `backups/`; runtime-користувач до підготовки permissions не має доступу. Це не запущений сервіс. Read-only migration-check поточної БД двічі зберіг39 існуючих таблиць/значення/markers, quick_check/FK ok. In-memory3000units/9000tasks: setup712ms, owner10/15ms, worker12/22ms median/p95. Синтетичне16Mp JPEG →2000×2000WebP:309ms, RSS125MiB, peak190560KiB; це smoke, не concurrent SLA або worst-case гарантія для всіх фото.
- **Deployment зупинено до виконання:** середовище відхилило команду stop/backup/copy/swap з `blocked by policy`. Команда не виконувалася; обхід блокування не робився. Read-only перевірка після відмови: production досі0.26.2, health200, start21:39:22UTC незмінний, усі5 служб active, Caddy hash та права незмінні. Новий планований backup `portal-20260907-2159-before-0.27.0.db` і попередній каталог `laba-previous-20260907T2159Z-0.26.2` **НЕ створені**; не посилатися на них як на наявні копії. Для завершення потрібен дозволений deployment уповноваженим оператором/середовищем, новий backup актуальної БД та post-release перевірки; порядок у `ERP_CONTINUATION.md`. У живому браузері тільки read-only перевірено існуючу вкладку0.26.2; новий UI у production ще не перевірявся. Origin/main залишивсяf55226b, feature-гілку ще не об'єднано в main.
- Handoff після patch: `codex/erp-material-panel-spacing` fast-forward об'єднано/pushmain4ad79b0; нових commits origin/main перед merge не було. Notifications browser regression пройшов. Виправлення також cherry-pick перенесено у `codex/erp-instructions` як73983c3 зі збереженням guide import/assets; там npm ci/check,7guideAPI tests і повний guide browser regression пройшли, зміни push. Бібліотека0.27.0 не розгорталася; її старий staging лишається застарілим. Робочий checkout повернуто наmain, секрети/фото/бази в Git не додавали.
- **Поточний UI hotfix `0.26.2-spacing1`**, commit **c607018cf3c8ed8c03c7f2a517175c8906db613c**, застосовано **2026-09-07 22:06:28 UTC** без перезапуску LABA. Production є точним base8670895 із чотирма файлами `public/erp-materials.css`, `public/erp-materials.js`, `public/erp.js`, `public/erp.html` ізc607018; решта97 файлів попереднього archive незмінні. Package залишається0.26.2, backend/start21:39:22UTC незмінні. Пояснення «Матеріали за нормою» має18px зверху/знизу та22px з боків, mobile17px — вирівняно по заголовку. Ні текст, ні розрахунки/нормативи/дані/ACL не змінені.
- Static archive лише4 файли, SHA-25652c82393527482e312af3db92e4937f24089873d74b019f252630ff8c3225ffa. До запису перевірено старі та нові SHA; backup БД **`/opt/laba/backups/portal-20260907-2206-before-spacing1.db`** root:root600, оригінали4 assets **`/opt/laba/backups/ui-spacing-c607018/`** root-only700. Ніякого stop/swap каталогу/міграції: оновлено тільки4 статичні файли з попередніми правамиroot:laba664, CSS/module cache tags `0.26.2-spacing1`. Це окремий точковий UI fix, не deployment бібліотеки0.27.0.
- Перевірки: clean Windows npm ci/check/test/audit33/33, audit0; materials browser workflow150 виробів/витрата/поповнення пройшов. Додано8 visual/layout сценаріїв empty/filled ×1440dark/1440light/390dark/360light: вирівнювання заголовка/пояснення, відступи зверху/знизу, переноси без overflow,2 рядки таблиці збережені; screenshots тільки ignored data. Post-release усі101 файла runtime-manifest звірено, health200, unauth ERP/context/newCSS401, SQLite/FK ok,4 вироби/1 команда, env640/DB660, усі5 служб active, Caddy hash незмінний, журнал err після patch порожній. Production-тестових записів не створювали.
- Бібліотека0.27.0 залишається окремою **НЕ розгорнутою** `codex/erp-instructions`; її код/документація збережені. Перед наступним release вона має включати цей hotfix. Старий stageda481f5e більше не є актуальним кандидатом, бо перезаписав би відступи; оновити staging після інтеграції гілок. Блокування попередньої повної заміни каталогу не обходили.
- Репозиторій: `https://github.com/KORO-GIT/laba`, гілка `main`.
- Поточна версія застосунку: `0.26.2`.
- Останній підтверджений production-код: **`8670895db57828dc6396534deb898aaa9fa39cba`**, оформлення нативних скролбарів ERP. Старт **2026-09-07 21:39:22 UTC**, health підтверджено **21:39:24 UTC** (08 вересня, 00:39 за Києвом). Усі **101** файли archive на VPS звірено за SHA-256. `codex/erp-scrollbars` fast-forward об'єднано й push у `main`; повторний fetch підтвердив незмінний origin/main=f0a39a2. Наступний docs-only handoff не є новим runtime SHA.
- `public/erp-scrollbars.css` підключено лише до `/erp`: прозора доріжка, скруглений повзунок, відступи від країв, без системних стрілок у Chromium/WebKit, оранжеві hover/active та окремі кольори dark/light. Залишено нативні wheel/keyboard/drag/touch, стандартний CSS fallback та системний вигляд у forced-colors. Немає змін JavaScript застосунку, API/ACL, БД чи залежностей; інші модулі не зачіпаються.
- Backup **`/opt/laba/backups/portal-20260907-2139-before-0.26.2.db`** (root:root600) створено й перевірено; попередній каталог **`/opt/laba-previous-20260907T2139Z-0.26.1`** збережено. Зупинено тільки LABA; актуальні `.env`, `data/`, `backups/` скопійовано й побайтово звірено до старту. Збережено4 вироби/1 команду та всі поточні робочі записи, попередні резервні копії не видалено.
- Windows/VPS staging `npm ci/check/test/audit`: **33/33**, audit0. Новий localhost browser smoke (1440 dark/light,390 dark,360 light) перевірив власні та вкладені скролбари, реальний drag, wheel, touch swipe, textarea keyboard, horizontal table та відсутність page overflow; forced-colors повертає OS scrollbar. Регресія повідомлень0.26.1 пройшла. Desktop dark/light, hoverorange й mobile360light перевірені візуально. Read-only migration-check production backup двічі зберіг39 таблиць/старі значення/markers, quick_check/FK ok. In-memory3000-unit/9000-task smoke: setup626ms, owner10/13ms, worker9/12ms (median/p95), не concurrent SLA.
- Після deployment: health200, AUTH_MODE=cloudflare, ERP/context та `/assets/erp-scrollbars.css?v=0.26.2` безJWT401, SQLite/FK ok, root750/env640/data700/DB660 та sqlite-write-path-ok. Loopback3020, ~49MiB при незміненому MemoryMax512MiB; журнал err після старту порожній. Caddy SHA-256 незмінний, усі5 служб active. Live Chrome через Computer Use: reload без незавершеного вводу → `Замовлення` → порожня форма `Прийняти партію`; скролбар візуально підтверджено, форму закрито без вводу/збереження, повернуто `/erp#team`. Реальних тестових записів не створювали.
- Попередній production `0.26.1`: **`7c925e7d490a9b5e565de69da28ec06318886a0a`**, виправлення ERP-повідомлень позаду розмитого modal backdrop. Старт **2026-09-07 21:27:25 UTC**, health підтверджено **21:27:26 UTC** (08 вересня, 00:27 за Києвом). Усі **99** файлів Git archive на VPS звірено за SHA-256, без розбіжностей. `codex/erp-dialog-notifications` fast-forward об'єднано й push у `main`; наступний docs-only handoff не є новим runtime SHA. Перед merge повторний fetch підтвердив незмінний origin/main=00bab8e, чужих commits не перезаписано.
- Повідомлення тепер знаходиться у sticky заголовку відкритого діалогу, а після закриття повертається до body. Помилки не скидають введені поля; success зберігається після повторного відкриття, старі помилки очищуються. Змінено ERP frontend/версії, browser regression і документацію; diff `src/` від 70508a0 порожній. API, ACL, схема, матеріальні проводки та облік часу незмінні.
- Перед deployment `0.26.1` створено й перевірено SQLite backup **`/opt/laba/backups/portal-20260907-2127-before-0.26.1.db`** (root:root 600); попередній каталог **`/opt/laba-previous-20260907T2127Z-0.26.0`** збережено. Зупинено тільки LABA; найсвіжіші `.env`, `data/`, `backups/` скопійовано й побайтово звірено до заміни каталогів. Збережено 4 вироби, 1 команду та актуальні користувацькі операції/призначення. Старі backups/каталоги не видалялися, rollback бази не виконувався.
- Windows і VPS staging: точні `npm ci/check/test/audit` пройшли, **33/33**, audit 0. Чотири локальні browser regression (основний ERP, команди, матеріали, повідомлення) пройшли. Новий тест: desktop 1440 dark, mobile 390 dark/360 light, empty selection без POST, реальний 409, збереження полів, довгий безпечний текст, один live region, topmost/sticky, success/reopen/Escape/таймер. Read-only migration-check production backup двічі зберіг **39** наявних таблиць, старі значення й markers; quick_check/FK ok, нової міграції немає. VPS in-memory smoke: 3000 виробів/9000 операцій — owner 10/14 ms, worker 10/14 ms (median/p95); materials read 41/54 ms, витрата 150×3 —670 ms. Це не concurrent load test чи SLA.
- Після hotfix: health 200, Cloudflare auth незмінний, `/erp`, context та assets `erp.js`/`erp-theme.css?v=0.26.1` без JWT —401; SQLite quick_check/FK ok. Права каталог750/env640/data700/DB660, `sqlite-write-path-ok`; loopback3020, MemoryCurrent близько56 MiB, MemoryMax512 MiB незмінний, журнал err після старту порожній. Caddyfile hash незмінний, усі п'ять служб active; Task/Starlink/SignalSynch не змінювалися.
- Live Chrome через Computer Use: після reload відкрито існуюче замовлення й натиснуто `Призначити` при `Обрано 0`. `Спочатку оберіть вироби` чітко видно у заголовку діалогу над blur; скриншот візуально перевірено. Це client-only validation, без призначення/збереження; діалог закрито, повернуто початковий `/erp#team`. Mobile dark/light і серверні помилки перевірялися тільки на synthetic localhost.
- Попередній production `0.26.0`: **`70508a06c77de081968177f067d7ac3474d71453`**, норми матеріалів/потреби/поповнення ERP. Старт **2026-09-07 21:13:53 UTC**, health підтверджено **21:13:54 UTC** (08 вересня,00:13 за Києвом). Усі **98** файлів Git archive на VPS звірено за SHA-256, без розбіжностей. `codex/erp-material-planning` fast-forward об'єднано й push у `main`; наступний docs-only handoff не є новим runtime SHA.
- Перед deployment `0.26.0` створено й перевірено SQLite backup **`/opt/laba/backups/portal-20260907-2113-before-0.26.0.db`** (root:root600); попередній каталог **`/opt/laba-previous-20260907T2113Z-0.25.0`** збережено. Після stop тільки LABA поточні `.env`, `data/`, `backups/` скопійовано та побайтово звірено до старту. Збережені4 користувацькі вироби й1 нова робоча команда; агент не додавав реальних матеріалів/норм/заявок.
- VPS staging: `npm ci/check/test/audit` пройшли, **33/33**, audit0. Migration-check read-only backup production двічі зберіг **36** існуючих таблиць, старі колонки/значення/markers, quick_check/FK ok. Нові3 матеріальні таблиці й3 додаткові колонки старих партій, жодної перезаписаної старої кількості. Нові партії `quantity_scale=1000`; старі scale1. Не запускати старий ERP writable поверх цієї семантики — правила `ERP_MATERIALS.md`, переважно fix-forward.
- Після deployment: Cloudflare auth незмінний, `/erp`, context/replenishments/material-preview та обидва нові assets без JWT —401; quick_check/FK ok, каталог750/env640/data700/DB660, write permissions користувача laba перевірені. MemoryCurrent близько49MiB, MemoryMax512MiB незмінний; loopback3020, журнал err після старту порожній. Caddyfile hash і активність усіх сусідніх служб незмінні.
- Live Chrome (Computer Use) перевірено: overview збережених виробів → каталог → форма нового матеріалу без вводу/збереження → `Поповнення`; сторінку залишено `/erp#replenishment`. Заповнені сценарії та mobile360/390 dark/light перевірялися тільки на synthetic localhost. Почати реальне налаштування з каталогу/мінімумів і норм шаблонів; порожній каталог не означає відсутність потреби.
- Попередній production `0.25.0`: **`c947dcb38b6ff9982490801600d91b3f040cbb2b`**, робочі команди ERP. Розгорнуто 2026-09-07 о **20:47:13 UTC**, health підтверджено о20:47:15; усі92 файли archive звірені. Гілка `codex/erp-teams` об'єднана в main і збережена.
- Перед deployment команд створено SQLite backup **`/opt/laba/backups/portal-20260907-2048-before-0.25.0.db`**; попередній код `0.24.0/e430efd` збережено в **`/opt/laba-previous-20260907T2048Z-0.24.0`**. Шляхи містять `2048`, але фактичний час старту зазначено вище. `.env`, актуальні `data/` і `backups/` скопійовано після зупинки лише LABA, побайтово звірено до старту. Міграція додала тільки таблиці/колонки команд; старі значення не переписувались. Rollback старої ERP поверх нових shared-таймерів семантично несумісний: див. `ERP_TEAMS.md`, переважно fix-forward; нову БД старим backup не замінювати.
- Перший ERP release `0.24.0/e430efd` був 2026-09-07 близько 20:22–20:24 UTC, 88 файлів archive збігалися. Його backup **`/opt/laba/backups/portal-20260907-2022-before-0.24.0.db`** і попередній каталог **`/opt/laba-previous-20260907T2022Z-0.23.3`** збережені.
- `laba-portal`, `koro-kanban`, `koro-task`, `koro-signal-sheets-sync`, Caddy активні; `/healthz` — 200, SQLite quick_check — `ok`, foreign_key_check — без порушень. Caddyfile незмінний: SHA-256 `e317ddf8b5ad832ab20339f3606a242ebc1af2fdd55d97536186af9bd3203396`. SignalSynch залишився на раніше підтвердженому `8f81ae22bb2e428de89b608d26e6adf7aebe63f3`; його код/конфігурація не змінювалися.
- Попередні checkpoint/backup `0.23.3`: код `5a816f2fd19e246e1063e5503c59a8d6c78fc73e`, backup `/opt/laba/backups/portal-20260907-1655-before-0.23.3.db`, каталог `/opt/laba-previous-20260907T1655Z-0.23.2`. Збережені, не видалялися.
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
- Виробництво ERP: `https://laba.zpseapil.club/erp`; майстрам — `/erp#my`, робочі команди — `/erp#crews`.
- Матеріали — `/erp#materials`, норми типових процедур — `/erp#templates`, прогноз/внутрішні заявки — `/erp#replenishment`. Детальна інструкція `ERP_MATERIALS.md`. Повідомлення тільки всередині відкритого ERP; зовнішніх push/автозакупівель немає, фактичний розхід підтверджується окремо від плану.
- Майстерня: `https://laba.zpseapil.club/workshop`.
- Гарантійний сервіс: `https://laba.zpseapil.club/service`.
- Пристрої: `https://laba.zpseapil.club/devices`.
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

## Робочі модулі

- Головна сторінка показує лише доступні користувачу модулі: `Майстерня`, `Сервіс`, `Пристрої`, `Виробництво`.
- Спільна дизайн-система всіх екранів використовує однакові центровані SVG-іконки, уніфіковані шеврони списків, робочий текст не менше `12px`, контрольовані `44px` touch-цілі та адаптивні компонування без горизонтального переповнення сторінки. П'ять стандартних колонок уміщуються на viewport `1366px`; на мобільному viewport `390×844` колонки прокручуються окремо від сторінки.
- `Майстерня` стандартно отримує з усіх налаштованих таблиць `Облік` борти зі статусами `ПОТРЕБУЄ ОГЛЯДУ` або `ТЕХНІЧНІ ПРОБЛЕМИ`. Стандартні колонки: `Нові`, `На огляді`, `У ремонті`, `Відкладено`, `Готово`.
- Переміщення картки до стандартної колонки `Готово` створює outbox-дію для точного вихідного рядка. SignalSynch повторно перевіряє рядок і стандартно змінює статус на `НА ОБЛІТ`; після успішного підтвердження LABA одразу прибирає картку з активної дошки. Відкрита дошка оновлюється у фоні, а за наявності pending-дій перевіряє зміни кожні 2,5 секунди, тому ручне перезавантаження не потрібне.
- `Сервіс` стандартно отримує борти зі статусами `ПОТРЕБУЄ СЕРВІСУ` та `ВТРАЧЕНИЙ`. Втрачені борти показуються в цьому модулі як окремий засіб `ТАРА`, але зберігають вихідний засіб, номер борта, ідентифікатори та точне посилання на рядок `Обліку`. Після вибору `ТАРА` в основному фільтрі з'являється окремий фільтр за вихідним засобом. У кожній сервісній картці виконавець може окремо зберегти `Номер рапорта`; номер показується на картці та бере участь у пошуку. Стандартні колонки: `Нові`, `Готуються документи`, `Документи подано`, `Очікує відправлення`, `Відправлено`.
- Переміщення в `Сервіс → Відправлено` не змінює статус рядка. Для картки `ТАРА` SignalSynch записує `КИЇВ` тільки в розташування тари; для звичайної сервісної картки він одним batch-запитом записує `НА РЕМОНТІ` в розташування борта й тари. `ТАРА` з поточним розташуванням тари `КИЇВ` не створюється навіть під час першої синхронізації; наявна картка зникає після наступного повного snapshot і не повертається, доки це розташування збережене в `Обліку`.
- У `/admin` → `Дошки` глобальний адміністратор може змінювати назву й опис дошки, назви/порядок/кольори колонок, додавати та видаляти порожні проміжні колонки, призначати вхідну колонку, статуси-джерела з `Обліку`, статус для зворотного запису та незалежні права користувачів. Користувач із модульним рівнем `Адміністратор` бачить кнопку `Налаштування` безпосередньо на своїй дошці й керує тільки нею; глобальні користувачі, пристрої, аудіо, Starlink і аудит йому недоступні. Тут само незалежно налаштовуються статуси роботи й кольорові мітки карток. Виконавець може одночасно обрати кілька статусів, наприклад `Чекаємо запчастини`, і кілька міток складності або типу ремонту. Мітки показуються кольоровими смугами на картках і легендою над дошкою; на мобільних легенда прихована. Перейменування або зміна кольору одразу відображається на всіх картках, а видалення визначення каскадно прибирає лише відповідне призначення. Стабільні ключі системних колонок не змінюються й такі колонки не видаляються; це захищає наявні картки та інтеграцію.
- Пошук у `Майстерні` та `Сервісі` має єдину рамку фокуса й окрему кнопку очищення, яка з'являється лише після введення тексту.
- Перетягування карток у `Майстерні` та `Сервісі` одразу фіксується в локальному стані: картка не повертається до вихідної колонки під час очікування API, фонове оновлення не може перезаписати незавершене переміщення, а відкат виконується лише після помилки сервера.
- Завершення drag-and-drop не перемальовує всю дошку без зміни даних і не запускає вступну анімацію колонок; preview рухається без transition та обертання. На touch-пристроях таймер довгого натискання завжди скасовується при відпусканні, тому звичайний tap не залишає завислу копію картки поверх відкритої панелі.
- Компактна картка не дублює вхідний статус `Обліку`; налаштовувані статуси роботи залишаються на картці більшим читабельним текстом.
- Значення колонки `Коментар` з кожного рядка `Обліку` синхронізується в `source_comment` і показується в картці як `Коментар з Обліку` замість технічного поля `Джерело`. Поле доступне лише для читання й не змішується з редагованими `Примітками до роботи`.
- Кожен модуль має незалежний рівень `viewer`, `operator` або `admin`. Головний адміністратор примусово має `admin` у всіх модулях і не може бути понижений або вимкнений.
- Інтеграція Google-таблиць не має публічного API: SignalSynch викликає LABA через loopback із окремим production-токеном.

## ERP 0.25.0: робочі команди та наступні кроки

Додано `Робочі команди`: склад із наявних ERP-акаунтів, старший, призначення вибраних виробів або партії. Режим черги `pool` видає операцію одному майстру атомарно; режим `shared` дозволяє кільком людям одночасно виконувати одну складну операцію. Кожен зупиняє/завершує власний внесок, старший/керівник — спільну операцію після всіх внесків. Пауза/закриття зміни не зупиняє колег; час та історія зберігаються персонально при зміні складу й доробці. Нові акаунти — у `Команда`, робочі групи — окремо в `Робочі команди`. Послідовний маршрут/QC/видача зберігаються; це не паралельний граф операцій.

Перевірки release 0.25.0:

- Fresh origin/main збігався з `1991d0e`; усі 88 файлів попереднього VPS — з `e430efd`. Інших змін коду не виявлено.
- Windows і VPS staging: точні install/check/test/audit, **25/25**, audit 0. Два localhost browser сценарії пройшли: регресія початкового ERP та два окремі mobile акаунти 390/360px у спільній роботі, dark/light, власницькі створення/редагування/призначення, внески/завершення, без JS/CSP errors.
- Посилена міграційна перевірка виконала дві міграції private temporary `.backup` production, відкритої read-only: **33** наявні таблиці (зокрема ERP), всі старі рядки/колонки та migration markers збережені, quick_check/FK ok.
- Після deployment schema має `erp_crews_v1`; збережено 4 вже створені користувачем вироби. Команд на момент перевірки 0; агент не створював demo-записів у production.
- VPS in-memory smoke: 3000 виробів / 9000 операцій / 20 майстрів, owner median 9 / p95 12 ms, worker median 10 / p95 11 ms, setup 676 ms. Це не реальне конкурентне навантаження або гарантія місткості.
- Live Chrome з Cloudflare-акаунтом власника: overview зі збереженим обліком, новий розділ, форма учасників/старшого (закрито без запису), візуально темна тема; залишено `/erp#crews`.
- Health 200, SQLite/FK ok, усі 92 файли відповідають `c947dcb`. Без JWT ERP HTML/context/crew API/crew CSS — 401. Журнал systemd err після старту порожній. Caddy hash і сусідні служби незмінні. LABA слухає лише loopback 3020, MemoryCurrent 48,021,504 bytes (~46 MiB), MemoryMax 512 MiB без змін.

Повна інструкція — `docs/ERP_TEAMS.md`; handoff — `docs/ERP_CONTINUATION.md`. Для справжнього запуску власник визначає склад команд, старших і незалежного контролера. Offsite backup, payroll, BOM/резервування та інші наступні етапи ще не виконані.

## Історія першого ERP 0.24.0

ERP є окремим модулем тієї самої захищеної LABA. Це **перший робочий контур**, не повна бухгалтерська/зарплатна система. Чинні канбани та їхня інтеграція не перенесені, не переписані та не імпортовані автоматично.

Реалізовані клієнти, прийомка партій до 500 виробів за одну команду, заводські або внутрішні номери, маршрути/шаблони робіт, поопераційні призначення, мобільна черга майстра, зміни й таймери, незалежний контроль якості/доробка, часткова видача, склад із власністю клієнта/майстерні й незмінюваним журналом. ERP-ролі відокремлені від глобальної ролі та доступу до інших модулів. Нові майстри додаються через `Команда`; глобальні адміністратори мають доступ автоматично. Одразу після першого release 20:24 UTC ERP-база була порожня: агент не створював demo-записів. До оновлення команд користувач уже додав 4 вироби; вони збережені, див. поточний release вище.

Перевірки release:

- Windows Node 24.19.0: точні `npm ci`, `npm run check`, `npm test` **20/20**, `npm audit --omit=dev` — 0 vulnerabilities.
- VPS staging Node 22.22.1 / Python 3.14.4: той самий install/check/test/audit успішний, **20/20**.
- Міграція двічі виконана на тимчасовій SQLite `.backup` production; source відкритий read-only. Hash вмісту та DDL усіх 16 старих таблиць незмінні, попередні migration markers збережені, quick_check/foreign keys — ok.
- In-memory smoke на VPS: 3000 виробів, 9000 операцій, 20 майстрів; owner snapshot p95 14 ms, technician p95 3 ms (40 повторів), створення партій 584 ms. Це не перевірка паралельного навантаження, мережі чи диска й не гарантія масштабу.
- Playwright на синтетичній локальній базі: dark/light, persistence, desktop 1440, mobile 390/360, owner navigation, прийомка/деталі, ізоляція майстра, pause/resume/complete, зміни, без JS/CSP errors. Чотири скриншоти перевірено.
- Live Chrome з наявною Cloudflare-сесією власника: новий модуль на головній, ERP overview, dark/light, збереження світлої теми після reload; повернуто темну й залишено ERP відкритою. Робочі дані не змінювалися.
- Loopback без JWT: `/erp`, `/api/erp/context` і ERP asset повертають **401**. Origin не відкриває ERP анонімно. Журнал systemd рівня err після старту порожній.
- Поточний cgroup LABA близько 45 MiB за `MemoryCurrent` у read-only smoke, ліміт unit лишився 512 MiB. Ресурси VPS не збільшувалися.

Подальша розробка: `docs/ERP.md` (специфікація/обмеження/референси) та `docs/ERP_CONTINUATION.md` (відтворення з іншого ПК). Наступний практичний крок — погодити реальний маршрут робіт і провести невелику пілотну партію з майстром та окремим контролером; не заводити довільні реальні акаунти чи клієнтів без даних власника.

Невирішене: offsite backup бази поза VPS, закупівлі/BOM/резервування, мобільна видача комплектуючих майстром, QR/фото/акти, звіти за період і зарплата. Також VPS повідомляє про очікувані системні оновлення й необхідність reboot; у цьому release ОС та сусідні сервіси не оновлювалися. Потрібне окреме погоджене вікно обслуговування. Git захищає код, але не замінює offsite backup або сховище SSH/Cloudflare-секретів власника.

## Мережа та пристрої

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

Камерний стек відновлюється після пізньої USB-ініціалізації без ручного втручання. uStreamer повторює відкриття стабільного V4L path, H.264-кодер не блокується результатом першої спроби uStreamer і повторно підключається до `127.0.0.1:8080`, а go2rtc не залежить від USB-джерела та продовжує обслуговувати IP-камеру. Це усуває стан після reboot, коли перша невдала USB-спроба залишала H.264 і go2rtc у `inactive (dead)`.

У LABA камера `k1se-camera` є окремим device і дочірнім пристроєм `Creality K1 SE`: dashboard показує її у підгрупі принтера, grants принтера успадковуються камерою. Окремий device `labacam` належить камері відеоспостереження і не має parent; її основний RTSP-профіль — H.264 High 1920×1080@25. Mainsail вбудовує same-origin player `/webcam/laba/player`; він передає H.264 через захищений MSE WebSocket `/webcam/laba/ws`, а префікс `/webcam` обходить navigation fallback service worker Mainsail. HLS і MJPEG маршрути принтера збережені як fallback. LABA серверно підмінює будь-який клієнтський `src` на дозволене ім’я потоку go2rtc.

WebSocket Mainsail проходить через LABA: портал перевіряє, що браузерний `Origin` збігається з адресою пристрою, видаляє службові заголовки Cloudflare та підмінює upstream `Origin` на локальну адресу принтера. Без цієї підміни Moonraker відповідає `Cross origin websockets not allowed`.

## Bluetooth та аудіо

В адмінпанелі `/admin` працює вкладка «Аудіо». Вона доступна лише ролі `admin` і дозволяє:

- увімкнути або вимкнути Bluetooth;
- виконати обмежений у часі discovery;
- спарувати, довірити, підключити, від’єднати або забути пристрій;
- вибрати PipeWire sink, змінити гучність і mute;
- керувати play/pause/next/previous/stop сумісного MPRIS-програвача.

На Pi активний `laba-audio-agent.service`. Він слухає тільки Tailscale IP `100.69.168.10:1985`, приймає тільки VPS `100.68.61.33`, перевіряє окремий bearer credential і не виконує shell. Credential Pi зашифрований у `/etc/credstore.encrypted/laba-audio-agent-token`; plaintext-копії після deployment видалені. `playerctl` встановлено, PipeWire/WirePlumber активні, Logitech C270 доступна як mono source. Адаптивний детектор локально слухає exact PipeWire source C270: два чіткі хлопки виконують MPRIS `play-pause`, а три — приглушують активний MPRIS-програвач до 35%, локально відтворюють «Бажаю здоров'я!» і повертають точну попередню гучність. В адмінпанелі можна повністю вимкнути обробку мікрофона, змінити чутливість у безпечному діапазоні `30–80%` та максимальну паузу між хлопками `0,35–1,50` секунди; стандартні значення — `70%` і `1,10` секунди. Налаштування застосовуються без перезапуску й атомарно зберігаються з mode `0600` у приватному systemd `StateDirectory`. Короткі HF-heavy імпульси електричної мухобойки відсіюються за тривалістю, спектральним співвідношенням і transient-shape навіть на максимальній чутливості. Після жесту імпульси ігноруються 2 секунди. Bluetooth-контролер `PiLABA4B` увімкнений, а EDIFIER R1080BT підключена й обрана активним аудіовиходом.

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

Остання production-перевірка: LABA `0.23.3`, `laba-starlink-agent`, `laba-audio-agent`, `laba-desktop-gateway`, Caddy і `tailscaled` active; портал слухає тільки `127.0.0.1:3020`, desktop gateway — `127.0.0.1:6080`, Starlink agent — тільки `100.69.168.10:1986`. Детектор хлопків перевірено регресійними тестами швидкого, повільного й слабкого людського ритму, електричної дуги та широкої нічної ритмічної перешкоди на максимальній чутливості; хибні жести не формуються. Вимикач, live-зміна чутливості/інтервалу, подвійна валідація та персистентний config перевірені окремими тестами. Starlink router status визначено як `BYPASSED` без додаткового probe; snow-melt write повертає `403` на portal і agent. Журнал Starlink позначено як список до 30 останніх мережевих подій із датою/часом, а power-save layout перевірено без виходу кнопки за межі картки. Із desktop gateway прибрано process-level `--idle-timeout`, який завершував enabled unit із кодом 0 після простою; gateway тепер постійно готовий до кнопки noVNC. Після reboot перевірено відновлення камерного стека при пізній появі Logitech C270: go2rtc більше не залежить від USB-джерела, H.264-кодер повторює підключення самостійно, IP-камера залишається доступною. Starlink agent повернув HTTP `200` для status/map лише з VPS із credential і `401` без credential; карта має `123×123`/`15129` значень. `systemd-analyze security` оцінив Starlink unit як `2.8 OK`; тимчасові plaintext tokens і probe-файли видалені. На VPS повторно пройшли `npm run check` і `npm test` (`11/11`); SQLite `PRAGMA quick_check` повернув `ok`, а Caddyfile та сусідні сервіси не змінювалися.
