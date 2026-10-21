# 5. Backend Schema — ClinicSystem EG

> **الغرض:** تحديد البيانات المخزنة وعلاقاتها وقواعد الوصول إليها.
> قاعدة البيانات: **PostgreSQL على hosting.com (cPanel)** — قرار 21 أكتوبر 2026. نقطة البداية: `Supabase_All_In_One.sql` (عيادة واحدة)، يُنقل إلى `db/migrations/0001_baseline.sql`. الـ API والعقد في [TRD](02-TRD.md).

---

## hosting.com PostgreSQL conventions (ملزمة)

قواعد يلتزم بها كل migration وكل كود يصل إلى القاعدة:

1. **التوافق:** PostgreSQL ≥ 13. **لا extensions** (المخطط الحالي يستخدم `pgcrypto` ويجب إزالته). لا `CREATE ROLE` ولا `GRANT` لأدوار Supabase (`anon`، `authenticated`، `service_role`). السياسات `TO PUBLIC`. لا `storage.*`. لا `citext`: البريد `text` مع فهرس فريد على `lower(email)`.
2. **schema `auth` توافقي** (حتى تعمل الدوال والسياسات الحالية دون إعادة كتابة):
   - `auth.users(id uuid PK default gen_random_uuid(), email text not null, encrypted_password text, raw_user_meta_data jsonb default '{}', status text default 'active' check in ('active','disabled'), session_version int not null default 1, email_confirmed_at timestamptz, last_sign_in_at timestamptz, created_at, updated_at)`، مع فهرس فريد على `lower(email)`.
   - `auth.uid()` = `nullif(current_setting('app.user_id', true), '')::uuid`.
   - `auth.password_reset_tokens(token_hash text PK, user_id uuid, expires_at, used_at)`.
   - المراجع الحالية لـ `auth.identities` تُحذف.
3. **سياق الطلب** (يضبطه الـ API بـ `set_config(..., true)` داخل كل transaction)، وتقرأه دوال `stable` في `public`: `app_org_id()` و `app_branch_id()` و `app_is_system()` (`app.system = 'on'` للعمليات الداخلية في الـ API فقط).
4. **نوعان من الجداول:**
   - **جداول المنصة والهوية** (`auth.*`، `organizations`، `organization_members`، `member_branches`، `platform_admins`، `invitations`، `specialties`، `modules`، `specialty_modules`، `organization_modules`، `subscription_plans`، `subscriptions`، `reserved_slugs`، `schema_migrations`): **لا تُعرض عبر `/api/data`**، وبدون RLS. الوصول إليها فقط عبر مسارات الـ API المخصصة التي تتحقق من الصلاحية. لهذا تقرأها دوال الصلاحيات دون أن تستدعي RLS نفسه بشكل متكرر.
   - **جداول العيادة** (كل جداول `public` الأخرى: `patients`، `bookings`، `staff`، `branches`، `clinic_settings`، `audit_events`...): `ENABLE` + **`FORCE ROW LEVEL SECURITY`**، لأن الـ API يتصل بمالك الجداول، وبدون FORCE يتجاوز المالك كل السياسات.
5. **عمود العيادة:** كل جدول عيادة فيه `organization_id uuid NOT NULL DEFAULT app_org_id() REFERENCES organizations(id)`، وفهرس عليه. الإدخالات الحالية من الواجهة لا ترسل `organization_id`، فتأخذ العيادة الحالية تلقائيًا.
6. **عزل العيادات:** على كل جدول عيادة سياسة **RESTRICTIVE** (تُضاف بـ AND إلى السياسات الحالية):
   ```sql
   create policy tenant_isolation on <t> as restrictive for all to public
     using (app_is_system() or organization_id = app_org_id())
     with check (app_is_system() or organization_id = app_org_id());
   ```
   سياسات الأدوار الحالية تبقى كما هي، وتعمل لأن `app_role()` أصبح يعيد الدور **في العيادة الحالية**.
