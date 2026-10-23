# PROGRESS — ملخص المشروع وما أُنجز حتى الآن

> **اقرأ هذا الملف قبل أي عمل.** يُحمَّل تلقائيًا من `CLAUDE.md` في بداية كل جلسة.
> مختصر عمدًا: التفاصيل في الوثائق الست (`docs/01`–`06`). **حدّثه في كل commit** يغيّر الحالة
> (مهمة أُنجزت، اختبار جديد، قرار، مشكلة معروفة). آخر تحديث: 23 أكتوبر 2026.

## 1. المشروع والقرارات المعتمدة

- **ClinicSystem EG**: نظام إدارة عيادات عربي (RTL) يتحول من عيادة واحدة إلى SaaS متعدد العيادات. المرجع: `docs/ClinicSystem_EG_BRD_AR_v1.1.pdf`.
- المستودع `hussein-alali/SaaS-Clinik`، الفرع `claude/tender-wright-0luu9p`. **لا PR إلا بطلب صريح.**
- قرارات المالك: النطاق `https://clinicsyseg.com/` (عيادة = `<slug>.clinicsyseg.com`، المنصة = `admin.`)؛ مدير العيادة يدعو موظفيه ضمن حدود الخطة، وإنشاء العيادات حكر على Super Admin؛ تخصص رئيسي واحد أولًا (علاج طبيعي) مع قابلية التوسع؛ اشتراك يدوي من لوحة Super Admin؛ حدود الخطط تُحدد تجاريًا (قابلة للضبط)؛ الفروع ضمن النواة المشتركة لكل التخصصات؛ بيانات العيادة الموقوفة تُحفظ 6 أشهر.
- **قاعدة البيانات تنتقل كليًا من Supabase إلى hosting.com** (cPanel: PostgreSQL ≥ 13 + Setup Node.js App). لا extensions، ولا superuser، ولا أسرار في Git أو الواجهة.

## 2. البنية (الحالة الحالية)

| الطبقة | المكان | ملاحظات |
|---|---|---|
| الواجهة | `src/*.jsx` | React 18، سكربتات classic تتشارك globals (بلا imports)، تُجمع بترتيب `index.html` عبر esbuild (`scripts/build.mjs` → `dist/app.<hash>.js`، و `import.<hash>.js` مع `?import=1` فقط). ملف جديد = سطر في `index.html` |
| العميل | `src/apiclient.jsx` | بديل متوافق مع `supabase-js` (`window.supabase.createClient`) يكلّم `/api`؛ ترويسات `X-Requested-With: clinicsys` و `X-Org-Slug` و `X-Branch-Id` و `X-Platform: 1`؛ `newRecordId(prefix)` |
| شاشات SaaS | `src/tenant.jsx` (حل العيادة، الدخول، الدعوة، التهيئة، الفروع C07، الموظفون C06)، `src/platform.jsx` (A01–A04)، `src/roles.jsx` (`ROUTE_MODULES`) | |
| الـ API | `api/` (Express 5، `app.js`) | `/api/auth/*`، `/api/orgs/*`، `/api/data` (قائمة سماح بدل PostgREST، حد 1000 صف)، `/api/rpc` (23 دالة)، `/api/files` (روابط HMAC ≤ 600 ث)، `/api/admin/*`، `/api/org/*` (الدعوات، الأعضاء، الاستخدام)، `/api/invitations/:token`، `/api/platform/*`؛ `403 module_disabled` من `api/src/modules.js` |
| الجلسة | cookie `cs_session` | JWT `{sub, sv}` مع `session_version`؛ العيادة من `Host` أو `X-Org-Slug`؛ المنصة من `admin.<base>` أو `X-Platform: 1` (غير الإنتاج) |
| القاعدة | `db/migrations/0001`–`0009` | `0001_baseline`، `0002_platform`، `0003_tenancy`، `0004_audit_integrity`، `0005_branches_no_delete`، `0006_staff_role`، `0007_rpc_role_guards`، `0008_invitation_email_status`، `0009_inactive_branch_guard`. **التالي `0010`. لا تعدّل migration مطبّقًا.** |
| العزل | PostgreSQL RLS | `set_config` لـ `app.user_id/org_id/branch_id/system` لكل معاملة؛ FORCE RLS + `tenant_isolation` (RESTRICTIVE) + `branch_scope`؛ `organization_id DEFAULT app_org_id()`؛ triggers حدود الخطة بـ SQLSTATE `PL422` (→ 422)، والفرع المعطّل بـ `BR409` (→ `409 branch_inactive`)؛ الأدوار admin/receptionist/doctor/therapist/staff |

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
| 3.10 UX وإمكانية الوصول | لقطات كل الشاشات (1280×800 و 390×844) + axe-core على 77 عرضًا؛ 49 إصلاحًا: `useDialogFocus` لكل النوافذ، لوحة الأوامر combobox، لوحة المفاتيح في التقويم وقائمة «⋯»، رابط التخطي، حلقة تركيز موحدة، التباين (`--blue-700` = `#33709E`، `--ink-500` = `#5B6C7C`)، التسميات و `<h1>`، أهداف لمس ≥ 40px، نماذج الدخول على الجوال، أرقام لاتينية، إزالة الإنجليزية، الجنس `F`/`M` | (هذا الـ commit) |

