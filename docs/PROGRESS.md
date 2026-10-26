# PROGRESS — ملخص المشروع وما أُنجز حتى الآن

> **اقرأ هذا الملف قبل أي عمل.** يُحمَّل تلقائيًا من `CLAUDE.md` في بداية كل جلسة.
> مختصر عمدًا: التفاصيل في الوثائق الست (`docs/01`–`06`)، والمراجعة الأمنية في `docs/09`. **حدّثه في كل commit** يغيّر الحالة
> (مهمة أُنجزت، اختبار جديد، قرار، مشكلة معروفة). آخر تحديث: 25 أكتوبر 2026.

## 1. المشروع والقرارات المعتمدة

- **ClinicSystem EG**: نظام إدارة عيادات عربي (RTL) يتحول من عيادة واحدة إلى SaaS متعدد العيادات. المرجع: `docs/ClinicSystem_EG_BRD_AR_v1.1.pdf`.
- المستودع `hussein-alali/SaaS-Clinik`، الفرع `claude/tender-wright-0luu9p`. **لا PR إلا بطلب صريح.**
- قرارات المالك: النطاق `https://clinicsyseg.com/` (عيادة = `<slug>.clinicsyseg.com`، المنصة = `admin.`)؛ مدير العيادة يدعو موظفيه ضمن حدود الخطة، وإنشاء العيادات حكر على Super Admin؛ تخصص رئيسي واحد أولًا (علاج طبيعي) مع قابلية التوسع؛ اشتراك يدوي من لوحة Super Admin؛ حدود الخطط تُحدد تجاريًا (قابلة للضبط)؛ الفروع ضمن النواة المشتركة لكل التخصصات؛ بيانات العيادة الموقوفة تُحفظ 6 أشهر.
- **قاعدة البيانات تنتقل كليًا من Supabase إلى hosting.com** (cPanel: PostgreSQL ≥ 13 + Setup Node.js App). لا extensions، ولا superuser، ولا أسرار في Git أو الواجهة.

## 2. البنية (الحالة الحالية)

| الطبقة | المكان | ملاحظات |
|---|---|---|
| الواجهة | `src/*.jsx` | React 18، سكربتات classic تتشارك globals (بلا imports)، تُجمع بترتيب `index.html` عبر esbuild (`scripts/build.mjs` → `dist/app.<hash>.js`؛ ملفات عند الحاجة: `import.<hash>.js` مع `?import=1`، و `platform.<hash>.js` في سياق المنصة، و `lang-en.<hash>.js` بالإنجليزية). ملف جديد = سطر في `index.html` |
| اللغتان | `src/i18n.jsx` + `src/lang/en-*.jsx` | `tt("نص عربي")` (المفتاح هو النص العربي حرفيًا)، `ttx` لجمل فيها عناصر، `ttc("context", ...)` لكلمة بترجمتين؛ `fmtMoney`/`fmtDate`/`fmtNumber`؛ اللغة من `?lang=` ← cookie `clinicsys_lang` ← `localStorage` ← العربية، والتغيير يعيد التحميل؛ `X-Lang` للـ API؛ البريد بلغتين |
| العميل | `src/apiclient.jsx` | بديل متوافق مع `supabase-js` (`window.supabase.createClient`) يكلّم `/api`؛ ترويسات `X-Requested-With: clinicsys` و `X-Org-Slug` و `X-Branch-Id` و `X-Platform: 1`؛ `newRecordId(prefix)` |
| شاشات SaaS | `src/tenant.jsx` (حل العيادة، الدخول، الدعوة، الاستعادة)، `src/screens3.jsx` (الإعدادات، الموظفون C06، الفروع C07، واجهة العيادة `ClinicApp`، صفحة «ليست لديك صلاحية»، بوابة المريض)، `src/platform.jsx` (A01–A08)، `src/errors.jsx` (تقارير الأخطاء و `ErrorBoundary`)، `src/roles.jsx` (`ROUTE_MODULES`) | `screens2.jsx` قُسّم إلى `screens2.jsx` + `screens3.jsx` |
| الـ API | `api/` (Express 5، `app.js`) | `/api/auth/*`، `/api/orgs/*`، `/api/data` (قائمة سماح بدل PostgREST، حد 1000 صف، ويضيف `organization_id` للعيادة الحالية)، `/api/rpc` (23 دالة، `Idempotency-Key` اختياري)، `/api/files` (روابط HMAC ≤ 600 ث)، `/api/admin/*`، `/api/org/*` (الدعوات، الأعضاء، الاستخدام)، `/api/invitations/:token`، `/api/platform/*`، `/api/webhooks/:provider` (موقّع، بلا جلسة، S10)؛ `403 module_disabled` من `api/src/modules.js` |
| الجلسة | cookie `cs_session` | JWT `{sub, sv}` مع `session_version`؛ العيادة من `Host` أو `X-Org-Slug`؛ المنصة من `admin.<base>` أو `X-Platform: 1` (غير الإنتاج) |
| القاعدة | `db/migrations/0001`–`0018` | `0001_baseline`، `0002_platform`، `0003_tenancy`، `0004_audit_integrity`، `0005_branches_no_delete`، `0006_staff_role`، `0007_rpc_role_guards`، `0008_invitation_email_status`، `0009_inactive_branch_guard`، `0010_concurrency`، `0011_rate_limits`، `0012_error_log`، `0013_jobs`، `0014_usage`، `0015_indexes`، `0016_invoices_rpc_org`، `0017_safe_file_urls`، `0018_clinical_records`. **التالي `0019`. لا تعدّل migration مطبّقًا.** من `0010`: expand/contract (الحذف/إعادة التسمية/تغيير النوع/`set not null` بسطر `-- contract: <السبب>` قبلها). |
| العزل | PostgreSQL RLS | `set_config` لـ `app.user_id/org_id/branch_id/system` لكل معاملة؛ FORCE RLS + `tenant_isolation` (RESTRICTIVE) + `branch_scope`؛ `organization_id DEFAULT app_org_id()`؛ triggers حدود الخطة بـ SQLSTATE `PL422` (→ 422)، والفرع المعطّل بـ `BR409` (→ `409 branch_inactive`)، والموعد المحجوز بـ `BK409` (→ `409 slot_taken`)؛ الأدوار admin/receptionist/doctor/therapist/staff |

