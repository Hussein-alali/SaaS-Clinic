# 2. Technical Requirements Document (TRD) — ClinicSystem EG

> **الغرض:** جعل الاختيارات التقنية صريحة حتى لا يعتمد البناء على التخمين.
> يُقرأ مع [PRD](01-PRD.md) و [Backend Schema](05-Backend-Schema.md).

---

## Current state of the repository (baseline)

هذا ما يوجد فعلًا في المستودع اليوم، ويجب أن يبدأ منه البناء:

| العنصر | الحالة |
|---|---|
| `index.html` | غلاف التطبيق للتطوير (`npm run dev`)؛ يحمّل React و Babel Standalone و `@supabase/supabase-js@2` من CDN، ثم `src/*.jsx` |
| `src/*.jsx` | منقول من المستودع الأصلي `clinksys` (commit `cfd073d`) مع `assets/` و `supabase/` و `scripts/` |
| البناء | `npm run build` (`scripts/build.mjs`، esbuild) يترجم `src/*.jsx` مسبقًا إلى `dist/` مع React production؛ صفحة الاستيراد ومكتبة Excel تُحمّلان عند الحاجة فقط ([07](07-Performance-Audit.md)) |
| `server.js` | خادم ملفات ثابتة بدون اعتماديات؛ يخدم `dist/` في الإنتاج، وكل ملفات المستودع في وضع `--dev` فقط |
| قاعدة البيانات (الحالية) | Supabase، عيادة واحدة: `clinic_settings` بسجل وحيد `id = 1`، ودور المستخدم من `staff.role` عبر `app_role()`، ولا يوجد `organization_id`. **تُنقل إلى PostgreSQL على hosting.com** (قرار 21 أكتوبر 2026، انظر أدناه) |
| `branches` | جدول موجود لكنه غير مربوط بالمواعيد أو الموظفين أو الفواتير |

> **تنبيه أمني قائم:** `DEPLOY.md` و `seed-admin.sql` يحتويان على بريد وكلمة مرور حساب المدير الأولي، و `server.js` كان يخدم ملفات `.sql` للعامة (أصبح يخدم `dist/` فقط بعد `npm run build`). يجب تغيير كلمة المرور وحذفها من الملفات قبل أي نشر متعدد العيادات (انظر Milestone 1 في [خطة التنفيذ](06-Implementation-Plan.md)).

## Platforms

- **Web فقط** (متصفحات سطح المكتب والجوال الحديثة، تصميم متجاوب)، واجهة عربية RTL أساسية.
- لا تطبيق جوال أصلي في الإصدار الأول.

## Frontend and hosting

| البند | القرار |
|---|---|
| Framework | React 18 |
| أسلوب البناء | **الآن:** ترجمة مسبقة بـ esbuild (`npm run build`) بدل Babel داخل المتصفح. **قرار مطلوب في Milestone 1:** الانتقال إلى **Vite + React** مع ES modules لتقسيم الكود حسب الشاشة (`React.lazy`) وإتاحة فحص الأنواع والاختبارات |
| Hosting | hosting.com (cPanel). تطبيق Node.js واحد (`api/app.js` عبر **Setup Node.js App**) يخدم `/api/*` **و** ملفات `dist/` لكل النطاقات (`clinicsyseg.com` و `*.clinicsyseg.com`)، حتى تعمل الروابط الفرعية دون إعداد منفصل لكل عيادة. `server.js` يبقى للتطوير وللمعاينة بدون API |
| Build output | `dist/index.html` + `app.<hash>.js` (كل الشاشات) + `import.<hash>.js` (صفحة `?import=1`، تُحمّل عند فتحها فقط) + `assets/`. البصمة في اسم الملف تسمح بتخزين مؤقت طويل |
| مكتبات عند الطلب | `xlsx-js-style` (‏139 KB gzip) تُحمّل عند أول «تصدير Excel» عبر `loadScriptOnce()` في `src/screens2.jsx` |
| Domains | `clinicsyseg.com` (الموقع الرئيسي والدخول) + `*.clinicsyseg.com` (العيادات) + `admin.clinicsyseg.com` (لوحة Super Admin؛ slug محجوز) |
| حل العيادة | الواجهة تقرأ الـ subdomain من `window.location.hostname` → `GET /api/orgs/resolve?slug=` → تحصل على المعرّف والحالة والتخصص والوحدات المفعلة والإعدادات العامة فقط. **في التطوير** (بدون wildcard DNS): `?org=<slug>` و `?platform=1`، ويُحفظ الاختيار في `sessionStorage`. الخادم يحدد المؤسسة من `Host` أولًا، ثم من ترويسة `X-Org-Slug` |
| Routing | تطبيق واحد لكل النطاقات؛ لا نسخة لكل عيادة ولا لكل تخصص |

