# 5. Backend Schema — ClinicSystem EG

> **الغرض:** تحديد البيانات المخزنة وعلاقاتها وقواعد الوصول إليها.
> قاعدة البيانات: Supabase PostgreSQL. نقطة البداية: `Supabase_All_In_One.sql` (عيادة واحدة). هذا المخطط **تصميم مقترح** يجب مراجعته مع المخطط الحالي قبل كتابة الـ migrations (BRD قسم 10).

---

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
| `organization_settings` | إعدادات كل عيادة (تحل محل `clinic_settings` ذي السجل الوحيد) |
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
| `patient_files` → `stored_files` | بيانات الملفات الوصفية | ✓ | — |
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
| `slug` | citext | ✓ | | **unique**؛ `^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$`؛ ليس في `reserved_slugs` |
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

`user_id uuid PK FK → auth.users` · `created_at` · `created_by`. يُدار يدويًا عبر SQL/Edge Function فقط؛ لا سياسة INSERT من العميل.

### `organization_members`

| الحقل | النوع | إلزامي | الافتراضي | ملاحظات |
|---|---|---|---|---|
| `id` | uuid PK | ✓ | | |
| `organization_id` | uuid FK → `organizations` on delete cascade | ✓ | | |
| `user_id` | uuid FK → `auth.users` | ✓ | | |
| `role` | text | ✓ | | `clinic_admin`, `receptionist`, `doctor`, `therapist`, `staff` |
| `status` | text | ✓ | `'invited'` | `invited`, `active`, `disabled` |
| `invited_by` | uuid | | | |
| `joined_at` | timestamptz | | | عند قبول الدعوة |
| `created_at`, `updated_at` | timestamptz | ✓ | `now()` | |

**Indexes:** `unique(organization_id, user_id)`، `(user_id, status)`.

### `member_branches`

`member_id uuid FK → organization_members on delete cascade` · `branch_id text FK → branches on delete cascade` · `organization_id uuid` · **PK (member_id, branch_id)**. لا صفوف لـ `clinic_admin` = كل الفروع.

### `invitations`

| الحقل | النوع | ملاحظات |
|---|---|---|
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `email` | citext | |
| `role` | text | نفس قيم `organization_members.role` |
| `branch_ids` | text[] | |
| `status` | text | `pending`, `accepted`, `revoked`, `expired` |
| `invited_by` | uuid | |
| `expires_at` | timestamptz | الافتراضي `now() + 7 days` |
| `created_at` | timestamptz | |

**Indexes:** `unique(organization_id, email) where status = 'pending'`.

### `specialties` / `modules` / `specialty_modules` / `organization_modules`

| الجدول | الحقول |
|---|---|
| `specialties` | `id uuid PK`, `code text unique` (`physio`, `dental`, `general`), `name_ar text`, `name_en text`, `status text default 'active'` |
| `modules` | `id uuid PK`, `code text unique` (مثل `core.patients`, `core.branches`, `physio.sessions`, `dental.chart`), `name_ar`, `category text` (`core` / `specialty`), `depends_on text[]` (أكواد)، `status text default 'active'` |
| `specialty_modules` | `specialty_id`, `module_id`, **PK** (الاثنان) |
| `organization_modules` | `organization_id`, `module_id`, `enabled boolean default true`, `configured_by uuid`, `updated_at`, **PK** (`organization_id`, `module_id`) |

**وحدات النواة المشتركة (مفعلة افتراضيًا لكل التخصصات):** `core.patients`، `core.appointments`، `core.billing`، `core.staff`، **`core.branches`**، `core.files`، `core.reports`، `core.settings`.

### `organization_settings`

`organization_id uuid PK FK` · `display_name text` · `subtitle text` · `logo_file_id uuid` (اختياري — قرار مفتوح) · `primary_color text` (اختياري) · `calendar_start time default '09:00'` · `calendar_end time default '21:00'` · `settings jsonb default '{}'` · `updated_at`.

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

### `stored_files` (يحل محل `patient_files`)

`id uuid` · `organization_id` · `owner_type text` (`patient`, `organization`) · `owner_id text` · `storage_key text` (`{organization_id}/{owner_id}/{uuid}-{filename}`) · `file_name` · `mime_type` · `size_bytes bigint` · `visibility text default 'private'` · `created_by uuid` · `created_at`.

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
organizations 1─* invitations, subscriptions, audit_events, stored_files