7. **`app_role()` الجديدة:** دور `auth.uid()` في `organization_members` للعيادة `app_org_id()`، بشرط أن تكون العضوية `active` والعيادة `active`، وإلا `null`. قيم الأدوار: `admin`، `receptionist`، `doctor`، `therapist`، `staff`.
8. **الفرع:** `branch_id text NOT NULL DEFAULT app_branch_id() REFERENCES branches(id)` على `bookings` و `sessions` و `invoices` و `payments` و `payment_receipts` و `patient_schedules` و `treatments`. سياسة RESTRICTIVE ثانية `branch_scope` تسمح للمستخدم بصفوف فروعه فقط (`can_access_branch(branch_id)`؛ `admin` يرى كل فروع عيادته).
9. **القيود الفريدة على مستوى العيادة:** كل `UNIQUE` في جدول عيادة يصبح `(organization_id, ...)`، ومنها: `patients(national_id)`، و `patients(medical_file_no)`، و `staff(lower(email))`، و `payments(receipt_no)`، و `custom_sections(slug)`، و `template_categories(name)`، و `treatment_methods(name)`، و `patient_files(storage_path)`.
10. **المعرّفات:** المفاتيح النصية الحالية (`patient_id`...) تبقى مفتاحًا أساسيًا مفردًا، لكن يجب أن تكون **فريدة عالميًا**. الواجهة تولّدها بـ `newRecordId(prefix)` = `prefix + Date.now().toString(36) + 6 أحرف عشوائية base36`، بدل `"P-" + 5 أرقام`. التصادم بين عيادتين يفشل بخطأ RLS ولا يكشف بيانات.
11. **`clinic_settings`:** يصبح سجلًا لكل عيادة: `PRIMARY KEY (organization_id, id)` مع إبقاء `id = 1`. الاستعلام الحالي `.eq("id", 1)` يعيد سجل العيادة الحالية.
12. **دوال `security definer` الحالية** تعمل كمالك الجداول، والمالك خاضع لـ FORCE RLS، فتعمل بصلاحيات المستخدم والعيادة الحاليين. هذا مقصود. `search_path` ثابت في كل دالة.


## Entities

### كيانات المنصة (جديدة)

| الكيان | ماذا يمثل |
|---|---|
| `organizations` | عيادة/مؤسسة واحدة (المستأجر): الاسم، الـ slug، التخصص الرئيسي، الحالة، الخطة |
| `platform_admins` | مستخدمو Super Admin (خارج أي عيادة) |
| `organization_members` | عضوية مستخدم Auth في عيادة، بدور وحالة |
| `member_branches` | الفروع المسموح بها لعضو داخل عيادته |
| `invitations` | دعوة معلقة لبريد إلى عيادة بدور وفروع محددة |
| `specialties` | كتالوج التخصصات (physio، dental، general) |
| `modules` | كتالوج وحدات المنتج (نواة مشتركة + تخصصية) وتبعياتها |
| `specialty_modules` | الوحدات الافتراضية لكل تخصص |
| `organization_modules` | الوحدات المفعلة/المعطلة لكل عيادة |
| `clinic_settings` (معدل) | إعدادات كل عيادة: الجدول الحالي يصبح سجلًا لكل عيادة (القاعدة 11) |
| `subscription_plans` | الخطط وحدودها (المستخدمون، الفروع، التخزين، الوحدات) |
| `subscriptions` | اشتراك العيادة الحالي والسابق (يدوي) |
| `reserved_slugs` | slugs محجوزة لا تُستخدم للعيادات (`admin`، `www`، `api`، `app`، `staging`، `mail`…) |

### كيانات العيادة (موجودة — تُضاف لها `organization_id` وأحيانًا `branch_id`)