## Backend and database

**القرار (21 أكتوبر 2026، مالك المنتج):** نقل قاعدة البيانات وكل ما يقدمه Supabase إلى hosting.com. تفاصيل الخيار B في [08](08-Hosting-Migration.md).

| البند | القرار |
|---|---|
| Database | **PostgreSQL على cPanel (hosting.com)**. الكود يستهدف **PostgreSQL ≥ 13**، لأن الإصدار على hosting.com لم يُتحقق منه بعد (المهمة 1.15). **بدون أي extension**: لا `pgcrypto` ولا `citext` ولا `pgtap`. `gen_random_uuid()` مدمج في 13+ |
| صلاحيات القاعدة | التطبيق والـ migrations يتصلان بمستخدم cPanel، وهو مالك القاعدة لكنه ليس superuser ولا يملك `CREATEROLE`. لذلك لا `CREATE ROLE`، ولا `GRANT ... TO anon/authenticated`، ولا `ALTER SYSTEM`. التطوير والاختبار يحاكيان ذلك بـ `scripts/dev-db.sh` |
| API | **Node.js ≥ 18** (الحد الأعلى على الاستضافة المشتركة 20)، Express، `pg`، `bcryptjs` (JavaScript خالص، بدون تجميع native)، `jsonwebtoken`، `cookie-parser`، `multer`، `nodemailer`. المجلد `api/`، ونقطة البدء `api/app.js` |
| Data access | المتصفح لا يتصل بالقاعدة. الواجهة تستخدم `src/apiclient.jsx`، وهو عميل متوافق مع الجزء المستخدم من `supabase-js` (`window.supabase.createClient`)، ويحوّل الاستدعاءات إلى `/api/*`. لذلك تبقى `src/supabase.jsx` والشاشات كما هي تقريبًا. الجداول تُقرأ بالتوازي، وتُتجاوز حدود الصفوف (1000) بالعدّ ثم الصفحات (`selectAllRows`) |
| تطبيق الصلاحيات | **RLS داخل PostgreSQL يبقى خط الدفاع الأساسي.** كل طلب يُنفذ داخل transaction يضبط `app.user_id` و `app.org_id` و `app.branch_id` (و `app.system` للعمليات الداخلية فقط) عبر `set_config(..., true)`. كل الجداول `ENABLE` + `FORCE ROW LEVEL SECURITY` حتى تنطبق السياسات على مالك الجداول نفسه |
| العمليات المميزة | مسارات في الـ API (بديل Edge Functions): إنشاء العيادات، والدعوات، وإنشاء المستخدمين، وإعادة تعيين كلمات المرور، وتغيير الحالات، وكلها تُسجل في `audit_events` |
| منطق الأعمال الحساس | دوال PostgreSQL الموجودة (`record_quick_payment` وقوالب العلاج وغيرها، 25 دالة يستدعيها المتصفح) تُنقل كما هي، وتُستدعى عبر `POST /api/rpc/:fn` من قائمة سماح فقط |
| Migrations | `db/migrations/NNNN_name.sql` (ترقيم رباعي)، ويطبقها `node db/migrate.js` مع جدول `schema_migrations`. `0001_baseline.sql` هو نقل `Supabase_All_In_One.sql` إلى PostgreSQL عادي. `supabase/` و `Supabase_All_In_One.sql` يبقيان للمرجعية حتى الترحيل النهائي |
| الملفات | على قرص الاستضافة (30GB) **خارج** `public_html`: `FILES_DIR/<organization_id>/<bucket>/<path>`. التنزيل فقط عبر الـ API بعد التحقق من الصلاحية، أو برابط موقّع (HMAC) صالح ≤ 10 دقائق |
| البريد | SMTP من cPanel عبر `nodemailer`. في التطوير والاختبار `MAIL_TRANSPORT=file` يكتب الرسائل في `api/.outbox/*.json` |

## Authentication and roles