ربط الوحدات (API + واجهة): `core.patients`→patients؛ `core.appointments`→bookings، patient_schedules؛ `core.files`→patient_files وكل `/api/files` (bucket `patient-files`)؛ `core.billing`→invoices، payments، payment_receipts، packages، patient_subscriptions + 3 RPC؛ `physio.sessions`→sessions؛ `physio.treatment_plans`→treatments؛ `physio.templates`→جداول القوالب.

## 3. التشغيل والاختبار

```bash
npm install --no-audit --no-fund && npm run build          # → dist/
scripts/dev-stack.sh start 54329 3100   # قاعدة جديدة + migrations + بذر + build + API
#   http://localhost:3100/?org=demo-physio   |   http://localhost:3100/?platform=1
scripts/dev-stack.sh stop 54329 3100
URL=$(scripts/dev-db.sh reset 54400)    # قاعدة اختبار فارغة
DATABASE_URL=$URL node --test 'db/test/*.test.js' 'api/test/*.test.js'
npm test                                # اختبارات العميل (test/*.test.mjs)
E2E_DB_PORT=56100 E2E_API_PORT=3200 npx playwright test -c e2e/playwright.config.cjs
```

- حسابات البذر (تطوير فقط، كلمة المرور `Dev@12345`): `super@clinicsys.test`؛ `admin|receptionist|doctor|therapist@demo-physio.test` و `@demo-dental.test`؛ `receptionist2@<slug>.test` (الفرعان)؛ الفروع `br-<slug>-1/2`.
- البريد في التطوير يُكتب إلى `api/.outbox-<port>/`. اختبارات الـ API تمسح القاعدة وتعيد بذرها وترفض قاعدة غير اختبارية — **لا توجّهها لقاعدة حقيقية أبدًا.**

## 4. ما أُنجز (بالترتيب)

