# PROGRESS — ملخص المشروع وما أُنجز حتى الآن

> **اقرأ هذا الملف قبل أي عمل.** يُحمَّل تلقائيًا من `CLAUDE.md` في بداية كل جلسة.
> مختصر عمدًا: التفاصيل في الوثائق الست (`docs/01`–`06`). **حدّثه في كل commit** يغيّر الحالة
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
| شاشات SaaS | `src/tenant.jsx` (حل العيادة، الدخول، الدعوة، الاستعادة)، `src/screens3.jsx` (الإعدادات، الموظفون C06، الفروع C07، واجهة العيادة `ClinicApp`، صفحة «ليست لديك صلاحية»، بوابة المريض)، `src/platform.jsx` (A01–A04)، `src/roles.jsx` (`ROUTE_MODULES`) | `screens2.jsx` قُسّم إلى `screens2.jsx` + `screens3.jsx` |
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
| 3.10 UX وإمكانية الوصول | لقطات كل الشاشات (1280×800 و 390×844) + axe-core على 77 عرضًا؛ 49 إصلاحًا: `useDialogFocus` لكل النوافذ، لوحة الأوامر combobox، لوحة المفاتيح في التقويم وقائمة «⋯»، رابط التخطي، حلقة تركيز موحدة، التباين (`--blue-700` = `#33709E`، `--ink-500` = `#5B6C7C`)، التسميات و `<h1>`، أهداف لمس ≥ 40px، نماذج الدخول على الجوال، أرقام لاتينية، إزالة الإنجليزية، الجنس `F`/`M` | `ca05334` |
| S2 النشر والتراجع | `GET /api/health`؛ `scripts/package-release.sh` ← `scripts/deploy.sh` (نسخة، migrations، تبديل `current` ذري، فحص صحة، عودة تلقائية، آخر 5 إصدارات) و `scripts/rollback.sh`؛ في cPanel: Application root = `clinicsys/current/api` | (هذا الـ commit) |
| S1 النسخ الاحتياطي | `scripts/backup.sh` (dump + ملفات + manifest من لقطة واحدة، تدوير 7+4، رفض المكان غير الآمن والقرص الممتلئ) و `scripts/restore-check.sh` (استرجاع في `<db>_restore` ومطابقة كل جدول)؛ الأوامر في `docs/08` «Runbook» | (هذا الـ commit) |
| 3.33 | الـ Toast في لوحة المنصة يمرر النقر (كان يبتلع النقر على الجزء المغطى من «إنشاء عيادة») | `ad02e1b` |
| اللغتان + القرارات | واجهة عربي/English كاملة (3.29، 6 وكلاء، 2,314 نصًا)، البريد بلغتين، cookie اللغة بين النطاقات؛ قرارات بتفويض المالك: «ج.م»/«EGP»، 44px، منتقي المتصفح، ترجمة بوابة المريض؛ 3.11 صفحة «ليست لديك صلاحية»، 3.12 لوحة المنصة ملف منفصل، 3.20 `CardTable`، 3.22 ترتيب Tab، 3.23 درج الجوال نافذة، 3.24 `Segmented`؛ إصلاح `SessionTimeline: null` (كان يكسر سجل الجلسات في الإنتاج) | `df01254`…`096ea3f` |

**آخر نتائج تحقق (اللغتان، قواعد جديدة):** القاعدة + الـ API: 226 نجاحًا، 0 فشل، 2 متخطّيان؛ العميل 114/114؛ e2e: 128 نجاحًا و 2 متخطّيان (منها 53 بالإنجليزية في `e2e/i18n-*.spec.cjs`)؛ الحجم gzip مع React: ≈ 247 KB بالعربية و ≈ 282 KB بالإنجليزية لمستخدمي العيادات (الميزانية 300).

## 5. المفتوح الآن

**قيد التنفيذ:** الجاهزية لنحو 1,000 مستخدم (S1–S10 في `docs/06`، الخطة `docs/superpowers/plans/2026-10-25-scale-readiness.md`)، كلها داخل hosting.com، بالترتيب: ~~S1 النسخ~~ ✅، ~~S2 التراجع~~ ✅، S3 القاعدة الحية، S4 التعارض، S5 حدود الطلبات، S6 الأخطاء، S7 المهام الخلفية، S8 تنبيهات الموارد، S9 N+1 والتحميل، S10 Webhooks.

**مفتوح من العمل الأخير:** 3.31 مراجعة النص الإنجليزي (المالك)؛ 3.32 ترجمة مكتبة القوالب العامة أم لا (المالك).

**لاحقًا:** 1.2 تنظيف الأسرار (`DEPLOY.md`، `seed-admin.sql` فيهما كلمة مرور المدير)؛ 1.5 Vite؛ 1.14 تحميل البيانات حسب الشاشة؛ 2.1 نسخة Supabase؛ 2.10 مولدات المعرّفات في SQL و `receipt_no`؛ 2.16–2.19؛ 3.13 proxy لـ `npm run dev`؛ 3.14 بحث العيادات في A07؛ Milestones 4–6 (ترحيل بيانات Supabase في 4.7).

**ينتظر المالك:** 1.15 أسئلة hosting.com (إصدار PostgreSQL و Node، صلاحية `CREATE` على `public`، Passenger و `TRUST_PROXY`، عدد العمليات، حدود LVE، wildcard + SSL، حد SMTP)؛ أسئلة PRD 1–5 و 8–14 (الشعار/الألوان، ما بعد 6 أشهر، وحدات الأسنان/الطب العام، أرقام الخطط، تغيير الـ slug، إبطال الجلسة عند الخروج، كلمة المرور الحالية، إغلاق عيادة غير مفعّلة، الحد الأدنى لكلمة المرور 6 أم 8، فرض الوحدات في القاعدة، «اطلب دعوة جديدة»، شاشات `staff`).

## 6. ملاحظات عمل (تجنّب تكرار الأخطاء)

- **طريقة العمل (Superpowers، `obra/superpowers`، بطلب المالك):** خطأ أو اختبار فاشل ← `systematic-debugging` (السبب الجذري قبل أي إصلاح)؛ كل إصلاح أو ميزة ← `test-driven-development` (اختبار يفشل أولًا ويُرى فاشلًا، ثم أقل كود)؛ قبل أي «تم» أو commit ← `verification-before-completion` (تشغيل الأوامر كاملة الآن وقراءة نتيجتها)؛ ميزة جديدة ← `brainstorming` ثم `writing-plans`. الإضافة تُثبَّت من كتالوج الإضافات (Anthropic Directory: Superpowers).

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
- **كل نص واجهة جديد** يمر عبر `tt("…")` وتُضاف ترجمته إلى قاموس الملف في `src/lang/`؛ لا تغيّر النص العربي (الاختبارات العربية تطابقه)؛ القيم المخزنة/المقارنة (`"مدير"`، الحالات) لا تُترجم إلا عند العرض؛ كلمة بترجمتين ← `ttc("context", "…")`. البناء يفشل عند ترجمتين لنفس النص.
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
| 25 أكتوبر 2026 | بدء الجاهزية للتوسع (خطة S1–S10) | (هذا الـ commit) |
| 25 أكتوبر 2026 | S1 النسخ الاحتياطي منجز | (هذا الـ commit) |
| 25 أكتوبر 2026 | S2 النشر والتراجع منجز | (هذا الـ commit) |