- **الحسابات في قاعدتنا:** جدول `auth.users` (schema `auth` توافقي) بكلمات مرور **bcrypt** (cost 10). كلمات مرور Supabase الحالية مخزنة بـ bcrypt أيضًا، فتُنقل كما هي ويحتفظ المستخدمون بكلمات مرورهم. `auth.uid()` = `app.user_id` من سياق الطلب.
- **الجلسة:** JWT (HS256، `JWT_SECRET`) في cookie اسمها `cs_session`، بخصائص `httpOnly` و `SameSite=Lax` و `Secure` في الإنتاج، و `Domain=.clinicsyseg.com` حتى تعمل على كل الروابط الفرعية. المدة 12 ساعة، أو 30 يومًا عند «أبقني مسجلًا». الحمولة `{sub, sv}`، حيث `sv` يقابل `auth.users.session_version`، وزيادته تُبطل كل الجلسات (عند تغيير كلمة المرور أو تعطيل الحساب).
- **CSRF:** الطلبات التي تغيّر البيانات تتطلب الترويسة `X-Requested-With: clinicsys`، إضافة إلى `SameSite=Lax`.
- **التفعيل بالدعوة فقط:** لا تسجيل ذاتي. الدعوة رمز عشوائي، يُخزن منه hash (SHA-256) فقط، وصلاحيته 7 أيام. الرابط `https://<slug>.clinicsyseg.com/?invite=<token>`.
- **الدور من القاعدة في كل طلب، لا من JWT:**
  - `platform_admins` → Super Admin.
  - `organization_members(organization_id, user_id, role, status)` → الدور في العيادة. **قيم الأدوار تبقى كما في الكود الحالي:** `admin` (مدير العيادة)، `receptionist`، `doctor`، `therapist`، `staff`.
  - `member_branches` → الفروع المسموح بها. لا صفوف لـ `admin` تعني كل الفروع.
  - `staff` يبقى «ملف الموظف» داخل العيادة (الاسم، الهاتف، `auth_uid`). الـ API يكتب `staff.role` و `organization_members.role` معًا.
- **سياق العيادة:** يحدده الخادم من `Host` (أو `X-Org-Slug` في التطوير)، ويضعه في `app.org_id` **فقط** إذا كان للمستخدم عضوية نشطة في عيادة نشطة. `app_role()` في القاعدة يعيد التحقق نفسه.
- **الفرع:** ترويسة `X-Branch-Id`. إن لم يُرسل الفرع أو لم يكن مسموحًا للمستخدم، يُستخدم أول فرع مسموح له.
- **دعوة الموظفين:** Super Admin لأي عيادة، و `admin` لعيادته فقط، بأي دور عدا Super Admin، وضمن حد المستخدمين في الخطة.
- **تسجيل الدخول:** رسالة عامة واحدة عند الخطأ، دون كشف وجود البريد. حد محاولات: 10 محاولات خاطئة لكل بريد ولكل IP خلال 15 دقيقة.

## External services and APIs

| المزود | الغرض | الحدود | مالك بيانات الاعتماد |
|---|---|---|---|
| hosting.com (cPanel) | PostgreSQL، وتطبيق Node.js، وتخزين الملفات (30GB)، و SMTP، و AutoSSL، و Cron (النسخ الاحتياطي) | حدود الاستضافة المشتركة (CloudLinux LVE)، وإصدارات Node ≤ 20 | مالك المنصة |
| SMTP (cPanel Email Accounts، أو مزود خارجي) | رسائل الدعوة وإعادة تعيين كلمة المرور | حد الإرسال في cPanel يُراجع مع الدعم الفني | مالك المنصة |
| مزود DNS + TLS | Wildcard DNS `*.clinicsyseg.com` وشهادة wildcard | — | مالك المنصة |
| WhatsApp (روابط `wa.me` حاليًا) | تذكير المواعيد | يدوي من المستخدم | — |
| CDN (unpkg/jsdelivr) | مكتبات الواجهة | يُلغى عند الانتقال إلى Vite | — |

## Architecture