| المرحلة | الإنجاز | Commit |
|---|---|---|
| الوثائق | BRD v1.1 (الفروع في النواة + قرارات المالك)، الوثائق الست، تدقيق الأداء (07)، خطة hosting.com (08) | `fe0e55e`، `2bbd4bc`، `96f9fc5` |
| M1 الأداء | نقل `src/`؛ ترجمة مسبقة بـ esbuild (أول شاشة 5,962 → ~125 ms)؛ Excel والاستيراد عند الحاجة؛ تحميل الجداول بالتوازي + `selectAllRows` بعد حد 1000 صف | `baebfa9`، `ddd7943`، `11a2c43`، `04abbe3` |
| M2 القاعدة والـ API | baseline بلا Supabase، جداول المنصة، تعدد العيادات + الفروع + RLS، اختبارات العزل، الـ API كاملًا، العميل `apiclient.jsx`؛ مراجعة أمنية أصلحت 5 ثغرات (تزوير السجل `0004`، الاستيلاء عبر `create-user`، ReDoS، `COOKIE_SECURE`، حارس أسرار التطوير)؛ مراجعة العقد (28 اختبار توافق) | `a1538eb`، `b60fd08` |
| M3 رحلة المستخدم | حل العيادة وصفحات الحالة، الدخول والتوجيه، قبول الدعوة، سياق العيادة/الفرع، القائمة حسب الوحدات والدور، لوحة Super Admin، الفروع C07 (تعطيل لا حذف)، الموظفون والدعوات C06، قائمة التهيئة، `staff` role، `Modal` بدلالات dialog، تسميات السجل بالعربية؛ e2e لكل الرحلات J1–J4 و AT-01..10، AT-13..16 | `38d0183`، `c9cd30b`، `e484ff4`، `8a83f6d` |
| `PROGRESS.md` | هذا الملف ويُحمّل من `CLAUDE.md` | `49413fb` |
| البند 9 | 2.9 فحوص الأدوار في RPC (`0007`)؛ 3.15 `invitations.email_status` (`0008`) وشاراته في C06 و A04؛ 3.16 `core.files` في `/api/files`؛ 3.17 حبس التركيز في `Modal`؛ 3.18 رفض الصفوف الجديدة على فرع معطّل (`0009`)؛ 3.19 «كل الفروع» في التقارير للمدير (`KineticData.listAllBranches`) | `8e60bcd` |
| 3.10 UX وإمكانية الوصول | لقطات كل الشاشات (1280×800 و 390×844) + axe-core على 77 عرضًا؛ 49 إصلاحًا: `useDialogFocus` لكل النوافذ، لوحة الأوامر combobox، لوحة المفاتيح في التقويم وقائمة «⋯»، رابط التخطي، حلقة تركيز موحدة، التباين (`--blue-700` = `#33709E`، `--ink-500` = `#5B6C7C`)، التسميات و `<h1>`، أهداف لمس ≥ 40px، نماذج الدخول على الجوال، أرقام لاتينية، إزالة الإنجليزية، الجنس `F`/`M` | `ca05334` |
| S2 النشر والتراجع | `GET /api/health`؛ `scripts/package-release.sh` ← `scripts/deploy.sh` (نسخة، migrations، تبديل `current` ذري، فحص صحة، عودة تلقائية، آخر 5 إصدارات) و `scripts/rollback.sh`؛ في cPanel: Application root = `clinicsys/current/api` | `896198c` |
| 3.34 | مؤقت Toast قديم كان يغلق Toast أحدث (ترحيب الدخول أغلق «تمت إضافة القسم»): `useToast()` في `src/ui.jsx` | `8ce9a38` |
| S8 تنبيهات الموارد | `0014_usage` + `api/src/usage.js`: كل ساعة القاعدة + الملفات + النسخ مقابل `DISK_QUOTA_MB`، والبريد مقابل `SMTP_HOURLY_LIMIT`/`SMTP_DAILY_LIMIT`؛ 70/85/95% ← رسالة لمديري المنصة مرة لكل مستوى في اليوم، و «انتهى الخطر»؛ مهام البريد تنتظر الساعة التالية (`jobs.defer`)؛ `GET /api/platform/usage` و «الموارد» في A01 | `1eebdd0` |
| S9 N+1 والتحميل | نافذة البدء: الحجوزات والجلسات والفواتير والمدفوعات من اليوم − 180 يومًا والقادم (+ الفواتير غير المسددة كلها والحجوزات والجلسات بلا تاريخ)، والأقدم عند الطلب (`KineticData.loadOlder({ from | patientId })`، `listRange`، `useOlderRows`): ملف المريض، التقارير، التقويم، ترقيم الجلسة، بوابة المريض؛ `/api/data` يضيف `organization_id = <العيادة>` (صيغة `OR` في RLS لا تصلح شرط فهرس) و `0015_indexes`؛ `db.queryCount()` واختبار ثبات عدد الاستعلامات للقوائم؛ Maps في `normalizeDomainData` | `b0a5e3b` |
| S10 Webhooks | `api/src/webhooks.js`: `WEBHOOK_<NAME>_SECRET` يفتح `POST /api/webhooks/<name>` (قبل CSRF والجلسة وقارئ JSON)؛ HMAC-SHA256 لـ `<id>.<timestamp>.<body>` بمقارنة ثابتة الزمن ونافذة 5 دقائق، ومعرّف الحدث في `idempotency_keys` (30 يومًا)، ومهمة `webhook.<name>.<type>` والرد فوري؛ لا مزوّد اليوم | `28d3511` |
| مراجعة S1–S10 | 15 ملاحظة، 12 أُصلحت باختبار يفشل أولًا: مهلة 10 د لمعاملة المهمة وحدود وقت SMTP، `countSends` في Cron، توقيع معرّف الحدث، إعادة قراءة السجل الأقدم للمرضى عند التحديث، تدوير `db-only` منفصل، فحص الصحة باسم الإصدار وعلى `APP_BASE_DOMAIN`، لا حد مشترك بلا IP، مفتاح الدفع مرتبط بمحتواه (`QuickPay.attempt`)، `FILES_DIR` إلزامي في الإنتاج، «انتهى الخطر» مرة لكل تنبيه، فحص migrations أوسع من `0016`، `0016_invoices_rpc_org`؛ بقيت 3 بسببها (الحالة الفارغة للفواتير ← 4.7، اتصال ثانٍ في حد الدعوات، حد الطلبات المجهولة لكل IP)؛ قسم «الجاهزية للتوسع» الدائم في `docs/02` | `b0f979e` |
| السجلات السريرية CR1 | `0018_clinical_records`: `specialties.diagnosis_form` (physio/dental/general، يختاره Super Admin بـ `PATCH /api/platform/specialties/:code`)، `assessments` (نقاط الألم `[[x, y]]` فقط)، `dental_findings` (FDI)، `prescriptions`؛ للـ admin والطبيب والأخصائي فقط، والمؤلف من الجلسة؛ `dental.chart` و `general.visits` و `general.prescriptions` نشطة؛ `diagnosis_form` في `resolve`/`current` | (هذا الـ commit) |
| المراجعة الأمنية | التقرير `docs/09` (18 ملاحظة). أُصلح باختبار يفشل أولًا: XSS مخزَّن عبر `file_url` ← `window.open` (`safeUrl` + `0017_safe_file_urls`)، CSP (meta من البناء + ترويسة الـ API مع `frame-ancestors`، وكل e2e يفشل عند مخالفة)، SRI لمكتبة Excel، IP الدفع من الخادم (حذف `api.ipify.org`)، `PGPASSWORD` بدل الرابط في أدوات النسخ، النسخ `0700`/`0600`، `server.js --dev` يخدم ملفات التطبيق فقط، `multer` 2.5.0 و `body-parser` 2.4.0؛ `api/test/attacks.test.js` فهرس الهجمات بحسب CWE (11)؛ `nodemailer` 9 بضابط تعويضي حتى Node 20 | (هذا الـ commit) |
| S7 المهام الخلفية | `0013_jobs` + `api/src/jobs.js` (SKIP LOCKED، savepoint، backoff حتى 6 س، ميتة بعد 5) + `job-handlers.js`: إعادة بريد الدعوة والاستعادة الفاشل برابط جديد (الحمولة معرّفات فقط)، `maintenance.daily` مرة في اليوم؛ `scripts/run-jobs.js` (Cron كل دقيقة) ومؤقت في الـ API (`JOBS_POLL_MS`)؛ `mail_log` لكل رسالة دون العنوان؛ بطاقتان في A01 | `29cc972` |
| S6 تتبّع الأخطاء | `0012_error_log` + `api/src/errorlog.js` (تنقية البريد والأرقام، fingerprint، عينة/دقيقة، لا يرمي أبدًا): `5xx` في `errorHandler` (بعد الرد)، و `unhandledRejection`/`uncaughtException` في `api/app.js`، و `POST /api/client-errors`؛ `src/errors.jsx` (`window.onerror`، `ErrorBoundary` حول كل صفحة في العيادة والمنصة: «حدث خطأ في هذه الصفحة» + «إعادة المحاولة»)؛ A08 «الأخطاء» وبطاقة A01؛ إصلاح البناء: `import` و `platform` بـ `format: "iife"` (مساعدات esbuild كانت تتصادم وتعطل لوحة المنصة) | `e7f3c83` |
| S5 حدود الطلبات | `0011_rate_limits` + `api/src/ratelimit.js`: عدادات مشتركة بين عمليات Passenger (نوافذ ثابتة، sha256 للمفتاح): الدخول/القبول 10 خاطئة لكل بريد و 50 لكل IP في 15 د، الاستعادة 20/س لكل IP و 3 رسائل/س لكل حساب، الدعوات 5/يوم لكل بريد و 200/يوم لكل عيادة (2.19)، الرموز المجهولة 30/10 د لكل IP، الرفع 120/س، و `API_RATE_PER_MIN` (600) لكل جلسة في كل عملية؛ `429 rate_limited` + `Retry-After`؛ الحفظ المرفوض يعرض النص بلغة الصفحة | `1dac5ee` |
| S4 التعارض | `0010_concurrency`: حجز نشط واحد لكل أخصائي/طبيب وموعد (trigger + قفل advisory، يرى كل الفروع؛ `BK409` → `409 slot_taken` ورسالة «هذا الموعد محجوز بالفعل» وتحديث التقويم)؛ إيصالات `RCT-<يوم>-00001…` من عدّاد لكل عيادة ويوم (كانت عشوائية وتتصادم)؛ `new_record_id()` لـ `PMT-`؛ `Idempotency-Key` على `/api/rpc` (`api/src/idempotency.js`) ومفتاح لكل محاولة دفع سريعة | `871443d` |
| S3 القاعدة الحية | `migrate.js`: `lock_timeout` 5 ث و `statement_timeout` 15 د لكل ملف، رفض الإنتاج بلا نسخة أحدث من ساعتين (خروج 5، `--no-backup-check`)، فحص expand/contract من `0010` (`-- contract:`)؛ `deploy.sh` يأخذ نسخة أول نشر من الإصدار الجديد ويشغّل الـ migrations بـ `NODE_ENV=production`؛ `shared/env` في الـ Runbook | `9f7a6b0` |
| S1 النسخ الاحتياطي | `scripts/backup.sh` (dump + ملفات + manifest من لقطة واحدة، تدوير 7+4، رفض المكان غير الآمن والقرص الممتلئ) و `scripts/restore-check.sh` (استرجاع في `<db>_restore` ومطابقة كل جدول)؛ الأوامر في `docs/08` «Runbook» | `0203d80` |
| 3.33 | الـ Toast في لوحة المنصة يمرر النقر (كان يبتلع النقر على الجزء المغطى من «إنشاء عيادة») | `ad02e1b` |
| اللغتان + القرارات | واجهة عربي/English كاملة (3.29، 6 وكلاء، 2,314 نصًا)، البريد بلغتين، cookie اللغة بين النطاقات؛ قرارات بتفويض المالك: «ج.م»/«EGP»، 44px، منتقي المتصفح، ترجمة بوابة المريض؛ 3.11 صفحة «ليست لديك صلاحية»، 3.12 لوحة المنصة ملف منفصل، 3.20 `CardTable`، 3.22 ترتيب Tab، 3.23 درج الجوال نافذة، 3.24 `Segmented`؛ إصلاح `SessionTimeline: null` (كان يكسر سجل الجلسات في الإنتاج) | `df01254`…`096ea3f` |