| الكيان | ماذا يمثل | `organization_id` | `branch_id` |
|---|---|---|---|
| `branches` | فروع العيادة — **في كل التخصصات** | ✓ | — |
| `patients` | المرضى (على مستوى العيادة، يُخدمون في أي فرع) | ✓ | `home_branch_id` اختياري |
| `bookings` | المواعيد | ✓ | ✓ إلزامي |
| `sessions`, `treatments`, `patient_schedules` | الجلسات وخطط العلاج والجداول المتكررة | ✓ | ✓ |
| `invoices`, `payments`, `payment_receipts` | الفوترة والتحصيل | ✓ | ✓ |
| `packages`, `patient_subscriptions` | باقات الجلسات واشتراكات المرضى | ✓ | — |
| `staff`, `therapists`, `doctors`, `receptionists` | ملفات الموظفين التشغيلية | ✓ | عبر `member_branches` |
| `departments` | الأقسام | ✓ | — |
| `patient_files` | بيانات الملفات الوصفية؛ `storage_path` نسبي داخل مجلد العيادة | ✓ | — |
| `treatment_templates`, `template_categories`, `template_versions`, `template_usage`, `treatment_methods` | قوالب العلاج الطبيعي | ✓ (`null` = قالب عام للمنصة، للقراءة فقط) | — |
| `campaigns`, `custom_sections` | حملات واتساب وأقسام مخصصة | ✓ | — |
| `audit_events` | سجل التدقيق | ✓ (`null` لعمليات المنصة) | — |

## Tables

> الأنواع: `uuid` بـ `default gen_random_uuid()` للجداول الجديدة. الجداول القديمة تحتفظ بمفاتيحها النصية (`patient_id text`…) لتجنب كسر الواجهة.

### `organizations`

| الحقل | النوع | إلزامي | الافتراضي | ملاحظات |
|---|---|---|---|---|
| `id` | uuid PK | ✓ | `gen_random_uuid()` | |
| `name` | text | ✓ | | اسم العرض، 2–120 حرفًا |
| `slug` | text | ✓ | | **unique** على `lower(slug)`؛ `^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$`؛ ليس في `reserved_slugs` |
| `primary_specialty_id` | uuid FK → `specialties` | ✓ | | تخصص رئيسي واحد في الإصدار الأول |
| `status` | text | ✓ | `'draft'` | `draft`, `pending_activation`, `active`, `suspended`, `closed` |
| `status_reason` | text | | | إلزامي عند `suspended`/`closed` |
| `suspended_at` | timestamptz | | | |
| `retention_until` | timestamptz | | | `suspended_at + interval '6 months'` |
| `plan_id` | uuid FK → `subscription_plans` | | | |
| `created_by` | uuid FK → `auth.users` | ✓ | | |
| `created_at`, `updated_at` | timestamptz | ✓ | `now()` | |

**Indexes:** `unique(slug)`، `(status)`.

### `platform_admins`

`user_id uuid PK FK → auth.users` · `created_at` · `created_by`. يُدار فقط عبر `api/scripts/create-super-admin.js` أو SQL مباشر؛ لا يُعرض عبر أي مسار API للكتابة.

### `organization_members`

| الحقل | النوع | إلزامي | الافتراضي | ملاحظات |
|---|---|---|---|---|
| `id` | uuid PK | ✓ | | |
| `organization_id` | uuid FK → `organizations` on delete cascade | ✓ | | |
| `user_id` | uuid FK → `auth.users` | ✓ | | |
| `role` | text | ✓ | | `admin` (مدير العيادة)، `receptionist`، `doctor`، `therapist`، `staff` — نفس قيم الكود الحالي |
| `status` | text | ✓ | `'invited'` | `invited`, `active`, `disabled` |
| `invited_by` | uuid | | | |
| `joined_at` | timestamptz | | | عند قبول الدعوة |
| `created_at`, `updated_at` | timestamptz | ✓ | `now()` | |

**Indexes:** `unique(organization_id, user_id)`، `(user_id, status)`.

### `member_branches`

`member_id uuid FK → organization_members on delete cascade` · `branch_id text FK → branches on delete cascade` · `organization_id uuid` · **PK (member_id, branch_id)**. لا صفوف لـ `admin` = كل الفروع.

### `invitations`