```
 المتصفح (React SPA, RTL) — src/apiclient.jsx بدل supabase-js
   ├── clinicsyseg.com ............ الموقع الرئيسي + الدخول + اختيار العيادة
   ├── <slug>.clinicsyseg.com ..... مساحة العيادة
   └── admin.clinicsyseg.com ...... لوحة Super Admin
          │  HTTPS, cookie cs_session (Domain=.clinicsyseg.com)
          ▼
 ┌──────────── hosting.com: Node.js app (api/app.js) ─────────────┐
 │ static: dist/ لكل النطاقات                                      │
 │ /api/auth/*      دخول، خروج، جلسة، كلمة المرور                  │
 │ /api/orgs/resolve حل العيادة من slug (عام)                      │
 │ /api/data        بديل PostgREST: جداول من قائمة سماح             │
 │ /api/rpc/:fn     الدوال الـ 25 الحالية                          │
 │ /api/files/*     رفع/تنزيل/حذف + روابط موقّعة                    │
 │ /api/admin/*     بديل Edge Functions (داخل العيادة)              │
 │ /api/org/*       دعوات الموظفين (مدير العيادة)                   │
 │ /api/invitations/:token  عرض/قبول الدعوة (عام)                   │
 │ /api/platform/*  Super Admin                                    │
 │        │ كل طلب: BEGIN; set_config(app.user_id/org_id/branch_id) │
 └────────┼────────────────────────────────────────────────────────┘
          ▼
 PostgreSQL (cPanel) — FORCE RLS على كل جدول
   app_role(), app_org_id(), is_super_admin(), can_access_branch(),
   org_module_enabled(); سياسة tenant_isolation (RESTRICTIVE)
 FILES_DIR/<org_id>/<bucket>/<path> — خارج public_html
```

**تدفق الطلب:** cookie → التحقق من JWT و `session_version` → المؤسسة من `Host` → التحقق من العضوية → transaction يضبط السياق → الاستعلام مقيد بـ RLS → النتيجة.

## Repository layout

```
api/                        Node.js API (cPanel: Setup Node.js App, startup file app.js)
  app.js                    Express: /api/* + static dist/
  package.json              تبعيات الـ API فقط
  src/config.js             متغيرات البيئة (أدناه)
  src/db.js                 Pool + withContext(ctx, fn)
  src/auth.js, src/tenant.js, src/mailer.js, src/files.js
  src/routes/{auth,orgs,data,rpc,files,admin,org,invitations,platform}.js
  scripts/create-super-admin.js
  test/*.test.js            node:test على PostgreSQL محلي
db/
  migrate.js                يطبق db/migrations/*.sql بالترتيب (schema_migrations)
  migrations/0001_baseline.sql, 0002_platform.sql, 0003_tenancy.sql, ...
  seed/dev.sql              عيادتان وهميتان + مستخدم لكل دور (للتطوير والاختبار فقط)
  test/*.test.js            اختبارات العزل بين العيادات
src/apiclient.jsx           عميل متوافق مع supabase-js → /api
src/tenant.jsx              حل العيادة، صفحات الحالة، اختيار العيادة، قبول الدعوة
src/platform.jsx            لوحة Super Admin
e2e/                        اختبارات Playwright للرحلات J1–J4
scripts/dev-db.sh           PostgreSQL محلي بصلاحيات تشبه cPanel
```

**متغيرات البيئة للـ API:** `DATABASE_URL`، `JWT_SECRET`، `APP_BASE_DOMAIN` (`clinicsyseg.com`؛ في التطوير `localhost`)، `COOKIE_DOMAIN`، `COOKIE_SECURE` (`true` في الإنتاج)، `FILES_DIR`، `FILES_SIGNING_SECRET`، `DIST_DIR` (افتراضيًا `../dist`)، `MAIL_TRANSPORT` (`smtp` أو `file`)، `SMTP_HOST`، `SMTP_PORT`، `SMTP_USER`، `SMTP_PASS`، `MAIL_FROM`، `PORT`. الأسرار تُضبط من شاشة تطبيق Node في cPanel، **ولا تُكتب في Git أبدًا**.

## API contract

كل المسارات JSON تحت `/api`. الأخطاء بالشكل `{ "error": { "message", "code" } }` مع رمز HTTP مناسب: 400 لمدخل غير صالح، 401 بدون جلسة، 403 بدون صلاحية، 404 غير موجود، 409 تعارض، 422 تجاوز حد الخطة، 429 كثرة المحاولات.

### المصادقة والجلسة

| Method & path | Body / query | Response |
|---|---|---|
| `POST /api/auth/login` | `{email, password, remember}` | `200 {user:{id,email,name}, is_super_admin, memberships:[{organization_id, slug, name, role, status, specialty_code}]}` + cookie |
| `POST /api/auth/logout` | — | `204`، مع مسح الـ cookie |
| `GET /api/auth/session` | — | مثل نتيجة الدخول، أو `401` |
| `POST /api/auth/password` | `{password}` | `204`؛ يزيد `session_version` ويعيد إصدار الـ cookie |
| `PATCH /api/auth/profile` | `{name}` | `200 {user}` |
| `POST /api/auth/reset/request` | `{email}` | `204` دائمًا، ويُرسل بريد إن وُجد الحساب |
| `POST /api/auth/reset/confirm` | `{token, password}` | `204` |