**آخر نتائج تحقق (المراجعة الأمنية، قواعد جديدة):** القاعدة + الـ API: 311 نجاحًا، 0 فشل، 2 متخطّيان؛ العميل 138/138؛ e2e: 136 نجاحًا و 2 متخطّيان (منها 53 بالإنجليزية في `e2e/i18n-*.spec.cjs`، وكلها تفشل عند أي مخالفة CSP)؛ `npm audit`: `api/` 1 عالية (`nodemailer`، مقبولة مؤقتًا)، `/` 1 متوسطة (`esbuild serve`، غير منطبقة)، `db/` 0؛ الحجم gzip مع React و `index.html`: ≈ 254 KB بالعربية و ≈ 289 KB بالإنجليزية لمستخدمي العيادات (الميزانية 300).

## 5. المفتوح الآن

**منجز:** الجاهزية لنحو 1,000 مستخدم (S1–S10 في `docs/06`، الخطة `docs/superpowers/plans/2026-10-25-scale-readiness.md`)، كلها داخل hosting.com، وصارت متطلبات دائمة في `docs/02-TRD.md` «الجاهزية للتوسع»: ~~S1 النسخ~~ ✅، ~~S2 التراجع~~ ✅، ~~S3 القاعدة الحية~~ ✅، ~~S4 التعارض~~ ✅، ~~S5 حدود الطلبات~~ ✅، ~~S6 الأخطاء~~ ✅، ~~S7 المهام الخلفية~~ ✅، ~~S8 تنبيهات الموارد~~ ✅، ~~S9 N+1 والتحميل~~ ✅، ~~S10 Webhooks~~ ✅.