| الحقل | النوع | ملاحظات |
|---|---|---|
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `email` | text | فهرس على `lower(email)` |
| `token_hash` | text unique | SHA-256 للرمز؛ الرمز نفسه لا يُخزن |
| `role` | text | نفس قيم `organization_members.role` |
| `branch_ids` | text[] | |
| `status` | text | `pending`, `accepted`, `revoked`, `expired` |
| `invited_by` | uuid | |
| `expires_at` | timestamptz | الافتراضي `now() + 7 days` |
| `created_at` | timestamptz | |

**Indexes:** `unique(organization_id, lower(email)) where status = 'pending'`، و `unique(token_hash)`.

### `specialties` / `modules` / `specialty_modules` / `organization_modules`

| الجدول | الحقول |
|---|---|
| `specialties` | `id uuid PK`, `code text unique` (`physio`, `dental`, `general`), `name_ar text`, `name_en text`, `status text default 'active'` |
| `modules` | `id uuid PK`, `code text unique` (مثل `core.patients`, `core.branches`, `physio.sessions`, `dental.chart`), `name_ar`, `category text` (`core` / `specialty`), `depends_on text[]` (أكواد)، `status text default 'active'` |
| `specialty_modules` | `specialty_id`, `module_id`, **PK** (الاثنان) |
| `organization_modules` | `organization_id`, `module_id`, `enabled boolean default true`, `configured_by uuid`, `updated_at`, **PK** (`organization_id`, `module_id`) |

**وحدات النواة المشتركة (مفعلة افتراضيًا لكل التخصصات):** `core.patients`، `core.appointments`، `core.billing`، `core.staff`، **`core.branches`**، `core.files`، `core.reports`، `core.settings`.

### `clinic_settings` (معدل — بدل `organization_settings`)

الجدول الحالي (`name`، `subtitle`، `logo`، `primary_color`، ساعات التقويم...) + `organization_id uuid NOT NULL DEFAULT app_org_id()`، و `PRIMARY KEY (organization_id, id)` مع إبقاء `id = 1` (القاعدة 11)، فلا تتغير استعلامات الواجهة. يُنشأ سجل لكل عيادة عند إنشائها. الشعار واللون اختياريان (قرار مفتوح في PRD).

### `branches` (معدل)

| الحقل | النوع | إلزامي | ملاحظات |
|---|---|---|---|
| `id` | text PK | ✓ | يبقى كما هو |
| `organization_id` | uuid FK | ✓ | **جديد** |
| `name` | text | ✓ | **unique (organization_id, name)** |
| `address`, `phone` | text | | |
| `working_hours` | jsonb | | **جديد**: `{ "sat": ["09:00","21:00"], … }` |
| `rooms` | int | | default 0 |
| `status` | text | ✓ | **جديد**: `active` / `inactive` |
| `created_at`, `updated_at` | timestamptz | | |

يُحذف عمود `therapists int` (عدد محسوب، يُستخرج من `member_branches`).

### `subscription_plans` / `subscriptions`

| الجدول | الحقول |
|---|---|
| `subscription_plans` | `id`, `code unique`, `name`, `max_users int null`, `max_branches int null`, `max_storage_mb int null`, `included_modules text[]`, `status` — `null` = بلا حد. **القيم تُحدد تجاريًا** |
| `subscriptions` | `id`, `organization_id`, `plan_id`, `status` (`trial`, `active`, `past_due`, `cancelled`), `period_start date`, `period_end date`, `notes`, `set_by uuid`, `created_at` |

### `patient_files` (معدل — بدل `stored_files`)

الجدول الحالي + `organization_id`. `storage_path` نسبي (مثل `patients/P-.../file.pdf`)، والملف الفعلي في `FILES_DIR/<organization_id>/patient-files/<storage_path>`. `unique (organization_id, storage_path)`. الملفات تبقى خاصة ولا تُخدم إلا عبر `/api/files/*`.

### `audit_events` (معدل)