### العيادة الحالية

| Method & path | الوصف |
|---|---|
| `GET /api/orgs/resolve?slug=` | عام. `200 {id, slug, name, status, specialty_code, modules:[code], settings:{display_name, subtitle, logo, primary_color}}`. العيادة الموقوفة تعيد `{slug, status:"suspended"}` فقط، والمغلقة أو غير الموجودة تعيد `404` |
| `GET /api/orgs/current` | عضو العيادة: العيادة + `role` + `branches` المسموحة + `current_branch_id` |

### البيانات (بديل PostgREST)

`POST /api/data` — يتطلب جلسة وعيادة حالية.

```json
{ "table": "patients", "action": "select|insert|update|upsert|delete",
  "columns": "*" ,
  "filters": [{"column":"patient_id","op":"eq|neq|gt|gte|lt|lte|is|in|like|ilike","value":"P-1"}],
  "order": [{"column":"created_at","ascending":false,"nullsFirst":false}],
  "range": {"from":0,"to":999}, "count": "exact|null",
  "single": "single|maybeSingle|null",
  "values": {}, "onConflict": "patient_id", "returning": true }
```

- الاستجابة `{data, count}`. حد أقصى **1000 صف** لكل استجابة، كما في Supabase، فيعمل `selectAllRows` كما هو.
- `table` و `columns` و `filters[].column` تُتحقق من الكتالوج: جداول `public` المفعّل عليها RLS فقط، مع استثناء الجداول الداخلية (`schema_migrations`، `invitations`، `platform_admins`، و `auth.*`).
- كل القيم تُمرر كمعاملات SQL. لا يُدمج أي نص من المستخدم في SQL.
- `single: "single"` بلا صفوف أو بأكثر من صف يعيد `406 {error:{code:"PGRST116"}}`، و `maybeSingle` يعيد `data:null` حين لا توجد صفوف.
- أخطاء PostgreSQL تُعاد برسالتها ورمزها (`code` = SQLSTATE)، بدون تفاصيل داخلية أخرى.

`POST /api/rpc/:fn` بالجسم `{args:{...}}` — `fn` من قائمة سماح بالدوال الـ 25 التي تستدعيها الواجهة. الاستدعاء بالمعاملات المسماة، والنتيجة بنفس شكل PostgREST: قيمة مفردة، أو مصفوفة للدوال التي تعيد مجموعة.

### الملفات

| Method & path | الوصف |
|---|---|
| `POST /api/files/upload` | multipart: `bucket`، `path`، `file`، `upsert`. يُخزن في `FILES_DIR/<org>/<bucket>/<path>`. الحد 20MB، والـ `path` يُرفض إن احتوى `..` أو بدأ بـ `/` |
| `POST /api/files/sign` | `{bucket, path, expiresIn ≤ 600}` → `{signedUrl}` |
| `GET /api/files/object/:bucket/*` | تنزيل بجلسة + عيادة حالية. هذا ما يعيده `getPublicUrl` في العميل، وهو ليس عامًا فعلًا |
| `GET /api/files/signed?token=` | تنزيل بالرابط الموقّع (HMAC، يحمل org/bucket/path/exp) |
| `POST /api/files/remove` | `{bucket, paths:[...]}` |

### الإدارة داخل العيادة (بديل Edge Functions — `admin` فقط)

| Method & path | Body | ملاحظة |
|---|---|---|
| `POST /api/admin/create-user` | `{email, password, name, role, phone}` | نفس عقد `admin-create-user`: `{ok:true, uid}` أو `{ok:false, error, detail}`. ينشئ/يربط الحساب + العضوية + `staff`، ضمن حد المستخدمين |
| `POST /api/admin/reset-password` | `{staff_id, password}` | نفس عقد `admin-reset-password` |
| `POST /api/admin/set-status` | `{staff_id, status}` | نفس عقد `admin-set-status`؛ يعطل العضوية ويزيد `session_version` |
| `GET/POST /api/org/invitations` | `{email, role, branch_ids}` | قائمة/إنشاء دعوة وإرسال البريد |
| `POST /api/org/invitations/:id/resend`، `DELETE /api/org/invitations/:id` | — | إعادة إرسال / إلغاء |