**قيد التنفيذ:** السجلات السريرية حسب التخصص (CR1–CR5 في `docs/06`، الخطة `docs/superpowers/plans/2026-10-26-specialty-clinical-records.md`): ~~CR1 القاعدة والـ API~~ ✅، CR2 العلاج الطبيعي (التشخيص كان في `localStorage` فقط)، CR3 الأسنان، CR4 العام والوصفات، CR5 Super Admin.

**مفتوح من العمل الأخير:** 3.31 مراجعة النص الإنجليزي (المالك)؛ 3.32 ترجمة مكتبة القوالب العامة أم لا (المالك)؛ **المراجعة الأمنية (SEC8، `docs/09` §7):** تدوير كلمة مرور المدير القديمة ثم حذفها من `seed-admin.sql` و `Supabase_All_In_One.sql` (1.2، أولوية)، و `nodemailer` 10 بعد تأكيد Node ≥ 20 (1.15)، وأسئلة PRD 8 و 9 و 11.

**لاحقًا:** 1.2 تنظيف الأسرار (`seed-admin.sql` و `Supabase_All_In_One.sql` فيهما كلمة مرور المدير القديمة، وهي في تاريخ Git: تُدوَّر أولًا)؛ 1.5 Vite؛ 1.14 تحميل البيانات حسب الشاشة؛ 2.1 نسخة Supabase؛ 2.10 المتبقي: مولدات القوالب في SQL (`TPL-`، `TM-`، `TU-`، `TPC-`)؛ 2.16–2.18؛ 3.13 proxy لـ `npm run dev`؛ 3.14 بحث العيادات في A07؛ Milestones 4–6 (ترحيل بيانات Supabase في 4.7).

