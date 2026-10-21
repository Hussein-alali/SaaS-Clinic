# 8. النقل إلى hosting.com (cPanel) — Hosting Migration Plan

> **السؤال:** هل نقدر ننقل قاعدة البيانات وكل ما هو في Supabase إلى hosting.com (cPanel، مساحة 30GB) لنوفر التكلفة؟
> **الجواب المختصر:** نعم، يمكن، لكنه **ليس نقل قاعدة بيانات فقط**. Supabase يقدم أربع خدمات يعتمد عليها التطبيق مباشرة من المتصفح، وcPanel لا يقدم أيًّا منها جاهزًا. لذلك ننصح بالنقل على مرحلتين.

---

## ماذا يستخدم التطبيق من Supabase فعليًا

أرقام مستخرجة من الكود (`clinksys`):

| خدمة Supabase | الاستخدام في الكود | هل يوفرها cPanel؟ |
|---|---|---|
| **PostgreSQL** | 38 دالة، 62 سياسة RLS | ✅ نعم، PostgreSQL موجود في cPanel ([kb.hosting.com](https://kb.hosting.com/docs/managing-postgresql-databases)) |
| **REST API تلقائي** (PostgREST) | 47 استدعاء `.from()` و 24 استدعاء `.rpc()` من المتصفح | ❌ لا. المتصفح لا يستطيع الاتصال بـ PostgreSQL مباشرة، فيلزم خادم API |
| **Auth** (المستخدمون، كلمات المرور، JWT، رسائل إعادة التعيين) | 7 دوال `sb.auth.*`، و 42 استخدام لـ `auth.uid()` و 17 لـ `auth.users` في SQL | ❌ لا. يلزم بناء نظام دخول |
| **Storage** (ملفات المرضى مع صلاحيات) | 8 استدعاءات، و 10 سياسات تخزين | ⚠️ المساحة موجودة (30GB)، لكن التحقق من الصلاحيات يحتاج خادم API |
| **Edge Functions** | 3 دوال: `admin-create-user`، `admin-reset-password`، `admin-set-status` | ⚠️ تُعاد كتابتها في خادم Node.js |

**المعنى:** نقل قاعدة البيانات وحدها لا يكفي. يجب بناء خادم **Node.js API** على cPanel يحل محل PostgREST وAuth وStorage وEdge Functions، وإعادة كتابة طبقة البيانات في الواجهة (`src/supabase.jsx`، حوالي 129 KB).

## ما يقدمه hosting.com في cPanel

| الميزة | الحالة | المصدر |
|---|---|---|
| قواعد PostgreSQL وMySQL، مع phpPgAdmin واستيراد عبر `psql` | متاحة | [Managing PostgreSQL](https://kb.hosting.com/docs/managing-postgresql-databases)، [Import/Export](https://kb.hosting.com/docs/import-and-export-a-postgresql-database) |
| الاتصال بـ PostgreSQL من خارج السيرفر | فقط بطلب دعم فني (اسم القاعدة + المستخدم + IP)، وعبر SSH tunnel أو المنفذ 5432 | [Remote PostgreSQL](https://kb.hosting.com/docs/remote-postgresql-connections) |
| تطبيقات Node.js | عبر **Setup Node.js App** (Node.js Selector) | [Node.js Selector](https://kb.hosting.com/docs/create-application-with-nodejs-selector) |
| إصدارات Node.js على الاستضافة المشتركة | بين 6 و 20 حسب مراجعة خارجية، ولم أتحقق منها مباشرة | [Geekflare](https://geekflare.com/hosting/best-nodejs-hosting-platforms/) |
| SSH وGit والبريد (SMTP) وAutoSSL والنسخ الاحتياطي | متاحة في cPanel | — |

**لم أستطع التأكد منه — تحقق منه قبل البدء:**
1. **إصدار PostgreSQL:** يظهر في phpPgAdmin، أو بالأمر `psql --version` عبر SSH. المخطط يستخدم `gen_random_uuid()`، ويحتاج PostgreSQL 13 أو أحدث، أو إضافة `pgcrypto`.
2. **حدود الموارد للاستضافة المشتركة (CloudLinux LVE):** الرام والمعالج وعدد العمليات، وهل يتوقف تطبيق Node عند الخمول ثم يعود ببطء.
3. **شهادة SSL wildcard** لـ `*.clinicsyseg.com`، لأن الروابط الفرعية للعيادات تحتاجها ([TRD](02-TRD.md)).

---

## الخيارات

### الخيار A — الواجهة على hosting.com، وSupabase يبقى كما هو ✅ (موصى به الآن)

| | |
|---|---|
| **ما يتغير** | ملفات الواجهة فقط تُرفع إلى `public_html`. لا تغيير في قاعدة البيانات ولا في الكود |
| **الجهد** | ساعات |
| **التوفير** | تكلفة استضافة الواجهة (Railway/Vercel). Supabase يبقى على خطته الحالية |
| **فائدة إضافية** | يحل جزءًا من بطء التحميل، لأن Apache/LiteSpeed يضغط الملفات ويخزنها مؤقتًا ([07](07-Performance-Audit.md)) |
| **المخاطر** | شبه معدومة |

**الخطوات:**
1. بناء الواجهة مسبقًا (الخطوة 1 في [07-Performance-Audit.md](07-Performance-Audit.md))، فينتج مجلد `dist/` فيه `index.html` و `app.min.js` و `assets/`.
2. cPanel ← **Git Version Control** (أو File Manager) ← ارفع محتوى `dist/` فقط إلى `public_html`. **لا ترفع** `*.sql` ولا `DEPLOY.md` ولا `server.js`.
3. cPanel ← **SSL/TLS Status** ← فعّل AutoSSL لـ `clinicsyseg.com`.
4. ضع ملف `.htaccess` في `public_html`:
   ```apache
   # HTTPS إلزامي
   RewriteEngine On
   RewriteCond %{HTTPS} off
   RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]

   # منع ملفات حساسة إن رُفعت بالخطأ
   <FilesMatch "\.(sql|md|sh|log|env)$">
     Require all denied
   </FilesMatch>

   # ضغط
   <IfModule mod_deflate.c>
     AddOutputFilterByType DEFLATE text/html text/css application/javascript text/javascript application/json image/svg+xml
   </IfModule>

   # تخزين مؤقت: ملفات الكود ذات البصمة لسنة، و index.html دائمًا جديد
   <IfModule mod_headers.c>
     <FilesMatch "\.(js|css|woff2|png|jpe?g|svg|webp)$">
       Header set Cache-Control "public, max-age=31536000, immutable"
     </FilesMatch>
     <FilesMatch "index\.html$">
       Header set Cache-Control "no-cache"
     </FilesMatch>
   </IfModule>
   ```
   تخزين `.js` لسنة آمن فقط إذا تغيّر اسم الملف مع كل نشر، مثل `app.3f9a.js`. إن بقي الاسم `app.min.js` فاستخدم `max-age=300`.
5. Supabase Dashboard ← **Authentication → URL Configuration**: ضع `https://clinicsyseg.com` في *Site URL* و *Redirect URLs*، حتى تعمل روابط إعادة تعيين كلمة المرور والدعوات.
6. اختبر الدخول، والحجز، والدفع السريع، ورفع ملف مريض، وتصدير Excel.

### الخيار B — نقل كل شيء إلى hosting.com (PostgreSQL + Node.js API)

| | |
|---|---|
| **ما يتغير** | قاعدة البيانات، ونظام الدخول، والملفات، والدوال الإدارية، وطبقة البيانات في الواجهة |
| **الجهد** | أسابيع، وليس أيامًا |
| **التوفير** | اشتراك Supabase بالكامل |
| **ما تتحمله بنفسك** | النسخ الاحتياطي واختبار الاسترجاع، وتحديثات الأمان، ومراقبة الخادم، وأمان بيانات المرضى الصحية على استضافة مشتركة |
| **المخاطر** | حدود موارد الاستضافة المشتركة، وتوقف تطبيق Node عند الخمول، وإصدارات Node/PostgreSQL قديمة، وأخطاء صلاحيات عند نقل منطق RLS إلى الـ API |

**المعمارية بعد النقل:**
```
المتصفح (React) ──HTTPS──► Node.js API (cPanel: Setup Node.js App)
                              ├─ /auth/*      دخول، خروج، إعادة تعيين (bcrypt + JWT في cookie httpOnly)
                              ├─ /api/<table> بديل .from()  (47 استدعاء)
                              ├─ /api/rpc/*   بديل .rpc()   (24 استدعاء، الدوال SQL نفسها)
                              ├─ /files/*     رفع وتنزيل بصلاحيات، والملفات خارج public_html
                              └─ /admin/*     بديل Edge Functions الثلاث
                                     │
                                     ▼
                         PostgreSQL على cPanel (localhost)
```

**الخطوات:**
1. **تحقق مسبق:** إصدار PostgreSQL ≥ 13، وإصدار Node.js المتاح، وحدود الموارد. اسأل الدعم الفني لـ hosting.com عن الثلاثة.
2. **نسخة احتياطية كاملة من Supabase:**
   ```bash
   # سلسلة الاتصال من: Supabase Dashboard → Project Settings → Database
   pg_dump "$SUPABASE_DB_URL" --schema=public --no-owner --no-privileges -Fc -f public.dump
   pg_dump "$SUPABASE_DB_URL" --schema=auth --table=auth.users --data-only -Fc -f auth_users.dump
   ```
   كلمات المرور في `auth.users.encrypted_password` مخزنة بـ **bcrypt**. إذا استخدم الخادم الجديد bcrypt أيضًا، **يحتفظ المستخدمون بكلمات مرورهم** ولا يحتاجون إلى إعادة تعيين.
3. **الملفات:** نزّل bucket `patient-files` (عبر Supabase CLI أو API) وضعه في مجلد **خارج** `public_html`، مثل `/home/<user>/storage/patient-files/`.
4. **المخطط على cPanel:** cPanel ← **PostgreSQL Databases**: أنشئ القاعدة والمستخدم، ثم طبّق الـ migrations بعد:
   - استبدال `auth.uid()` بقيمة يضبطها الـ API لكل طلب. مثلًا `set_config('app.user_id', …, true)` داخل transaction، ودالة `app_uid()` تقرأها. بهذا **تبقى سياسات RLS الحالية تعمل** بدل نقل كل الصلاحيات إلى كود JavaScript.
   - استبدال المراجع لـ `auth.users` بجدول `app_users` (id، email، password_hash، status).
   - حذف سياسات `storage.objects` وتطبيق المنطق نفسه في `/files/*`.
5. **الـ API (Node.js/Express):** cPanel ← **Setup Node.js App** ← Production mode، وstartup file `app.js`. اتصل بـ PostgreSQL عبر `localhost`. الأسرار (كلمة مرور القاعدة ومفتاح JWT) في متغيرات البيئة من شاشة التطبيق نفسها، **وليس في Git**.
6. **الواجهة:** أعد كتابة `src/supabase.jsx` لتستدعي الـ API، مع الإبقاء على الأسماء نفسها (`KineticData.list/upsert/remove` وغيرها)، حتى لا تتغير الشاشات.
7. **البريد:** رسائل إعادة التعيين والدعوات عبر SMTP من cPanel (Email Accounts).
8. **النسخ الاحتياطي:** cPanel ← **Cron Jobs**: نفّذ `pg_dump` يوميًا إلى مكان **خارج** السيرفر نفسه، وجرّب الاسترجاع مرة واحدة على الأقل قبل الإطلاق.
9. **تشغيل متوازٍ:** انشر على `staging.clinicsyseg.com`، وطابق أعداد السجلات والملفات مع Supabase، ثم حوّل المستخدمين، واحتفظ بمشروع Supabase أسبوعين للرجوع إليه.

---

## التوصية

1. **الآن: الخيار A.** يوفر تكلفة استضافة الواجهة، ويحسن السرعة، ولا يحمل مخاطر على البيانات.
2. **الخيار B ليس مشروعًا منفصلًا.** ادمجه مع خطة تعدد العيادات ([05](05-Backend-Schema.md)، [06](06-Implementation-Plan.md)). تلك الخطة **تعيد كتابة RLS وطبقة البيانات أصلًا** (Milestone 2–3)، فإذا نُفذ النقل وحده الآن ستُكتب الأجزاء نفسها مرتين. القرار المطلوب منك: **هل الوجهة النهائية لقاعدة البيانات Supabase أم PostgreSQL على hosting.com؟** حدده قبل بدء Milestone 2، وسنحدّث TRD والخطة بناءً عليه.
3. **عن الـ 30GB:** تكفي بسهولة لقاعدة البيانات (عادة عشرات أو مئات الميغابايت لعيادة) وللملفات لفترة طويلة. المساحة ليست العائق. العائق هو الخدمات الأربع المذكورة أعلاه.
