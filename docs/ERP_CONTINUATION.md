# Продовження ERP з іншого ПК

## Робочий checkpoint 0.26.1 · повідомлення у діалозі

Гілка `codex/erp-dialog-notifications` від clean `origin/main=00bab8e`. Власник показав помилку позаду розмитого backdrop. Причина: `showModal()` переносить dialog у browser top layer; звичайний body `#toast` із z-index50 залишається нижче, просте збільшення z-index не допомагає. Один існуючий toast тепер переміщується у sticky `.dialog-header` відкритого вікна, а після close/Escape повертається у body. DOM-вузол збережений між replaceChildren/reopen, тому успіх після save→повторне відкриття теж видимий. Помилки мають alert/assertive, успіх status/polite, aria-atomic; duplicate `.form-error` прибрано, введені поля не скидаються. Старі помилки очищуються при зміні/закритті діалогу, таймер лишається один, 5,5с. CSS переносить довгі рядки, теми/мобільний екран збережені.

Змінено лише ERP frontend/asset version/package patch, browser regression та цю документацію. Серверні API/ACL/схема/проводки/час/дані й інші модулі не змінюються. На момент checkpoint підтверджений runtime ще70508a0/0.26.0; новий номер package не означає deploy. `scripts/erp-notifications-browser-check.mjs` запускає власний disposable localhost8086, перевіряє empty selection безPOST, реальний409 без втрати полів, один live region, topmost hit-test, sticky після scroll, довгу текстову помилку безHTML, success після заміни діалогу, Escape/timer, dark/light1440/390/360. Скриншоти лише ignored data, жодних тестових дій у production. Перед release — точні install/check/test/audit, на VPS staging й read-only migration-check; зберегти найсвіжіші `.env/data/backups`, перезапуск тількиLABA, Git push та final handoff.

Локальні точні `npm ci`, `npm run check`, `npm test` пройшли (33/33), `npm audit --omit=dev` —0 vulnerabilities. Новий browser smoke та повторні materials/crews smoke пройшли; скриншоти desktop1440 dark і довга помилка mobile360 light візуально перевірені. До release всі98 файлів VPS збігалися з70508a0; production4 вироби/1 команда, Cloudflare/SQL/FK ok, Caddy hash незмінний,5 служб active. У source/backend diff порожній. Фінальний deployedSHA/backup записати після фактичного завершення.

## Поточний checkpoint 0.26.0 · матеріали

`codex/erp-material-planning` від clean `origin/main=eed5419`; перший checkpoint `b036322`, release **`70508a06c77de081968177f067d7ac3474d71453`**. Розгорнуто **2026-09-07 21:13:53 UTC**, health21:13:54; гілку fast-forward об'єднано й push у main. Реалізовані каталог/норми на шаблон і замовлення, розрахунок всіх відкритих потреб, внутрішні попередження, заявки з частковим надходженням, підтвердження фактичної витрати. Повністю прочитати `ERP_MATERIALS.md`.