**ينتظر المالك:** 1.15 أسئلة hosting.com (إصدار PostgreSQL و Node، صلاحية `CREATE` على `public`، Passenger و `TRUST_PROXY`، عدد العمليات، حدود LVE، wildcard + SSL، حد SMTP)؛ أسئلة PRD 1–5 و 8–14 (الشعار/الألوان، ما بعد 6 أشهر، وحدات الأسنان/الطب العام، أرقام الخطط، تغيير الـ slug، إبطال الجلسة عند الخروج، كلمة المرور الحالية، إغلاق عيادة غير مفعّلة، الحد الأدنى لكلمة المرور 6 أم 8، فرض الوحدات في القاعدة، «اطلب دعوة جديدة»، شاشات `staff`).

## 6. ملاحظات عمل (تجنّب تكرار الأخطاء)

- **طريقة العمل (Superpowers، `obra/superpowers`، بطلب المالك):** خطأ أو اختبار فاشل ← `systematic-debugging` (السبب الجذري قبل أي إصلاح)؛ كل إصلاح أو ميزة ← `test-driven-development` (اختبار يفشل أولًا ويُرى فاشلًا، ثم أقل كود)؛ قبل أي «تم» أو commit ← `verification-before-completion` (تشغيل الأوامر كاملة الآن وقراءة نتيجتها)؛ ميزة جديدة ← `brainstorming` ثم `writing-plans`. الإضافة تُثبَّت من كتالوج الإضافات (Anthropic Directory: Superpowers).