**آخر نتائج تحقق (3.10، قواعد جديدة):** القاعدة + الـ API: 222 نجاحًا، 0 فشل، 2 متخطّيان، 0 todo؛ العميل 102/102؛ e2e: 74 نجاحًا و 2 متخطّيان (AT-11، AT-12 بلا شاشة)؛ axe: 0 مخالفات حرجة/خطيرة؛ حجم البناء ~227 KB gzip للتطبيق (~273 KB مع React، الميزانية 300 KB).

## 5. المفتوح الآن

**قيد التنفيذ:** واجهة بلغتين (عربي افتراضي + إنجليزي، المهمة 3.29) وقرارات المراجعة (3.11، 3.20–3.27). الأساس جاهز (`df01254`): `src/i18n.jsx` (`tt("نص عربي")` — المفتاح هو النص العربي نفسه، و `fmtMoney` و `fmtDate`)، والقواميس في `src/lang/en-*.jsx` (ملف `lang-en.<hash>.js` يُحمّل للإنجليزية فقط)، و `screens2.jsx` قُسّم إلى `screens2.jsx` و `screens3.jsx`، و `Segmented` و `CardTable` في `src/ui.jsx`.

**من مراجعة 3.10 (مقترحات):** 3.11 صفحة «ليست لديك صلاحية»؛ 3.20 جداول العيادة كبطاقات على الجوال؛ 3.22 ترتيب Tab في دخول العيادة؛ 3.23 درج الجوال كنافذة؛ 3.24 مكوّن أزرار مقسّمة؛ وتنتظر المالك: 3.21 «EGP» أم «ج.م»، 3.25 بوابة المريض التجريبية، 3.26 منتقي تاريخ عربي، 3.27 أهداف لمس 44px (المنفذ 40px)، وتأكيد ألوان `--blue-700`/`--ink-500` الجديدة.

**لاحقًا:** 1.2 تنظيف الأسرار (`DEPLOY.md`، `seed-admin.sql` فيهما كلمة مرور المدير)؛ 1.5 Vite؛ 1.14 تحميل البيانات حسب الشاشة؛ 2.1 نسخة Supabase؛ 2.10 مولدات المعرّفات في SQL و `receipt_no`؛ 2.16–2.19؛ 3.11–3.14؛ Milestones 4–6 (ترحيل بيانات Supabase في 4.7).

**ينتظر المالك:** 1.15 أسئلة hosting.com (إصدار PostgreSQL و Node، صلاحية `CREATE` على `public`، Passenger و `TRUST_PROXY`، عدد العمليات، حدود LVE، wildcard + SSL، حد SMTP)؛ أسئلة PRD 1–5 و 8–14 (الشعار/الألوان، ما بعد 6 أشهر، وحدات الأسنان/الطب العام، أرقام الخطط، تغيير الـ slug، إبطال الجلسة عند الخروج، كلمة المرور الحالية، إغلاق عيادة غير مفعّلة، الحد الأدنى لكلمة المرور 6 أم 8، فرض الوحدات في القاعدة، «اطلب دعوة جديدة»، شاشات `staff`).

## 6. ملاحظات عمل (تجنّب تكرار الأخطاء)

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
- أي نافذة جديدة تستخدم `Modal` أو `useDialogFocus` من `src/ui.jsx`، والأرقام لاتينية دائمًا.

## سجل التغييرات

| التاريخ | التغيير | Commit |
|---|---|---|
| 22 أكتوبر 2026 | إنشاء الملف: ملخص كل ما أُنجز حتى `8a83f6d`، وربطه بـ `CLAUDE.md` ليُقرأ في كل جلسة | `49413fb` |
| 22 أكتوبر 2026 | البند 9 منجز (2.9، 3.15–3.19)؛ migrations حتى `0009`؛ نتائج الاختبارات الجديدة؛ 3.10 جارية | `8e60bcd` |
| 23 أكتوبر 2026 | 3.10 منجزة (49 إصلاحًا، axe نظيف)؛ مقترحات 3.20–3.27؛ نتائج الاختبارات؛ ملاحظتا عمل (axe، النوافذ والأرقام) | (هذا الـ commit) |
| 23 أكتوبر 2026 | بدء اللغتين: أساس i18n وتقسيم `screens2.jsx` (نقطة حفظ) | `df01254` |