organizations 1─* patients 1─* bookings, sessions, invoices, payments, treatments
branches      1─* bookings, sessions, invoices, payments, treatments
```

- كل FK من جدول عيادة إلى جدول عيادة آخر يجب أن يكون **داخل نفس المؤسسة**؛ يُفرض بمفتاح مركب، مثال: `bookings (organization_id, patient_id) references patients (organization_id, patient_id)` بعد إضافة `unique (organization_id, patient_id)` على `patients`.

## User ownership

- **كل سجل تشغيلي ملك لمؤسسة** (`organization_id NOT NULL`)، وليس لمستخدم.
- **السجلات المرتبطة بفرع** (المواعيد، الجلسات، الفواتير، المدفوعات) يراها فقط أعضاء ذلك الفرع و `clinic_admin`.
- **سجلات الممارس:** الطبيب والمعالج يريان مرضاهم ومواعيدهم (حسب `doctor_id`/`therapist_id`) كما في النظام الحالي.
- **المستخدم** يملك فقط ملفه الشخصي في `auth.users`؛ عضوياته يديرها مدير العيادة أو Super Admin.

## Authentication flow

1. **إنشاء الحساب:** لا تسجيل ذاتي. Edge Function `invite-member` تنشئ صف `invitations` وتستدعي `auth.admin.inviteUserByEmail` (أو تربط مستخدمًا موجودًا).
2. **قبول الدعوة:** المستخدم يعيّن كلمة المرور ← Edge Function `accept-invitation` تتحقق من التوكن والبريد والصلاحية ← تنشئ `organization_members (status='active')` و `member_branches` ← `invitations.status='accepted'`. أول مدير يقبل دعوته ينقل العيادة من `pending_activation` إلى `active`.
3. **الدخول:** `signInWithPassword` ← الواجهة تستدعي `my_memberships()` (عضويات نشطة في مؤسسات نشطة فقط).
4. **إعادة التعيين:** `resetPasswordForEmail` برسالة عامة لا تكشف وجود البريد.
5. **الجلسة:** JWT ساعة + refresh؛ لا يُخزن الدور في JWT. الإيقاف يسري فورًا عبر RLS.
6. **الخروج:** `signOut` + مسح الحالة المحلية.

## Authorization rules

**دوال مساعدة** (`security definer`, `stable`, `search_path = public`) — تحل محل `app_role()`:

```sql
is_super_admin()                       -- صف في platform_admins
is_org_member(org uuid)                -- عضوية active + المؤسسة active
org_role(org uuid) returns text        -- الدور، أو null
has_org_role(org uuid, roles text[])
can_access_branch(org uuid, branch text) -- clinic_admin أو صف في member_branches
org_module_enabled(org uuid, code text)
```

| الكيان | Read | Create | Update | Delete |
|---|---|---|---|---|
| `organizations` | Super Admin؛ الأعضاء: سجل مؤسستهم فقط (حقول عامة) | Super Admin (Edge Function) | Super Admin | لا أحد (`closed` بدل الحذف) |
| `organization_members` | Super Admin؛ أعضاء المؤسسة | Edge Function فقط | Super Admin؛ `clinic_admin` لعيادته ولأدوار ≠ super admin | لا (`disabled`) |
| `invitations` | Super Admin؛ `clinic_admin` لعيادته | Super Admin؛ `clinic_admin` (ضمن حد المستخدمين) | نفس المنشئ (إلغاء/إعادة إرسال) | — |
| `branches` | أعضاء المؤسسة | `clinic_admin` (ضمن حد الفروع)، Super Admin | `clinic_admin` | لا (`inactive`) |
| `specialties`, `modules`, `subscription_plans` | كل مستخدم مسجل | Super Admin | Super Admin | Super Admin |
| `organization_modules`, `subscriptions` | Super Admin؛ أعضاء المؤسسة (قراءة) | Super Admin | Super Admin | Super Admin |
| `organization_settings` | أعضاء المؤسسة | تلقائي عند الإنشاء | `clinic_admin` | — |
| `patients` | أعضاء المؤسسة حسب الدور (الطبيب/المعالج: مرضاه) | admin, receptionist | admin, receptionist, doctor | admin |
| `bookings` | `can_access_branch` + الدور | admin, receptionist (في فرعه) | admin, receptionist | admin |
| `invoices`, `payments` | admin, receptionist (فرعه) | admin, receptionist | admin | admin (مع سجل تدقيق) |
| `sessions`, `treatments` | admin, doctor, therapist (فرعه/مرضاه) + `org_module_enabled('physio.sessions')` | doctor, therapist | doctor, therapist | admin |
| `stored_files` + Storage | أعضاء المؤسسة حسب الدور؛ المسار يبدأ بـ `organization_id` | admin, receptionist, doctor, therapist | — | المرفوع أو admin |
| `audit_events` | Super Admin؛ `clinic_admin` لعيادته | دوال/triggers فقط | لا أحد | لا أحد |

**قاعدة عامة لكل سياسة على جدول عيادة:**
`using ( (select is_super_admin()) or ( (select is_org_member(organization_id)) and <شرط الدور/الفرع/الوحدة> ) )`
و `with check` بنفس الشرط حتى لا يُكتب سجل بـ `organization_id` لمؤسسة أخرى (BR-008).

## Data validation

| القاعدة | التطبيق |
|---|---|
| slug | 3–32 حرفًا، أحرف صغيرة/أرقام/شرطة، لا يبدأ أو ينتهي بشرطة، فريد (case-insensitive)، ليس محجوزًا — `check` + `unique` |
| اسم العيادة | 2–120 حرفًا |
| البريد | صيغة صالحة، `citext` |
| حالة المؤسسة | انتقالات مسموحة فقط: `draft→pending_activation→active⇄suspended→closed`؛ عبر دالة `set_organization_status` |
| `status_reason` | إلزامي عند `suspended`/`closed` |
| حدود الخطة | trigger قبل الإدخال على `organization_members`/`invitations` (عدد المستخدمين) و `branches` (عدد الفروع)؛ ومجموع `stored_files.size_bytes` قبل الرفع |
| تبعيات الوحدات | لا يُفعل `X` إن لم تكن كل `depends_on` مفعلة؛ ولا تُعطل وحدة تعتمد عليها وحدة مفعلة |
| تطابق المؤسسة | FK مركبة `(organization_id, …)` بين جداول العيادة |
| الدور | `clinic_admin` لا يمنح دورًا خارج القائمة ولا يعدل `platform_admins` |
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

**ترتيب الـ migrations** (كل خطوة ملف مستقل تحت `supabase/migrations/`، مع نسخة احتياطية واختبار استرجاع قبل التنفيذ على الإنتاج):

1. `0100_platform_tables.sql` — `organizations`, `platform_admins`, `specialties`, `modules`, `specialty_modules`, `organization_modules`, `subscription_plans`, `subscriptions`, `reserved_slugs`, `invitations`, `organization_members`, `member_branches`, `organization_settings`.
2. `0110_seed_catalog.sql` — التخصصات الثلاثة، الوحدات (النواة المشتركة بما فيها `core.branches` + وحدات العلاج الطبيعي الحالية)، الربط الافتراضي، الـ slugs المحجوزة.
3. `0120_first_organization.sql` — إنشاء المؤسسة الأولى للعيادة الحالية (تخصص `physio`، حالة `active`)، وتحويل `clinic_settings (id=1)` إلى `organization_settings`، وتحويل صفوف `staff` إلى `organization_members` بنفس الأدوار (`admin` → `clinic_admin`).
4. `0130_add_organization_id.sql` — إضافة `organization_id` (nullable) لكل جداول العيادة، ملؤها بمعرف المؤسسة الأولى، ثم `NOT NULL` + فهارس + FK مركبة.
5. `0140_branches_everywhere.sql` — إنشاء «الفرع الرئيسي» للمؤسسة الأولى إن لم يوجد فرع، ثم إضافة `branch_id` للمواعيد والجلسات والفواتير والمدفوعات وملؤها به، وربط كل الأعضاء بالفرع.
6. `0150_rls_rewrite.sql` — الدوال المساعدة الجديدة، وإسقاط السياسات المبنية على `app_role()` واستبدالها، ومراجعة كل الـ RPC/views/Edge Functions.
7. `0160_storage.sql` — bucket خاص، نقل الملفات إلى مسار `{organization_id}/…`، سياسات Storage، وتعبئة `stored_files`.
8. `0170_audit.sql` — أعمدة التدقيق الجديدة و triggers للعمليات الحساسة.

**بيانات البذر للتطوير/الاختبار:** عيادتان وهميتان (`demo-physio`، `demo-dental`) بفرعين لكل منهما ومستخدمين لكل دور، لاختبارات العزل المتبادل. **لا بيانات حقيقية في staging** إلا بعد إخفاء الهوية (BR-009). لا كلمات مرور في ملفات البذر.

**التحقق بعد الترحيل:** مطابقة أعداد السجلات لكل جدول قبل/بعد، وعدم وجود `organization_id IS NULL`، وكل `branch_id` يتبع نفس المؤسسة، وتقرير ترحيل محفوظ (AT-11).