### الدعوات (عام)

| Method & path | الوصف |
|---|---|
| `GET /api/invitations/:token` | `{organization:{name,slug}, email, role, status, expires_at}`، أو `404` أو `410` (منتهية/مستخدمة) |
| `POST /api/invitations/:token/accept` | `{password, name}`. ينشئ الحساب أو يربطه، ويفعّل العضوية و `staff` و `member_branches`. أول `admin` يقبل دعوته ينقل العيادة من `pending_activation` إلى `active`. يسجّل الدخول (cookie) |

### Super Admin

| Method & path | الوصف |
|---|---|
| `GET /api/platform/stats` | أعداد العيادات حسب الحالة + الدعوات المعلقة |
| `GET /api/platform/organizations?q=&status=&specialty=` | قائمة مع بحث وتصفية |
| `POST /api/platform/organizations` | `{name, slug, specialty_code, modules:[code], plan_id, admin_email}` → عيادة `pending_activation` + فرع «الفرع الرئيسي» + إعدادات + دعوة أول مدير. **عملية ذرية** |
| `GET /api/platform/organizations/:id` | التفاصيل + الوحدات + الفروع + الأعضاء + الاشتراك |
| `PATCH /api/platform/organizations/:id` | `{name, specialty_code, plan_id}` |
| `POST /api/platform/organizations/:id/status` | `{status, reason}`؛ `reason` إلزامي عند `suspended` و `closed`، و `retention_until = now() + 6 months` عند الإيقاف |
| `PUT /api/platform/organizations/:id/modules` | `{codes:[...]}`، مع التحقق من التبعيات |
| `PUT /api/platform/organizations/:id/subscription` | `{plan_id, status, period_start, period_end, notes}` (يدوي) |
| `POST /api/platform/organizations/:id/invitations` | دعوة مدير/موظف لأي عيادة |
| `GET /api/platform/slug-available?slug=` | `{available, reason}` |
| `GET /api/platform/specialties`، `GET /api/platform/modules`، `GET/POST/PATCH /api/platform/plans` | الكتالوجات |
| `GET /api/platform/audit?organization_id=&actor=&action=&from=&to=` | سجل التدقيق مع صفحات |

## Security and privacy

| المتطلب | التطبيق |
|---|---|
| عزل المستأجرين (NFR-001) | `organization_id NOT NULL` على كل جدول تابع لعيادة + RLS على كل جدول + اختبارات سلبية آلية |
| الأسرار (NFR-004) | `DATABASE_URL` و `JWT_SECRET` و `FILES_SIGNING_SECRET` و SMTP في بيئة تطبيق Node على cPanel فقط، لا في React ولا في Git؛ فحص سجل Git وتدوير أي سر مكشوف؛ حذف كلمة مرور المدير من `DEPLOY.md` و `seed-admin.sql` |
| التخزين (NFR-005) | الملفات خارج `public_html` في مجلد العيادة؛ التنزيل عبر الـ API بعد التحقق من الجلسة والعيادة، أو برابط موقّع ≤ 10 دقائق؛ رفض أي `path` فيه `..` |
| حقن SQL | `/api/data` يتحقق من أسماء الجداول والأعمدة من الكتالوج، ويمرر كل القيم كمعاملات؛ `/api/rpc` من قائمة سماح |
| تجاوز السياق | `app.org_id` يضبطه الخادم بعد التحقق من العضوية؛ `organization_id` الذي يرسله العميل في `values` يُرفض إن خالف العيادة الحالية (سياسة `WITH CHECK`) |
| النقل (NFR-006) | HTTPS إلزامي على النطاق الرئيسي وكل الروابط الفرعية؛ HSTS |
| التدقيق (NFR-007) | `audit_events` لإنشاء/إيقاف العيادات، تغيير التخصص والميزات والخطة، الدعوات، تغيير الأدوار والعضويات |
| الخصوصية (NFR-012) | لا بيانات صحية في سجلات الأخطاء أو أدوات التحليل؛ صلاحيات التصدير مقيدة |
| الاحتفاظ | بيانات العيادة الموقوفة تبقى 6 أشهر (`organizations.retention_until`)؛ ما بعدها قرار مفتوح — **لا حذف آلي حتى يُعتمد** |
| الخادم الثابت | `server.js` يخدم فقط `index.html` والأصول المبنية، وليس `*.sql` أو `*.md` |

