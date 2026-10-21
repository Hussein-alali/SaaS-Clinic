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
| قاعدة البيانات | عيادة واحدة: `clinic_settings` بسجل وحيد `id = 1`، ودور المستخدم من `staff.role` عبر `app_role()`، ولا يوجد `organization_id` |
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
| Hosting | خادم Node (`server.js`) على Railway، أو استضافة ثابتة (Vercel/Hosting.com) |
| Domains | `clinicsyseg.com` (الموقع الرئيسي والدخول) + `*.clinicsyseg.com` (العيادات) + `admin.clinicsyseg.com` (لوحة Super Admin؛ slug محجوز) |
| حل العيادة | الواجهة تقرأ الـ subdomain من `window.location.hostname` → تستدعي `resolve_organization(slug)` → تحصل على `organization_id` والحالة والتخصص والميزات العامة فقط |
| Routing | تطبيق واحد لكل النطاقات؛ لا نسخة لكل عيادة ولا لكل تخصص |

## Backend and database

| البند | القرار |
|---|---|
| Database | Supabase PostgreSQL (المشروع الحالي)، المنطقة الأقرب لمصر المتاحة في Supabase (مثل `eu-central-1`) — **تأكيد مطلوب** |
| Data access | `supabase-js` من المتصفح مباشرة، محمي بالكامل بسياسات RLS |
| العمليات المميزة | Supabase **Edge Functions** (Deno) بمفتاح `service_role` على الخادم فقط: إنشاء عيادة، دعوة مستخدم، إيقاف عيادة/عضوية، تغيير الخطة |
| منطق الأعمال الحساس | دوال Postgres `security definer` مع `search_path` ثابت (النمط المستخدم حاليًا في `app_role()` و `record_quick_payment`) |
| Migrations | ملفات SQL مرقمة تحت `supabase/migrations/` (Supabase CLI)؛ `Supabase_All_In_One.sql` يُعاد توليده منها ولا يُعدل يدويًا |
| Backend Express | **غير مطلوب.** لا يُنشأ إلا إذا ظهرت عملية لا تناسب Edge Functions |

## Authentication and roles

- **Supabase Auth** بالبريد وكلمة المرور؛ لا تُخزن كلمات مرور في جداول التطبيق.
- **التفعيل بالدعوة فقط:** `auth.admin.inviteUserByEmail` من Edge Function، مع رابط يعيد المستخدم إلى `clinicsyseg.com/accept-invite`.
- **الدور ليس في JWT `user_metadata`** (قابل للتعديل من المستخدم). يُستخرج من قاعدة البيانات في كل طلب:
  - `platform_admins` → Super Admin.
  - `organization_members(organization_id, user_id, role, status)` → دور المستخدم في كل عيادة.
  - `member_branches` → الفروع المسموح بها للعضو (فارغ = كل الفروع لدور `clinic_admin`).
- **الأدوار داخل العيادة:** `clinic_admin`، `receptionist`، `doctor`، `therapist`، `staff`.
- **سياق العيادة:** يرسله العميل كـ `organization_id` لكن **لا يُوثق به**؛ كل سياسة RLS تتحقق من وجود عضوية نشطة للمستخدم في تلك المؤسسة وأن المؤسسة نشطة (BR-008).
- **دعوة الموظفين:** Super Admin لأي عيادة؛ Clinic Admin لعيادته فقط، وبأدوار أقل من أو تساوي `clinic_admin`، وضمن حد المستخدمين في الخطة.
- **الجلسات:** JWT من Supabase بمدة صلاحية افتراضية ساعة مع refresh token؛ إيقاف العضوية يسري فورًا لأن RLS يتحقق من الحالة في كل طلب.

## External services and APIs

| المزود | الغرض | الحدود | مالك بيانات الاعتماد |
|---|---|---|---|
| Supabase | DB, Auth, Storage, Edge Functions | حدود الخطة المختارة (اتصالات، تخزين، رسائل البريد) | مالك المنصة |
| SMTP مخصص (مثل Resend/SES) | رسائل الدعوة وإعادة تعيين كلمة المرور | خدمة البريد المدمجة في Supabase محدودة بعدد قليل من الرسائل في الساعة ولا تصلح للإنتاج | مالك المنصة |
| مزود DNS + TLS | Wildcard DNS `*.clinicsyseg.com` وشهادة wildcard | — | مالك المنصة |
| WhatsApp (روابط `wa.me` حاليًا) | تذكير المواعيد | يدوي من المستخدم | — |
| CDN (unpkg/jsdelivr) | مكتبات الواجهة | يُلغى عند الانتقال إلى Vite | — |

## Architecture