- **الجاهزية للتوسع (دائم):** كل ميزة أو تعديل يُراجع قبل الـ commit على البنود العشرة في `docs/02-TRD.md` «الجاهزية للتوسع» (التعارض، N+1 والتحميل، الأخطاء، حدود الطلبات، المهام الخلفية، الموارد، التراجع، القاعدة الحية، Webhooks، النسخ)، وما لا ينطبق يُذكر سببه. استعلام SQL جديد يذكر `organization_id` صراحة بجانب RLS.
- **الأمان (المراجعة 25 أكتوبر، `docs/09` §8):** رابط من البيانات ← `safeUrl()` قبل `window.open`/`href` (وعمود رابط يكتبه الأعضاء ← CHECK مثل `0017`)؛ لا `onclick=""` ولا `javascript:` (CSP تمنعهما وكل e2e يفشل)؛ سكربت مضمَّن جديد في `index.html` يدخل السياسة تلقائيًا (hash عند البناء)، وسكربت CDN جديد = عنوان كامل بإصدار مكتوب نصًّا في المصدر + SRI (`loadScriptOnce(src, integrity)`)؛ لا طلب من المتصفح لخدمة خارجية (`connect-src 'self'`)؛ قيمة يعرفها الخادم (IP، المستخدم) لا تُقبل من العميل (`SERVER_ARGS` في `rpc.js`)؛ لا أسرار في سطر أوامر (`PGPASSWORD`)؛ اختبار e2e يتوقع مخالفات CSP يفرغ `context.cspViolations` بعد فحصها؛ اختبار في vm يحتاج `URL` في نافذته (`safeUrl`).
- **السجلات السريرية (`0018`):** `assessments` و `dental_findings` و `prescriptions` غير مقيدة بالفرع، وتُقرأ عند فتح ملف المريض لا عند البدء؛ النقاط `[[x, y]]` نسبة مئوية من `assets/body-diagram.jpeg` (المنظر من `x`)، والصورة لا تُخزن أبدًا؛ مخطط الأسنان لا يُعكس في RTL. جدول عيادة جديد يحتاج صف بذر في `demo-physio` و `demo-dental` (اختبار العزل ينسخه)، وعمود مصفوفة PostgreSQL (`text[]`) يُمرَّر كما هو لا JSON (`array_cols` في `db/test/helpers.js`).
- **الوثائق الست** تُحدّث في نفس الـ commit مع صف في `## سجل التغييرات` (عربي، والمعرّفات بالإنجليزية) — ومعها هذا الملف.
- ملفات CRLF يجب أن تبقى CRLF: `index.html`، `package.json`، `server.js`، `README.md`، `DEPLOY.md`، `.gitignore`.
- unpkg و jsdelivr محجوبان في الحاوية: Playwright يستخدم `scripts/pw-cdn.cjs`. لا `playwright install`.
- `node --test dir/` يفشل على Node 21+ → استخدم globs. `npm audit` يعلق → `--no-audit`.
- `pkill -f`/`pgrep -f` يطابقان الـ shell نفسه (خروج 144) → نمط مثل `"node serve[r].js"` أو ملف PID.
- عملية الـ API في الخلفية يجب ألا ترث stdout (`exec ... </dev/null >log 2>&1 &`).
- الوكلاء يتوقفون بحد الاستخدام: commit نقاط حفظ متكررة، ومنافذ مختلفة لكل وكيل.
- `npm run dev` لا يخدم `/api` (المهمة 3.13): للتجربة الكاملة استخدم `dev-stack.sh`.
- لا `git stash` أثناء عمل وكيل آخر في نفس الشجرة: يرجّع ملفاته مؤقتًا.
- فحص الوصول: `npm install --no-save --no-audit --no-fund axe-core` ثم حقن `node_modules/axe-core/axe.min.js` بـ `page.addScriptTag` (ليس في `package.json`).
- أي نافذة جديدة تستخدم `Modal` أو `useDialogFocus` من `src/ui.jsx`، والأرقام لاتينية دائمًا. الـ Toast عبر `window.showToast` أو `useToast()`، لا `setToast` + `setTimeout`.
- حجز نشط واحد لكل أخصائي/طبيب وموعد (`0010`): أي اختبار ينسخ حجزًا أو يحجز موعدًا مأخوذًا يأخذ `BK409`؛ استخدم وقتًا أو تاريخًا خاصًا بالاختبار. والمعرّفات `therapist_id`/`doctor_id` مقيدة بـ FK (`ST-PHY-THERAPIST`، `TH-PHY-2`، `DR-PHY-1`...). الجداول التشغيلية (`org_counters`، `idempotency_keys`...) تُضاف إلى `PLATFORM_TABLES` وإلى قائمتي `isolation.test.js` و `baseline.test.js`.
- حدود الطلبات نوافذ ثابتة: اختبار يعدّ محاولات يجب ألا يعبر حد نافذة، لذلك `api/test/helpers.js` يثبّت ساعة الحدود (`RATE_LIMIT_NOW`، لا يقرؤها إلا `src/ratelimit.js`، ومُهملة في الإنتاج)؛ e2e كله من `127.0.0.1` فلا تُضف حدًا يعدّ الطلبات الصحيحة لكل IP.
- **نافذة البيانات (S9):** `window.DATA` يحمل الحجوزات والجلسات والفواتير والمدفوعات من `KineticData.windowFrom()` (اليوم − 180) فقط، والفواتير غير المسددة كلها، وما بلا تاريخ. شاشة تعرض فترة أقدم أو سجل مريض كاملًا تستدعي `useOlderRows({ from | patientId })` (أو `KineticData.loadOlder`)، وعرض لا يجب أن يلمس `DATA` يستخدم `listRange`. استعلام SQL جديد في قائمة API: لا استعلام لكل صف (`api/test/querycount.test.js` يكشفه).
- النشر: `/api/health` يجب أن يجيب باسم الإصدار الجديد (ملف `RELEASE`، ويغلب `RELEASE` في البيئة)؛ `deploy.sh` يفحص `https://$APP_BASE_DOMAIN/api/health` (من `shared/env`). اختبار نشر بـ `APP_HOME` آخر يمرّر `HEALTH_URL` بـ `?home=` (`test/deploy.test.mjs`).
- لا `SET app.x = ...` على مستوى الدالة (يحتاج superuser على cPanel): `set_config(..., true)` داخل الدالة ثم إرجاع القيمة.
- اختبارات القاعدة تعمل بالتوازي مع `backup.test.js`: لا تنشئ جدولًا في `public`/`auth` داخل اختبار (يُعدّ ويُقفل في النسخة، وقد يتشابك `DROP` مع `pg_dump`)؛ استخدم view أو transaction تُلغى.
- لا تربط `git commit` بأمر اختبار بـ `;`: اقرأ نتيجة كل حزمة (exit code والأعداد) أولًا. فشل يظهر في الحزمة الكاملة فقط ← افتح `trace.zip` (توقيت الأحداث) قبل وصفه بـ flake.
- **كل نص واجهة جديد** يمر عبر `tt("…")` وتُضاف ترجمته إلى قاموس الملف في `src/lang/`؛ لا تغيّر النص العربي (الاختبارات العربية تطابقه)؛ القيم المخزنة/المقارنة (`"مدير"`، الحالات) لا تُترجم إلا عند العرض؛ كلمة بترجمتين ← `ttc("context", "…")`. البناء يفشل عند ترجمتين لنفس النص.
- الحزم عند الطلب (`import`، `platform`) تُبنى IIFE (`scripts/build.mjs`، `test/build.test.mjs`): تصدّر عبر `window.*` فقط، وتقرأ globals حزمة التطبيق. ملف جديد يُحمّل عند الطلب يُبنى بنفس الطريقة، وإلا فقد تحل مساعدات esbuild المصغرة محل مساعدات التطبيق.
- أخطاء `5xx` تُسجل بعد الرد (`app.locals.background`): اختبار يقرأ `error_groups` يستدعي `h.app.locals.drain()` أولًا. المعرّف الفريد في نص خطأ اختباري يكون حروفًا (8 أرقام فأكثر تصبح `[number]`).
- المهام الخلفية في الاختبارات: `jobs.runDue(db, { deps, now })` بساعة متقدمة؛ ابدأ بدقيقة على الأقل (`run_at` بالميكروثانية و `Date` بالمللي). من يستبدل `app.locals.mailer` في اختبار يتجاوز عدّ `mail_log`.
- `config` مجمد (`Object.freeze`): اختبار يحتاج قيمة أخرى يمررها في `setup({ env })` ولا يعدّل `h.config`.
- لا `Object.assign(window, { X: null })` لمكوّن معرّف في ملف لاحق: في الحزمة كل الملفات سكربت واحد فيلغي ذلك الدالة.
- في `e2e`: لا `^` في regex لنص يبدأ بعد أيقونة (فراغ في البداية)؛ روابط البريد في التطوير على `<slug>.localhost` (origin آخر بتخزين مختلف عن `localhost`).