## Performance and reliability targets

- **أول شاشة ≤ 1 ثانية** على جهاز متوسط (معالج أبطأ 4×). **مقاس:** 125 ms على جهاز سريع و 370 ms بالإبطاء، بدل 5,962 ms و 24,757 ms قبل الترجمة المسبقة. لا مترجم داخل المتصفح في الإنتاج.
- **ميزانية JavaScript الأولية ≤ 300 KB gzip.** الحالي: React 46 + supabase-js 54 + التطبيق 150 = حوالي 250 KB. المكتبات الثقيلة والشاشات النادرة تُحمّل عند الحاجة.
- القوائم الشائعة تستجيب خلال **2.5 ثانية** في ظروف الشبكة المستهدفة (NFR-009)؛ فهارس على `organization_id` و `(organization_id, branch_id)` و `(organization_id, date)`.
- استدعاءات دوال RLS المساعدة تكون `stable` وتُستدعى بنمط `(select fn())` لتجنب التنفيذ لكل صف.
- اتصالات القاعدة: Pool بحد أقصى 10، لأن الاستضافة المشتركة تحدد عدد العمليات والاتصالات.
- النسخ الاحتياطي: `pg_dump` يومي عبر Cron في cPanel إلى مكان خارج السيرفر + نسخ cPanel؛ **اختبار استرجاع فعلي قبل الترحيل** (NFR-008).
- RPO/RTO وهدف التوفر تُحدد مع مزود الاستضافة قبل الإطلاق (NFR-013) — مقترح: RPO ≤ 24 ساعة، RTO ≤ 4 ساعات.

## Environments and delivery

| البيئة | النطاق | قاعدة البيانات | الغرض |
|---|---|---|---|
| Development | `localhost:3000` مع `?org=<slug>` و `?platform=1` (أو `<slug>.localhost:3000`) | `scripts/dev-db.sh` (PostgreSQL محلي بصلاحيات cPanel) + `db/seed/dev.sql` | تطوير |
| Test / CI | — | `scripts/dev-db.sh` على منفذ مستقل لكل تشغيل | اختبارات القاعدة والعزل والـ API و e2e |
| Staging | `*.staging.clinicsyseg.com` | قاعدة منفصلة على hosting.com ببيانات وهمية أو مجهولة الهوية (BR-009) | اختبارات القبول والترحيل |
| Production | `clinicsyseg.com`, `*.clinicsyseg.com` | PostgreSQL على hosting.com | العملاء |

- **البناء:** `npm install` ثم `npm run build` (`scripts/build.mjs`، esbuild) ينتج `dist/`. `npm start` يخدم `dist/`، و `npm run dev` يخدم المصادر مع Babel للتطوير فقط. على Railway يجب أن يظهر في السجل `serving dist/ (production build)`. على hosting.com يُرفع محتوى `dist/` فقط.
- **التشغيل محليًا:** `scripts/dev-db.sh start` → `DATABASE_URL=... node db/migrate.js` → `psql $DATABASE_URL -f db/seed/dev.sql` → `npm run build` → `cd api && npm start`.
- **CI (GitHub Actions):** `npm run build` + `node db/migrate.js` على PostgreSQL مؤقت (service container) + `node --test db/test api/test` (تشمل **اختبارات العزل السلبية**) + Playwright (`e2e/`) لكل PR.
- **CD:** النشر من `main` بعد نجاح CI؛ migrations تُطبق على staging أولًا ثم production بعد الموافقة.
- **Rollback:** كل migration لها خطة رجوع موثقة؛ نسخة احتياطية قبل كل migration إنتاجية.

## Key technical decisions and tradeoffs