الحقول الحالية + `organization_id uuid null` + `target_type text` + `target_id text` + `result text` (`success` / `denied` / `error`). **Index:** `(organization_id, created_at desc)`، `(actor_uid, created_at desc)`.

## Relationships

```
auth.users 1─┬─* organization_members *─1 organizations 1─* branches
             │            │                    │
             │            └─* member_branches *┘ (عضو ↔ فرع: many-to-many)
             └─0..1 platform_admins

specialties 1─* organizations (primary_specialty_id)
specialties *─* modules            (عبر specialty_modules)
organizations *─* modules          (عبر organization_modules)
subscription_plans 1─* organizations / subscriptions
organizations 1─* invitations, subscriptions, audit_events, patient_files

organizations 1─* patients 1─* bookings, sessions, invoices, payments, treatments
branches      1─* bookings, sessions, invoices, payments, treatments
```

- كل FK من جدول عيادة إلى جدول عيادة آخر يجب أن يكون **داخل نفس المؤسسة**؛ يُفرض بمفتاح مركب، مثال: `bookings (organization_id, patient_id) references patients (organization_id, patient_id)` بعد إضافة `unique (organization_id, patient_id)` على `patients`.

## User ownership

- **كل سجل تشغيلي ملك لمؤسسة** (`organization_id NOT NULL`)، وليس لمستخدم.
- **السجلات المرتبطة بفرع** (المواعيد، الجلسات، الفواتير، المدفوعات) يراها فقط أعضاء ذلك الفرع و `admin` العيادة.
- **سجلات الممارس:** الطبيب والمعالج يريان مرضاهم ومواعيدهم (حسب `doctor_id`/`therapist_id`) كما في النظام الحالي.
- **المستخدم** يملك فقط ملفه الشخصي في `auth.users`؛ عضوياته يديرها مدير العيادة أو Super Admin.

## Authentication flow