- Windows та VPS staging install/check/test/audit:33/33,audit0. Три локальні browser smoke (початкова ERP, команди, матеріали) та два performance smoke пройшли. Synthetic та production-read-only backup migration-check двічі зберегли36 старих таблиць/колонок/значень; quick_check/FK ok.
- VPS material smoke:201 замовлення,3181 виріб,3 матеріали,501 партія; setup658ms, read median41/p9564ms, проведення150×3 —683ms. Загальний3000-unit/9000-task smoke: setup645ms, owner10/13ms, worker10/13ms. Це in-memory, не concurrent SLA чи гарантія місткості.
- Перед release всі92 старі VPS-файли збігалися з c947dcb; після —98 з70508a0. Origin/main повторно перевірена до merge: залишаласяeed5419, чужих нових commits не було. Збережено актуальні4 вироби та1 створену користувачем команду. Дані скопійовані після stop й побайтово звірені, не зі старого backup.
- Backup `/opt/laba/backups/portal-20260907-2113-before-0.26.0.db`, попередній каталог `/opt/laba-previous-20260907T2113Z-0.25.0`. Старі backups не видалені. Caddy/Pi/Task/Starlink/SignalSynch не змінювалися. Усі5 VPS-служб active, authCloudflare, безJWT нові API/assets401, SQL/FK ok, права збережено, loopback3020, ~49MiB ізMemoryMax512MiB.
- Live Chrome: overview → каталог → форма без збереження → поповнення; візуально перевірено через Computer Use. На VPS матеріалів/норм/заявок ще0; це налаштовує власник за реальними даними, не seed. Підказки видимі, тестових проводок агент не робив. Для першого реального шаблону: каталог/власник/одиниці → норми на один виріб → прийомка запасу → замовлення зі snapshot норм → прогноз/заявка → фактичний розхід до QC.
- Особливо важливо зберігати `quantity_scale` та незмінні legacy рухи; старий writable ERP несумісний. Немає зовнішніх сповіщень, hard reserve, автосписання при завершенні майстром чи offsite backup. Наступна робота — тільки нова codex/* від актуального origin/main; docs-only SHA не плутати з runtime70508a0.

Оновлено: 2026-09-08 за Києвом після deployment матеріалів `0.26.0`. Виробничий контур, команди та матеріали запущено; повна ERP продовжує розвиватися. Точний підтверджений production — у `CURRENT_STATE.md`.

## Історичний checkpoint 0.25.0

- `codex/erp-teams` створено від clean `origin/main=1991d0e`, checkpoint **`c947dcb38b6ff9982490801600d91b3f040cbb2b`** push і розгорнуто 2026-09-07 о 20:47 UTC. Після повторного fetch гілку fast-forward об'єднано й push у `main`. Наступний docs-only commit фіксує deployment, його не плутати з runtime SHA.
- Нова вимога власника: команди для одного великого складного дрона та модернізації партії. Реалізовано склад/старший, `pool` і `shared`, особисті внески, незалежні таймери й зміни, server ACL/версії/історію. Повністю прочитати `ERP_TEAMS.md`.
- Нові файли: `src/erp-crews.mjs`, `public/erp-crews.css`, `scripts/erp-crews-browser-check.mjs`, `docs/ERP_TEAMS.md`. Зміни інтегровані в ERP database/routes/UI/tests/check; залежності й інші модулі незмінні.
- Windows: точні install/check/test/audit пройшли, **25/25**, audit 0. Новий browser smoke пройшов на двох незалежних synthetic mobile акаунтах (390/360, dark/light); створення/редагування/призначення, одночасна робота, внески та старший. Скриншоти візуально перевірені. Початковий ERP browser regression теж пройшов.
- Міграція на старій synthetic ERP: збережено 33 таблиці; після повторного старту на вже оновленій synthetic DB — 36. Source тільки read-only, дві міграції backup, quick_check/FK ok. Тепер перевіряються також усі старі ERP-значення, не лише legacy LABA.
- Останній локальний in-memory smoke: 3000 виробів/9000 операцій/20 майстрів, owner median 8/p95 9 ms, worker median 7/p95 9 ms, setup 497 ms. Не benchmark production або гарантія місткості.
- Release виконаний: перед оновленням усі 88 файлів VPS збігалися з попереднім `e430efd`; origin/main залишався `1991d0e`, нових commits іншого ПК не було. На staging install/check/test/audit — **25/25**, audit 0. Міграція read-only backup production двічі зберегла **33** наявні таблиці, старі колонки/рядки/markers, quick_check/FK ok. VPS in-memory smoke: owner median 9/p95 12 ms, worker median 10/p95 11 ms, setup 676 ms; не concurrent load test.
- Перед stop зроблено backup `/opt/laba/backups/portal-20260907-2048-before-0.25.0.db`; попередній каталог `/opt/laba-previous-20260907T2048Z-0.24.0`. Назви шляхів містять `2048`, фактичний успішний старт — **20:47:13 UTC**, health підтверджено 20:47:15 UTC. Після stop тільки LABA скопійовано й побайтово звірено поточні `.env`, `data/`, `backups/`; нові користувацькі ERP-записи не загублені. На момент перевірки було 4 вироби, команд ще 0; тестових записів агент не додавав.
- Усі **92** файли deployed archive відповідають `c947dcb` за SHA-256; health/SQLite/FK ok, Cloudflare auth збережено, без JWT ERP/context/crew API/crew CSS — 401. Caddy hash незмінний, усі п'ять служб active, журнал err після старту порожній; LABA loopback3020, близько 46 MiB MemoryCurrent при незміненому MemoryMax512MiB.
- Live Chrome через навичку Computer Use: власницький ERP overview збережених виробів → `Робочі команди` → форма складу/старшого → закриття без запису. Темний екран перевірено візуально; синтетичні mobile dark/light перевірялися локально. Сторінку залишено `/erp#crews`. Реальні команди/майстрів створює власник за фактичним складом.
- Наступне: продовжувати з main, провести пілот з реальними майстрами/старшим/незалежним контролером, не створювати довільні акаунти. Offsite backup та решта етапів `ERP.md` ще не виконані.
- Обмеження: послідовний маршрут (не DAG); 200 команд/50 людей у команді/500 призначень за команду; без payroll/date-range/offline. Старий ERP не може безпечно обслуговувати shared-записи — rollback лише за правилами `ERP_TEAMS.md`, переважно fix-forward.

## Репозиторій та гілка

- Репозиторій: `https://github.com/KORO-GIT/laba` (не `kanban`, не Task).
- Гілка першого ERP-релізу `codex/laba-erp` об'єднана fast-forward у `main` і збережена як checkpoint. Продовжувати з актуальної `origin/main`.
- База гілки: `5000d27` — документація production LABA `0.23.3`.
- Історична версія першого контуру: `0.24.0`, попередній production `e430efd1366eb663c2f79ab92d66a5924c027855`. Перший checkpoint — `f399a03`, release verification — `e430efd`, docs-only handoff — `1991d0e`. Поточний production команд — `c947dcb/0.25.0`, як зазначено вище. Не вважати номер у `package.json` підтвердженням наступного deployment.
- Працюючі `/workshop`, `/service`, `/devices`, SignalSynch та Task не мігруються в ERP і не замінюються.

```powershell
git clone https://github.com/KORO-GIT/laba.git
cd laba
git fetch origin
git switch main
git pull --ff-only
git status --short --branch
# Нову роботу починати у новій codex/* гілці після перевірки clean tree.
```

Повністю прочитати `AGENTS.md`, `README.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, `docs/CURRENT_STATE.md`, `docs/ERP.md` та цей файл. Перевірити нові commits з іншого ПК перед будь-яким merge/deploy; не перезаписувати dirty worktree.

## Вимоги та рішення власника

1. Внутрішня ERP майстерні: клієнти, великі партії (типово 150 виробів), склад власних і клієнтських комплектуючих, ремонт/модернізація, відповідальне зберігання, часткове повернення.
2. У виробів зазвичай є заводські номери; рідкісні безномерні мають отримувати внутрішні.
3. Кожен майстер має власний акаунт. Основний робочий пристрій — його особистий телефон. Потрібні власні призначення, початок/пауза/завершення операцій та зміни.
4. Власник бачить навантаження, поточну роботу й зафіксований час. Відкрита вкладка не вважається роботою, GPS/мікрофон/стеження не додаються.
5. Автентифікація — наявний Cloudflare Access; потрібен також серверний контроль дозволів, захист API й цілісності обліку.
6. Дизайн уточнено власником: **як поточна LABA, темний графіт із помаранчевими акцентами; світла тема має перемикатися**. Початковий зелений варіант більше не є погодженим напрямком.
7. Власник окремо вимагає регулярно зберігати код і детальну документацію в Git, щоб втрата цього ПК не блокувала продовження.
8. Збільшення ресурсів VPS можливе, але ресурсів поки не змінювали. Спочатку виміряти навантаження.
9. Людей можна об'єднувати у команди для спільного ремонту великого дрона (агродрон) або модернізації партії малих. Це реалізовано у двох режимах `ERP_TEAMS.md`, зі збереженням особистого обліку.

## Файли та відповідальність

| Файл | Призначення |
|---|---|
| `src/erp-database.mjs` | Адитивна схема `erp_*`, бізнес-інваріанти, транзакційні команди, склад, час, контроль, видача |
| `src/erp-crews.mjs` | Міграція `erp_crews_v1`, склад/старший, pool/shared, особисті внески, зміни та історія команд |
| `src/erp-routes.mjs` | Строгі Zod-схеми, ERP ACL, exact-Origin CSRF, UUID ідемпотентності, ліміти, маршрути `/api/erp/*` |
| `src/server.mjs` | Підключення ERP до наявного Fastify й авторизації; запис у список модулів |
| `public/erp.html`, `erp.js` | Адміністративні екрани й мобільна черга майстра; DOM/textContent для користувацького вводу |
| `public/erp.css`, `erp-responsive.css` | Компонування, компоненти, mobile breakpoints |
| `public/erp-theme.css`, `erp-theme.js` | Темна/світла палітра LABA; раннє завантаження теми без світлого спалаху; збереження тільки `laba.theme` |
| `public/erp.webmanifest` | Ярлик робочого місця майстра; немає service worker/offline-черги |
| `test/erp.test.mjs` | Поведінкові тести цілісності, прав, retry, конкурентних змін, складу, часу й видачі |
| `scripts/erp-demo.mjs` | Лише синтетична локальна база: 162 вироби, 3 майстри, 2 клієнти; відмовляється працювати в production або непорожній демобазі |
| `scripts/erp-browser-check.mjs` | Playwright перевірка локального UI та дій майстра, desktop/mobile скриншоти в ignored `data/` |
| `scripts/erp-crews-browser-check.mjs` | Власний disposable localhost8084 та два незалежні synthetic mobile учасники; створення, призначення, внески, старший |
| `scripts/erp-migration-check.mjs` | Відкриває source SQLite тільки read-only; двічі мігрує тимчасову `.backup`, перевіряє hashes старих таблиць/схем, quick_check і foreign keys, видаляє лише власну тимчасову копію |
| `scripts/erp-performance-check.mjs` | Ізольований in-memory smoke: 3000 виробів, 9000 операцій, 20 майстрів; не production load test |
| `scripts/check.mjs` | Переносні JS/Python перевірки для Windows і Linux |
| `.npmrc` | Вимкнені install hooks залежностей; їхні runtime artifacts уже входять до поточних пакетів |
| `docs/ERP.md` | Специфікація, ролі, обмеження, безпека, досліджені референси, наступні етапи |

## Історія перевірок першого релізу 0.24.0

- Повний набір тестів перед release: **20/20** (11 наявних + 9 ERP). Точний `npm ci`, `npm run check`, `npm test`, `npm audit --omit=dev` пройшли на Windows; відомих vulnerabilities за результатом audit — 0.
- Сценарій 150 виробів перевірений у транзакційних тестах, включно з rollback прийомки при дублікованому номері.
- Повторний Playwright пройшов з актуальним backend: обидві теми desktop/mobile, збереження теми після reload, навігація адміністратора, деталі замовлення, форма прийомки, ізоляція майстра, pause/resume/complete на телефоні, зміни, ширина 360 px, відсутність JS/CSP помилок. Чотири скриншоти перевірено візуально.
- Серверна пагінація/український пошук, версійність метаданих замовлення, аудит керівного закриття зміни й повторна міграція покриті новими тестами. Незалежний QC перевіряє також історичних виконавців до доробки/перепризначення.
- На локальній демобазі й на тимчасовій `.backup` production міграція двічі зберегла всі 16 старих таблиць та попередні migration markers; quick_check і foreign keys — ok. Source production відкривався тільки read-only.
- Локальний in-memory smoke: 3000 виробів / 9000 операцій / 20 майстрів, 40 snapshot-вимірювань: owner p95 6 ms, worker p95 2 ms, створення партій 223 ms. Це лише вузький smoke без мережі, диска й конкурентного навантаження, не гарантія місткості VPS.
- Read-only звірка VPS перед release: 62 runtime/test/deploy файли точно відповідають production `5a816f2`; origin/main усе ще `5000d27`. `laba-portal`, Caddy, `koro-kanban`, `koro-task`, SignalSynch активні. Розбіжностей коду з іншого ПК не виявлено.
- Production не використовувався для тестових переміщень, demo-клієнтів або майстрів.
- На VPS staging пройшли точні install/check/test/audit: **20/20**, audit 0. In-memory smoke: owner p95 14 ms, worker p95 3 ms, створення 20 партій 584 ms. Усі 88 файлів release archive після deployment відповідають Git `e430efd` за SHA-256.
- Live Chrome з Cloudflare-акаунтом власника перевірив головну → `Виробництво`, dark/light та persistence; сторінка залишена в темній темі. Без JWT ERP HTML/API/assets повертають 401. Резервна копія й rollback-каталог записані в `CURRENT_STATE.md`; Caddy і сусідні units незмінні.

## Локальний запуск

Node.js 22+, Python 3. Залежності не змінили версій. `better-sqlite3 13.0.3` містить готові N-API binaries: після `npm ci --ignore-scripts` SQLite працює на Windows без Visual Studio. Проєктний `.npmrc` тепер робить це стандартним `npm ci`. Native runtime перевіряється інтеграційними тестами; не додавати сліпе виконання postinstall.

```powershell
npm.cmd ci
$env:PYTHON='C:\path\to\python.exe' # лише якщо Python не в PATH
npm.cmd run check
npm.cmd test
npm.cmd audit --omit=dev

$env:AUTH_MODE='development'
$env:NODE_ENV='development'
$env:PORT='8083'
$env:DB_PATH="$PWD\data\erp-development.db"
node scripts/erp-demo.mjs # тільки один раз на порожній демобазі
node src/server.mjs
```

`http://127.0.0.1:8083/erp` — власник демобази; Playwright використовує лише development header для умовного `olena@example.test`. У production такий заголовок не авторизує користувача.

Для браузерних перевірок встановлений Chrome. `PLAYWRIGHT_MODULE` можна вказати на `index.mjs` доступного Playwright; машинні абсолютні runtime-шляхи не слід комітити. Скрипт працює лише з loopback `8083` та умовними даними. Перед повторенням після змін backend потрібно перезапустити локальний сервер; після завершення перевірок можна зупинити лише процес цього сервера.

## Release виконаний; як продовжувати без втрати іншого ПК

1. Після `fetch` прочитати всі нові commits, документацію й `git status`. Невідомі локальні зміни не видаляти/не reset. Наступну роботу відгалужувати від актуального main, не від застарілого checkpoint.
2. Не вважати весь план ERP виконаним. Спочатку пройти з власником пілотний workflow: клієнт → маршрут → прийомка → призначення → зміна майстра → операції → незалежний QC → часткова видача. Акаунти й справжні операції створювати тільки за наданими власником даними.
3. Наступні ітерації з `ERP.md`: склад/BOM/резерви й виправлення проводок компенсуючими операціями; зручний облік комплектуючих майстром із телефона; QR/фото/акти; аналітика за період/собівартість/зарплата. Наразі UI складу орієнтований на комірника/керівника; мобільна складська UI майстра ще не реалізована.
4. Перед масштабуванням додати пагінацію адміністративних списків понад задокументовані межі (200 замовлень, 500 партій запасів, 100 шаблонів, 1000 клієнтів) і профілювання справжнього багатокористувацького навантаження. Черга майстра вже має серверну пагінацію по 50.
5. Кожен значущий checkpoint: код + тести + пояснення рішень/меж у цьому файлі, commit і **push**. Локальний commit без push не забезпечує відновлення при втраті ПК. Спільну історію не force-push.
6. Перед кожним наступним release повторити checks/browser QA; на VPS staging — install/check/test/audit, `node scripts/erp-migration-check.mjs /opt/laba/data/portal.db`, performance smoke. Не запускати production seed/load tests.
7. Звірити origin/main та фактичний VPS, створити SQLite backup, розгорнути конкретний Git archive зі збереженням `.env`, `data/`, `backups/`. Rollback лише після перевірки семантичної сумісності (особливо shared-таймери 0.25.0); зберігати **актуальну** БД, не стирати нові ERP-проводки старим backup.
8. Після health/DB/auth/browser/sibling checks записати новий deployed SHA, backup/rollback та результати в `CURRENT_STATE.md`, push документації. Реліз не завершений, доки handoff лишається тільки на одному ПК.

## Доступ і відновлення

VPS, unit, шляхи та політика доступу описані в `DEPLOYMENT.md`/`CURRENT_STATE.md`. Пароль root, приватні SSH-ключі, Cloudflare JWT, `.env`, база, backup і реальні дані майстрів **не повинні бути в Git**. Для нового ПК потрібен окремий дозволений SSH-доступ або секрет із сховища власника; наявність Git-копії не замінює облікових даних.

Робоча база живе на VPS у `/opt/laba/data/portal.db`, а не на цьому ПК. Локальна `data/erp-development.db` — одноразова демонстрація, її втрата не впливає на бізнес. Код, schema migration, тести, deployment-рецепт і цей handoff відтворюються з Git. Копія production поза VPS поки не налаштована — її не можна вважати вирішеною лише через збереження коду в Git.