| القرار | السبب | البديل المرفوض |
|---|---|---|
| قاعدة بيانات مشتركة + `organization_id` + RLS | أبسط تشغيلًا ويناسب Supabase؛ مشروع واحد للصيانة | قاعدة/مخطط لكل عيادة: عزل أقوى لكن تكلفة وتعقيد migrations أعلى بكثير |
| الدور من جداول العضوية وليس من JWT claims | فوري عند الإيقاف ولا يمكن للمستخدم تعديله | Custom JWT claims: أسرع قليلًا لكن الإيقاف لا يسري حتى انتهاء التوكن |
| تطبيق واحد لكل النطاقات | لا نسخ كود لكل عميل (NFR-010) | نشر لكل عيادة |
| التخصص يحدد الميزات الافتراضية فقط | القرار الإداري يبقى قابلًا للتخصيص (BR-006) | ميزات ثابتة لكل تخصص |
| تخصص رئيسي واحد مع جدول `organization_specialties` لاحقًا | قرار مالك المنتج؛ يُخزن `primary_specialty_id` الآن ويُضاف جدول الربط عند التوسع دون كسر | تعدد التخصصات من البداية |
| الفروع في النواة المشتركة لكل التخصصات | قرار مالك المنتج؛ `branch_id` على المواعيد والجلسات والفواتير والمدفوعات | فروع للعلاج الطبيعي فقط |
| اشتراك يدوي | قرار مالك المنتج؛ لا حاجة لبوابة دفع الآن | Stripe/Paymob من البداية |
| تعطيل الوحدة لا يحذف بياناتها | BR-007 / FR-027 | حذف عند التعطيل |
| ~~Edge Functions بدل Backend Express~~ ← **Node.js API على hosting.com** | قرار مالك المنتج (21 أكتوبر 2026) بنقل كل شيء إلى hosting.com لتوفير تكلفة Supabase | البقاء على Supabase |
| عميل متوافق مع `supabase-js` في الواجهة | الشاشات و `src/supabase.jsx` (حوالي 130 KB) تبقى كما هي، والتغيير محصور في طبقة واحدة | إعادة كتابة كل استدعاءات البيانات |
| RLS داخل PostgreSQL + سياق لكل transaction | العزل يبقى في القاعدة حتى لو أخطأ كود الـ API؛ السياسات الحالية تُعاد استخدامها | التحقق في JavaScript فقط |
| سياسة `tenant_isolation` RESTRICTIVE + `organization_id DEFAULT app_org_id()` | تُضاف فوق سياسات الأدوار الحالية دون إعادة كتابتها، والإدخالات الحالية من الواجهة تأخذ العيادة تلقائيًا | إعادة كتابة كل سياسة |
| أسماء الأدوار الحالية (`admin`...) بدل `clinic_admin` | الواجهة (`roles.jsx`) والسياسات تعتمد عليها | إعادة تسمية في كل مكان |
| معرّفات نصية فريدة عالميًا (`newRecordId(prefix)`) | المعرّفات الحالية مثل `"P-"` + 5 أرقام عشوائية تتصادم بين العيادات | مفتاح مركّب `(organization_id, id)` في كل الجداول والعلاقات |
| ملفات على القرص خلف الـ API | المساحة متاحة (30GB) ولا خدمة تخزين في cPanel | خدمة تخزين خارجية |
| ترجمة مسبقة بـ esbuild الآن، و Vite لاحقًا | يزيل 6–25 ثانية من تجمّد المتصفح دون إعادة هيكلة الملفات (تتشارك متغيرات عامة، فتُدمج بترتيب `index.html`) | Babel داخل المتصفح؛ أو Vite فورًا، وهذا يتطلب تحويل كل الملفات إلى ES modules أولًا |
| مكتبة Excel وصفحة الاستيراد عند الحاجة | لا يحتاجهما معظم الزوار | تحميلهما في كل زيارة |
| قراءة كل الصفوف بصفحات بعد حد Max rows | يمنع اختفاء السجلات بصمت بعد الصف 1000 | رفع *Max rows* في إعدادات Supabase، وهذا يؤجل المشكلة فقط |

## سجل التغييرات

| التاريخ | التغيير |
|---|---|
| 21 أكتوبر 2026 | `src/` و `supabase/` منقولان؛ الأقسام التي تغيرت: أسلوب البناء (esbuild)، و Build output، والمكتبات عند الطلب، وقراءة البيانات (توازي + صفحات)، وأهداف الأداء المقاسة، وخطوة البناء في CI/CD، وقرارات جديدة، وقرار وجهة قاعدة البيانات (مفتوح). الكود: `baebfa9` (نقل `src/`)، `ddd7943` (ترجمة مسبقة)، `11a2c43` (تحميل عند الحاجة)، `04abbe3` (تحميل البيانات) |
| 21 أكتوبر 2026 | **قرار مالك المنتج: نقل القاعدة وكل خدمات Supabase إلى hosting.com.** أُعيدت كتابة Backend and database و Authentication and roles و Architecture، وأُضيفت Repository layout و API contract، وحُدّثت البيئات و CI والأمان والقرارات. |
