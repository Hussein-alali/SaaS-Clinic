# PROGRESS — ملخص المشروع وما أُنجز حتى الآن

> **اقرأ هذا الملف قبل أي عمل.** يُحمَّل تلقائيًا من `CLAUDE.md` في بداية كل جلسة.
> مختصر عمدًا: التفاصيل في الوثائق الست (`docs/01`–`06`). **حدّثه في كل commit** يغيّر الحالة
> (مهمة أُنجزت، اختبار جديد، قرار، مشكلة معروفة). آخر تحديث: 22 أكتوبر 2026.

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
| القاعدة | `db/migrations/0001`–`0006` | `0001_baseline`، `0002_platform`، `0003_tenancy`، `0004_audit_integrity`، `0005_branches_no_delete`، `0006_staff_role`. **التالي `0007`. لا تعدّل migration مطبّقًا.** |
| العزل | PostgreSQL RLS | `set_config` لـ `app.user_id/org_id/branch_id/system` لكل معاملة؛ FORCE RLS + `tenant_isolation` (RESTRICTIVE) + `branch_scope`؛ `organization_id DEFAULT app_org_id()`؛ triggers حدود الخطة بـ SQLSTATE `PL422`؛ الأدوار admin/receptionist/doctor/therapist/staff |

ربط الوحدات (API + واجهة): `core.patients`→patients؛ `core.appointments`→bookings، patient_schedules؛ `core.files`→patient_files؛ `core.billing`→invoices، payments، payment_receipts، packages، patient_subscriptions + 3 RPC؛ `physio.sessions`→sessions؛ `physio.treatment_plans`→treatments؛ `physio.templates`→جداول القوالب.

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

**آخر نتائج تحقق (`8a83f6d`، قواعد جديدة):** القاعدة + الـ API: 212 نجاحًا، 0 فشل، 2 متخطّيان، 1 todo (2.9)؛ العميل 102/102؛ e2e: 66 نجاحًا و 2 متخطّيان (AT-11، AT-12 بلا شاشة)؛ حجم البناء ~221 KB gzip للتطبيق (~267 KB مع React، الميزانية 300 KB).

## 5. المفتوح الآن

**قيد التنفيذ (طلب المستخدم «اكمل 9»):**
- 2.9 فحوص الأدوار في 23 دالة RPC (`v_role is null or ...`) + فحص دور لـ `record_quick_payment` و `list_invoices_filtered` + قرار `create/update_treatment_method` → migration `0007`، وقلب اختبار `todo` في `db/test/baseline.test.js`.
- 3.15 حفظ `email_sent` للدعوة في القاعدة/الـ API (اليوم `sessionStorage` `clinicsys.unsent_invites`).
- 3.16 فرض الوحدات في `/api/files` (`patient-files` → `core.files`).
- 3.17 حبس التركيز في `Modal` (`src/ui.jsx`).
- 3.18 رفض الكتابة على فرع معطّل (`X-Branch-Id`) في الـ API/القاعدة.
- 3.19 عرض «كل الفروع» في التقارير للمدير (C05).
- 3.10 مراجعة UX وإمكانية الوصول الشاملة (1280×800 و 390×844 مقابل `docs/04`) وإصلاحها.

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

## سجل التغييرات

| التاريخ | التغيير | Commit |
|---|---|---|
| 22 أكتوبر 2026 | إنشاء الملف: ملخص كل ما أُنجز حتى `8a83f6d`، وربطه بـ `CLAUDE.md` ليُقرأ في كل جلسة | (هذا الـ commit) |
