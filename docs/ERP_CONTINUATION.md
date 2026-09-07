# Продовження ERP з іншого ПК

Оновлено: 2026-09-07. Цей файл описує незавершену розробку окремо від останнього підтвердженого production у `CURRENT_STATE.md`.

## Репозиторій та гілка

- Репозиторій: `https://github.com/KORO-GIT/laba` (не `kanban`, не Task).
- Робоча гілка першого ERP-релізу: `codex/laba-erp`.
- База гілки: `5000d27` — документація production LABA `0.23.3`.
- Версія розробки: `0.24.0`.
- На момент цього проміжного checkpoint ERP ще **не розгорнуто в production**. Не вважати номер у `package.json` підтвердженням deployment.
- Працюючі `/workshop`, `/service`, `/devices`, SignalSynch та Task не мігруються в ERP і не замінюються.

```powershell
git clone https://github.com/KORO-GIT/laba.git
cd laba
git fetch origin
git switch --track origin/codex/laba-erp
# Якщо гілка вже існує:
# git switch codex/laba-erp
# git pull --ff-only
git status --short --branch
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

## Файли та відповідальність

| Файл | Призначення |
|---|---|
| `src/erp-database.mjs` | Адитивна схема `erp_*`, бізнес-інваріанти, транзакційні команди, склад, час, контроль, видача |
| `src/erp-routes.mjs` | Строгі Zod-схеми, ERP ACL, exact-Origin CSRF, UUID ідемпотентності, ліміти, маршрути `/api/erp/*` |
| `src/server.mjs` | Підключення ERP до наявного Fastify й авторизації; запис у список модулів |
| `public/erp.html`, `erp.js` | Адміністративні екрани й мобільна черга майстра; DOM/textContent для користувацького вводу |
| `public/erp.css`, `erp-responsive.css` | Компонування, компоненти, mobile breakpoints |
| `public/erp-theme.css`, `erp-theme.js` | Темна/світла палітра LABA; раннє завантаження теми без світлого спалаху; збереження тільки `laba.theme` |
| `public/erp.webmanifest` | Ярлик робочого місця майстра; немає service worker/offline-черги |
| `test/erp.test.mjs` | Поведінкові тести цілісності, прав, retry, конкурентних змін, складу, часу й видачі |
| `scripts/erp-demo.mjs` | Лише синтетична локальна база: 162 вироби, 3 майстри, 2 клієнти; відмовляється працювати в production або непорожній демобазі |
| `scripts/erp-browser-check.mjs` | Playwright перевірка локального UI та дій майстра, desktop/mobile скриншоти в ignored `data/` |
| `scripts/erp-migration-check.mjs` | Відкриває source SQLite тільки read-only; двічі мігрує тимчасову `.backup`, перевіряє hashes старих таблиць/схем, quick_check і foreign keys, видаляє лише власну тимчасову копію |
| `scripts/erp-performance-check.mjs` | Ізольований in-memory smoke: 3000 виробів, 9000 операцій, 20 майстрів; не production load test |
| `scripts/check.mjs` | Переносні JS/Python перевірки для Windows і Linux |
| `.npmrc` | Вимкнені install hooks залежностей; їхні runtime artifacts уже входять до поточних пакетів |
| `docs/ERP.md` | Специфікація, ролі, обмеження, безпека, досліджені референси, наступні етапи |

## Стан перевірок цього checkpoint

- Повний набір тестів перед release: **20/20** (11 наявних + 9 ERP). Точний `npm ci`, `npm run check`, `npm test`, `npm audit --omit=dev` пройшли на Windows; відомих vulnerabilities за результатом audit — 0.
- Сценарій 150 виробів перевірений у транзакційних тестах, включно з rollback прийомки при дублікованому номері.
- Повторний Playwright пройшов з актуальним backend: обидві теми desktop/mobile, збереження теми після reload, навігація адміністратора, деталі замовлення, форма прийомки, ізоляція майстра, pause/resume/complete на телефоні, зміни, ширина 360 px, відсутність JS/CSP помилок. Чотири скриншоти перевірено візуально.
- Серверна пагінація/український пошук, версійність метаданих замовлення, аудит керівного закриття зміни й повторна міграція покриті новими тестами. Незалежний QC перевіряє також історичних виконавців до доробки/перепризначення.
- На локальній демобазі міграція двічі зберегла всі 16 старих таблиць; quick_check і foreign keys — ok. Повторити на read-only копії production перед першим запуском.
- Локальний in-memory smoke: 3000 виробів / 9000 операцій / 20 майстрів, 40 snapshot-вимірювань: owner p95 6 ms, worker p95 2 ms, створення партій 223 ms. Це лише вузький smoke без мережі, диска й конкурентного навантаження, не гарантія місткості VPS.
- Read-only звірка VPS перед release: 62 runtime/test/deploy файли точно відповідають production `5a816f2`; origin/main усе ще `5000d27`. `laba-portal`, Caddy, `koro-kanban`, `koro-task`, SignalSynch активні. Розбіжностей коду з іншого ПК не виявлено.
- Production не використовувався для тестових переміщень, demo-клієнтів або майстрів.

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

## Що доробити перед release

1. Локальні behavioral/browser/security checks виконані; після будь-якої наступної зміни повторити відповідні перевірки.
2. На VPS виконати `node scripts/erp-migration-check.mjs /opt/laba/data/portal.db` з staging-каталогу: скрипт сам створює тимчасову копію й не змінює source. `403` для користувача без ERP-ролі покритий API-тестами.
3. Повторити `npm ci`, `npm run check`, `npm test`, `npm audit --omit=dev` та `node scripts/erp-performance-check.mjs` на staging, не навантажувати production.
4. `README`, `SECURITY`, `DEPLOYMENT` оновлені. Усі незавершені модулі з `ERP.md` залишаються планом, а не нібито реалізованими функціями.
5. `git fetch origin`, повторно звірити main та production code з базою безпосередньо перед switch. Секрети не виводити. Створити і перевірити SQLite `.backup`.
6. Протестувати точний release archive в окремому staging-каталозі на VPS. Після успіху виконати звичайний LABA deployment зі збереженням `.env`, `data/`, `backups/`.
7. ERP додає таблиці, але не змінює старі робочі дані. Для rollback спочатку повернути код; автоматично не відновлювати стару БД, щоб не втратити нові ERP-проводки.
8. Перевірити health, SQLite quick_check, логи, browser assets, незмінність Caddy й сусідніх сервісів. Оновити `CURRENT_STATE.md` точним deployed commit і backup/rollback шляхами.
9. Після merge залишити документований зв’язок feature branch → main → deployed code. Ніколи не force-push спільну історію.

## Доступ і відновлення

VPS, unit, шляхи та політика доступу описані в `DEPLOYMENT.md`/`CURRENT_STATE.md`. Пароль root, приватні SSH-ключі, Cloudflare JWT, `.env`, база, backup і реальні дані майстрів **не повинні бути в Git**. Для нового ПК потрібен окремий дозволений SSH-доступ або секрет із сховища власника; наявність Git-копії не замінює облікових даних.

Робоча база живе на VPS у `/opt/laba/data/portal.db`, а не на цьому ПК. Локальна `data/erp-development.db` — одноразова демонстрація, її втрата не впливає на бізнес. Код, schema migration, тести, deployment-рецепт і цей handoff відтворюються з Git. Копія production поза VPS поки не налаштована — її не можна вважати вирішеною лише через збереження коду в Git.