## سجل التغييرات

| التاريخ | التغيير | Commit |
|---|---|---|
| 22 أكتوبر 2026 | إنشاء الملف: ملخص كل ما أُنجز حتى `8a83f6d`، وربطه بـ `CLAUDE.md` ليُقرأ في كل جلسة | `49413fb` |
| 22 أكتوبر 2026 | البند 9 منجز (2.9، 3.15–3.19)؛ migrations حتى `0009`؛ نتائج الاختبارات الجديدة؛ 3.10 جارية | `8e60bcd` |
| 23 أكتوبر 2026 | 3.10 منجزة (49 إصلاحًا، axe نظيف)؛ مقترحات 3.20–3.27؛ نتائج الاختبارات؛ ملاحظتا عمل (axe، النوافذ والأرقام) | (هذا الـ commit) |
| 23 أكتوبر 2026 | بدء اللغتين: أساس i18n وتقسيم `screens2.jsx` (نقطة حفظ) | `df01254` |
| 25 أكتوبر 2026 | اللغتان والقرارات منجزة؛ نتائج الاختبارات والحجم؛ ملاحظات عمل للترجمة | (هذا الـ commit) |
| 25 أكتوبر 2026 | 3.33 منجزة؛ طريقة العمل بـ Superpowers في الملاحظات؛ نتائج الاختبارات | (هذا الـ commit) |
| 25 أكتوبر 2026 | 3.34 منجزة (مؤقتات الـ Toast)؛ commits S1 و S2؛ نتائج الاختبارات؛ ملاحظتا عمل | `8ce9a38` |
| 25 أكتوبر 2026 | S3 منجزة؛ قاعدة expand/contract؛ ملاحظة اختبارات القاعدة المتوازية؛ نتائج الاختبارات | `9f7a6b0` |
| 25 أكتوبر 2026 | S4 منجزة؛ migrations حتى `0010`؛ ملاحظات عمل (الحجوزات في الاختبارات، الجداول التشغيلية)؛ نتائج الاختبارات | `871443d` |
| 25 أكتوبر 2026 | S5 و 2.19 منجزتان؛ migrations حتى `0011`؛ ملاحظة ساعة الحدود في الاختبارات؛ نتائج الاختبارات | `1dac5ee` |
| 25 أكتوبر 2026 | S6 منجزة؛ migrations حتى `0012`؛ ملاحظتا عمل (الحزم عند الطلب، أخطاء الخلفية في الاختبارات)؛ نتائج الاختبارات | `e7f3c83` |
| 25 أكتوبر 2026 | S7 منجزة؛ migrations حتى `0013`؛ ملاحظة ساعة المهام في الاختبارات؛ نتائج الاختبارات | `29cc972` |
| 25 أكتوبر 2026 | S8 منجزة؛ migrations حتى `0014`؛ ملاحظة config المجمد؛ نتائج الاختبارات | (هذا الـ commit) |
| 25 أكتوبر 2026 | بدء الجاهزية للتوسع (خطة S1–S10) | (هذا الـ commit) |
| 25 أكتوبر 2026 | S1 النسخ الاحتياطي منجز | (هذا الـ commit) |
| 25 أكتوبر 2026 | S2 النشر والتراجع منجز | (هذا الـ commit) |
| 25 أكتوبر 2026 | S9 منجزة؛ migrations حتى `0015`؛ ملاحظة نافذة البيانات؛ commit S8؛ نتائج الاختبارات | (هذا الـ commit) |
| 25 أكتوبر 2026 | S10 منجزة؛ commit S9؛ نتائج الاختبارات | (هذا الـ commit) |
| 25 أكتوبر 2026 | الجاهزية للتوسع مكتملة؛ مراجعة S1–S10 وإصلاحاتها؛ migrations حتى `0016`؛ قاعدة «الجاهزية للتوسع» الدائمة؛ ملاحظة فحص النشر؛ commit S10 | (هذا الـ commit) |
| 25 أكتوبر 2026 | المراجعة الأمنية منجزة (`docs/09`)؛ migrations حتى `0017`؛ ملاحظة الأمان؛ المفتوح للمالك؛ commit مراجعة S1–S10؛ نتائج الاختبارات | (هذا الـ commit) |
| 26 أكتوبر 2026 | CR1 منجزة (القاعدة والـ API للسجلات السريرية)؛ migrations حتى `0018`؛ ملاحظة السجلات السريرية | (هذا الـ commit) |