```
 المتصفح (React SPA, RTL)
   │  hostname → slug
   ├── clinicsyseg.com ............ الموقع الرئيسي + الدخول + اختيار العيادة
   ├── {slug}.clinicsyseg.com ..... مساحة العيادة
   └── admin.clinicsyseg.com ...... لوحة Super Admin
          │
          │ supabase-js (anon key + JWT المستخدم)
          ▼
 ┌──────────────────────────── Supabase ─────────────────────────────┐
 │ Auth ── JWT ──► PostgREST ──► PostgreSQL + RLS                    │
 │                                 │  is_super_admin()               │
 │                                 │  is_org_member(org)             │
 │                                 │  has_org_role(org, roles[])     │
 │                                 │  can_access_branch(org, branch) │
 │                                 │  org_module_enabled(org, code)  │
 │ Edge Functions (service_role) ──► create-organization,            │
 │                                   invite-member, set-org-status,  │
 │                                   set-member-status, set-plan     │
 │ Storage: bucket خاص patient-files، المسار {org_id}/{patient_id}/…  │
 └───────────────────────────────────────────────────────────────────┘
```

**تدفق الطلب:** المستخدم يدخل → JWT → الواجهة تحدد المؤسسة من الـ slug → كل استعلام يحمل `organization_id` → RLS يتحقق من العضوية النشطة وحالة المؤسسة والدور والفرع والوحدة المفعلة → النتيجة.

## Security and privacy

| المتطلب | التطبيق |
|---|---|
| عزل المستأجرين (NFR-001) | `organization_id NOT NULL` على كل جدول تابع لعيادة + RLS على كل جدول + اختبارات سلبية آلية |
| الأسرار (NFR-004) | لا `service_role` ولا أسرار في ملفات React أو Git؛ فحص سجل Git وتدوير أي سر مكشوف؛ حذف كلمة مرور المدير من `DEPLOY.md` و `seed-admin.sql` |
| التخزين (NFR-005) | bucket خاص؛ سياسات Storage تتحقق من أن أول جزء من المسار هو مؤسسة المستخدم؛ روابط موقعة قصيرة العمر (≤ 10 دقائق) |
| النقل (NFR-006) | HTTPS إلزامي على النطاق الرئيسي وكل الروابط الفرعية؛ HSTS |
| التدقيق (NFR-007) | `audit_events` لإنشاء/إيقاف العيادات، تغيير التخصص والميزات والخطة، الدعوات، تغيير الأدوار والعضويات |
| الخصوصية (NFR-012) | لا بيانات صحية في سجلات الأخطاء أو أدوات التحليل؛ صلاحيات التصدير مقيدة |
| الاحتفاظ | بيانات العيادة الموقوفة تبقى 6 أشهر (`organizations.retention_until`)؛ ما بعدها قرار مفتوح — **لا حذف آلي حتى يُعتمد** |
| الخادم الثابت | `server.js` يخدم فقط `index.html` والأصول المبنية، وليس `*.sql` أو `*.md` |

## Performance and reliability targets

- القوائم الشائعة تستجيب خلال **2.5 ثانية** في ظروف الشبكة المستهدفة (NFR-009)؛ فهارس على `organization_id` و `(organization_id, branch_id)` و `(organization_id, date)`.
- استدعاءات دوال RLS المساعدة تكون `stable` وتُستدعى بنمط `(select fn())` لتجنب التنفيذ لكل صف.
- النسخ الاحتياطي: النسخ اليومية في Supabase + PITR إن أمكن؛ **اختبار استرجاع فعلي قبل الترحيل** (NFR-008).
- RPO/RTO وهدف التوفر تُحدد مع مزود الاستضافة قبل الإطلاق (NFR-013) — مقترح: RPO ≤ 24 ساعة، RTO ≤ 4 ساعات.

## Environments and delivery

| البيئة | النطاق | قاعدة البيانات | الغرض |
|---|---|---|---|
| Development | `localhost:3000` و `*.localhost` | مشروع Supabase للتطوير أو `supabase start` محليًا | تطوير |
| Staging | `*.staging.clinicsyseg.com` | مشروع Supabase منفصل ببيانات وهمية أو مجهولة الهوية (BR-009) | اختبارات العزل والترحيل والقبول |
| Production | `clinicsyseg.com`, `*.clinicsyseg.com` | مشروع Supabase الإنتاجي | العملاء |

- **CI (GitHub Actions):** lint + build + اختبارات الوحدة + **اختبارات RLS السلبية** على قاعدة Postgres مؤقتة (`supabase start` أو pgTAP) لكل PR.
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
| Edge Functions بدل Backend Express | موجودة في Supabase ولا تحتاج خادمًا إضافيًا | Express على Railway |