كل الخطوات عبر الـ API ([TRD — API contract](02-TRD.md#api-contract)):

1. **إنشاء الحساب:** لا تسجيل ذاتي. دعوة من Super Admin أو من `admin` العيادة: صف في `invitations` بـ `token_hash`، وبريد فيه الرابط `https://<slug>.clinicsyseg.com/?invite=<token>`.
2. **قبول الدعوة:** `POST /api/invitations/:token/accept` يتحقق من الـ hash والصلاحية والحالة → ينشئ `auth.users` (أو يربط حسابًا موجودًا بنفس البريد) → `organization_members (status='active')` + `staff` + `member_branches` → `invitations.status='accepted'` → أول `admin` ينقل العيادة من `pending_activation` إلى `active` → يسجّل الدخول.
3. **الدخول:** `POST /api/auth/login` يقارن bcrypt، ويرفض الحساب `disabled`، ويصدر cookie `cs_session` (JWT `{sub, sv}`)، ويعيد العضويات النشطة في العيادات النشطة.
4. **إعادة التعيين:** `POST /api/auth/reset/request` برد عام دائمًا؛ رمز في `auth.password_reset_tokens` صالح ساعة واحدة ولاستخدام واحد.
5. **الجلسة:** كل طلب يتحقق من JWT ومن أن `sv = auth.users.session_version`، وأن الحساب `active`. تغيير كلمة المرور أو التعطيل يزيد `session_version`، فتبطل كل الجلسات فورًا.
6. **الخروج:** مسح الـ cookie.
7. **نقل المستخدمين من Supabase:** `auth.users.encrypted_password` في Supabase هو bcrypt، فيُنقل كما هو.

## Authorization rules

**دوال مساعدة** (`stable`، `search_path` ثابت، تقرأ السياق من `set_config`):

```sql
app_org_id() returns uuid              -- current_setting('app.org_id', true)
app_branch_id() returns text           -- current_setting('app.branch_id', true)
app_is_system() returns boolean        -- current_setting('app.system', true) = 'on'
app_role() returns text                -- دور auth.uid() في app_org_id() (عضوية active + عيادة active)، وإلا null
is_super_admin() returns boolean       -- صف في platform_admins لـ auth.uid()
can_access_branch(branch text) returns boolean -- admin، أو صف في member_branches
org_module_enabled(code text) returns boolean  -- organization_modules للعيادة الحالية
```

جداول المنصة والهوية بدون RLS ولا تُعرض عبر `/api/data`، فصلاحياتها في الجدول أدناه **تُطبق في مسارات الـ API**. جداول العيادة تُطبق صلاحياتها في RLS.

| الكيان | Read | Create | Update | Delete |
|---|---|---|---|---|
| `organizations` | Super Admin؛ الأعضاء: سجل مؤسستهم فقط (حقول عامة عبر `/api/orgs/*`) | Super Admin (`/api/platform`) | Super Admin | لا أحد (`closed` بدل الحذف) |
| `organization_members` | Super Admin؛ `admin` العيادة | مسارات الدعوة و `create-user` فقط | Super Admin؛ `admin` لعيادته (لا يمنح Super Admin) | لا (`disabled`) |
| `invitations` | Super Admin؛ `admin` لعيادته | Super Admin؛ `admin` (ضمن حد المستخدمين) | نفس الصلاحية (إلغاء/إعادة إرسال) | — |
| `branches` | أعضاء العيادة | `admin` (ضمن حد الفروع؛ trigger يرفض التجاوز) | `admin` | لا (`status='inactive'`) |
| `specialties`, `modules`, `subscription_plans` | كل مستخدم مسجل | Super Admin | Super Admin | Super Admin |
| `organization_modules`, `subscriptions` | Super Admin؛ أعضاء المؤسسة (قراءة) | Super Admin | Super Admin | Super Admin |
| `clinic_settings` (لكل عيادة) | أعضاء العيادة | تلقائي عند إنشاء العيادة | `admin` | — |
| `patients` | أعضاء المؤسسة حسب الدور (الطبيب/المعالج: مرضاه) | admin, receptionist | admin, receptionist, doctor | admin |
| `bookings` | `can_access_branch` + الدور | admin, receptionist (في فرعه) | admin, receptionist | admin |
| `invoices`, `payments` | admin, receptionist (فرعه) | admin, receptionist | admin | admin (مع سجل تدقيق) |
| `sessions`, `treatments` | admin, doctor, therapist (فرعه/مرضاه) + `org_module_enabled('physio.sessions')` | doctor, therapist | doctor, therapist | admin |
| `patient_files` + الملفات | أعضاء العيادة حسب الدور؛ الملف في مجلد العيادة على القرص | admin, receptionist, doctor, therapist | — | المرفوع أو admin |
| `audit_events` | Super Admin (`/api/platform/audit`)؛ `admin` لعيادته | الـ API والدوال فقط | لا أحد | لا أحد |

**قاعدة عامة لكل جدول عيادة:** سياسة `tenant_isolation` RESTRICTIVE (القاعدة 6 في الأعلى)، و `branch_scope` للجداول المرتبطة بفرع، فوق سياسات الأدوار الحالية المبنية على `app_role()`. Super Admin **لا يرى بيانات المرضى**: سياق العيادة لا يُضبط له إلا إن كان عضوًا فيها (BR-008).

## Data access rules

- **حد الصفوف:** `/api/data` يعيد في كل طلب 1000 صف كحد أقصى، كما كان يفعل PostgREST في Supabase. أي قراءة لقائمة كاملة **يجب** أن تمر عبر `selectAllRows(cfg)` في `src/supabase.jsx`: طلب أول مع `count: "exact"`، ثم إذا كان الجدول أكبر مما وصل، صفحات متوازية مرتبة بالمفتاح الأساسي. المفتاح الأساسي مفهرس دائمًا، فالترتيب رخيص.
- **التوازي:** الجداول المستقلة تُطلب معًا (`Promise.all`)، لا واحدًا بعد الآخر.
- **ترتيب الصفوف:** الجداول الأكبر من *Max rows* تصل مرتبة بالمفتاح الأساسي. الشاشات التي تحتاج ترتيبًا آخر ترتب بنفسها.
- **المستقبل (F18):** بدل تحميل كل الجداول عند البداية، كل شاشة تطلب ما تعرضه: المواعيد لنطاق التاريخ، والمرضى بالبحث و `.range()`، والتقارير عبر دوال RPC تجمّع داخل قاعدة البيانات. مع تعدد العيادات تُضاف فهارس `(organization_id, date)` و `(organization_id, branch_id)`.
- **إن نُقلت القاعدة إلى hosting.com:** القواعد نفسها تُطبق في خادم Node.js API بدل PostgREST ([08](08-Hosting-Migration.md)).

## Data validation

| القاعدة | التطبيق |
|---|---|
| slug | 3–32 حرفًا، أحرف صغيرة/أرقام/شرطة، لا يبدأ أو ينتهي بشرطة، فريد (case-insensitive)، ليس محجوزًا — `check` + `unique` |
| اسم العيادة | 2–120 حرفًا |
| البريد | صيغة صالحة؛ فريد على `lower(email)` |
| حالة المؤسسة | انتقالات مسموحة فقط: `draft→pending_activation→active⇄suspended→closed`؛ عبر دالة `set_organization_status` |
| `status_reason` | إلزامي عند `suspended`/`closed` |
| حدود الخطة | trigger قبل الإدخال على `organization_members`/`invitations` (عدد المستخدمين) و `branches` (عدد الفروع)؛ ومجموع أحجام الملفات في مجلد العيادة قبل الرفع (في الـ API) |
| تبعيات الوحدات | لا يُفعل `X` إن لم تكن كل `depends_on` مفعلة؛ ولا تُعطل وحدة تعتمد عليها وحدة مفعلة |
| تطابق المؤسسة | FK مركبة `(organization_id, …)` بين جداول العيادة |
| الدور | `admin` لا يمنح دورًا خارج القائمة ولا يعدل `platform_admins` |
| الموعد | `branch_id` إلزامي ويتبع نفس المؤسسة؛ لا تعارض لنفس الممارس في نفس الوقت |
| المبالغ | `amount > 0` (كما في `payments` الحالي) |

## Retention and deletion

| الحالة | ما يحدث |
|---|---|
| تعطيل وحدة | لا حذف؛ تُمنع الواجهة والعمليات فقط (BR-007) |
| تعطيل عضوية | `status='disabled'`؛ السجل وتاريخ العمليات يبقيان (FR-034) |
| إيقاف عيادة | `status='suspended'`، `retention_until = suspended_at + 6 months`؛ لا وصول عادي؛ البيانات والملفات محفوظة |
| بعد 6 أشهر | **قرار مفتوح** (حذف نهائي أم أرشفة). حتى القرار: لا حذف آلي؛ تقرير شهري لـ Super Admin بالعيادات التي تجاوزت `retention_until` |
| التصدير والاستعادة | **قرار مفتوح**. المقترح: Super Admin يصدّر بيانات العيادة (CSV/JSON + الملفات) عند الطلب، والاستعادة بإعادة التفعيل خلال فترة الاحتفاظ |
| سجل التدقيق | لا يُحذف ولا يُعدل |
| الحذف داخل العيادة | الحذف الفعلي للمرضى والمدفوعات للمدير فقط ومع سجل تدقيق؛ يُفضل الإلغاء/الأرشفة |

## Migration and seed data

**المسار:** `db/migrations/NNNN_name.sql`، ويطبقها `node db/migrate.js` (جدول `schema_migrations`، كل ملف داخل transaction). كل ملف يُختبر على `scripts/dev-db.sh` (مالك بدون superuser). `supabase/migrations/` و `Supabase_All_In_One.sql` يبقيان للمرجعية فقط.

1. `0001_baseline.sql` — نقل `Supabase_All_In_One.sql` إلى PostgreSQL عادي: schema `auth` التوافقي (القاعدة 2)، وحذف `pgcrypto` و `storage.*` و `auth.identities` و `grant`/`to authenticated`، وتحويل السياسات إلى `TO PUBLIC`، وفصل بذور قوالب العلاج إن لزم. **السلوك لعيادة واحدة يبقى كما هو.**
2. `0002_platform.sql` — `organizations`، `platform_admins`، `organization_members`، `member_branches`، `invitations`، `specialties`، `modules`، `specialty_modules`، `organization_modules`، `subscription_plans`، `subscriptions`، `reserved_slugs` + بذر الكتالوج: 3 تخصصات، والوحدات (النواة المشتركة `core.*` بما فيها `core.branches` + وحدات العلاج الطبيعي الحالية)، والربط الافتراضي، والـ slugs المحجوزة (`admin`، `www`، `api`، `app`، `staging`، `mail`، `static`).
3. `0003_tenancy.sql` — دوال السياق، وإعادة تعريف `app_role()`، و `organization_id` و `branch_id` (القاعدتان 5 و 8)، والقيود الفريدة على مستوى العيادة (9)، و `clinic_settings` لكل عيادة (11)، و FORCE RLS و `tenant_isolation` و `branch_scope` على كل جداول العيادة، و triggers حدود الخطة (الفروع والمستخدمون)، وأعمدة التدقيق (`organization_id`، `target_type`، `target_id`، `result`). **إن وُجدت بيانات قديمة:** تُنشأ «العيادة الأولى» (`physio`، `active`) و «الفرع الرئيسي»، وتُسند إليهما كل الصفوف، وتُحوَّل صفوف `staff` المرتبطة بحساب إلى `organization_members` بنفس الدور.
4. `0004_...` وما بعدها — أي إصلاح لاحق كملف جديد؛ **لا يُعدل ملف طُبّق على قاعدة مشتركة**.

**بيانات البذر للتطوير والاختبار** (`db/seed/dev.sql`، **لا يُطبق على الإنتاج أبدًا**): Super Admin (`super@clinicsys.test`)، وعيادتان `demo-physio` (علاج طبيعي) و `demo-dental` (أسنان)، بفرعين لكل منهما، ومستخدم لكل دور في كل عيادة (`<role>@<slug>.test`)، وبضعة مرضى ومواعيد. كلمة مرور التطوير الموحدة `Dev@12345` (bcrypt) موثقة هنا فقط. **لا بيانات حقيقية في staging** إلا بعد إخفاء الهوية (BR-009).

**نقل البيانات الحقيقية من Supabase** (المهمة 4.7): `pg_dump --data-only` لجداول `public` + `auth.users` (id، email، encrypted_password، raw_user_meta_data) ← استيراد إلى قاعدة hosting.com بعد `0001`، ثم `0003` يسندها إلى العيادة الأولى. الملفات تُنزّل من bucket `patient-files` إلى `FILES_DIR/<org>/patient-files/`.

**التحقق بعد الترحيل:** مطابقة أعداد السجلات لكل جدول قبل وبعد، وعدم وجود `organization_id IS NULL`، وكل `branch_id` يتبع نفس العيادة، وتقرير ترحيل محفوظ (AT-11).

## سجل التغييرات

| التاريخ | التغيير |
|---|---|
| 21 أكتوبر 2026 | إضافة قسم «Data access rules» (حد الـ 1000 صف، التوازي، الترتيب، الخطة المستقبلية)، وتوحيد تسمية الـ migrations مع مجلد `supabase/migrations/` المنقول. الكود: `baebfa9` (نقل `src/`)، `ddd7943` (ترجمة مسبقة)، `11a2c43` (تحميل عند الحاجة)، `04abbe3` (تحميل البيانات) |
| 21 أكتوبر 2026 | **القاعدة تنتقل إلى hosting.com:** إضافة «hosting.com PostgreSQL conventions» (12 قاعدة ملزمة)؛ أسماء الأدوار تبقى (`admin`...)؛ `invitations.token_hash`؛ إعادة كتابة Authentication flow و Authorization rules و Migration and seed data لمسار `db/migrations/`. |
