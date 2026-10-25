# 8. النقل إلى hosting.com (cPanel) — Hosting Migration Plan

> **السؤال:** هل نقدر ننقل قاعدة البيانات وكل ما هو في Supabase إلى hosting.com (cPanel، مساحة 30GB) لنوفر التكلفة؟
> **القرار (21 أكتوبر 2026): الخيار B — نقل كل شيء إلى hosting.com.** العقد التنفيذي في [TRD](02-TRD.md) و [Schema](05-Backend-Schema.md) و [خطة التنفيذ](06-Implementation-Plan.md) (Milestones 2–3).
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
1. شغّل `npm install` ثم `npm run build` على جهازك، فينتج مجلد `dist/` فيه `index.html` و `app.<hash>.js` و `import.<hash>.js` و `assets/`.
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
   تخزين `.js` لسنة آمن لأن `npm run build` يضع بصمة المحتوى في اسم الملف (`app.<hash>.js`)، فيتغير الاسم مع كل تعديل.
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

## التشغيل على الخادم (Runbook) — الجاهزية للتوسع

> كل شيء داخل hosting.com (قرار المالك 25 أكتوبر 2026). الأوامر تُضاف في cPanel ← **Cron Jobs**، وتعمل من مجلد الإصدار الحالي.

### النسخ الاحتياطي (S1) ✅

| ماذا | الأمر | متى |
|---|---|---|
| نسخة كاملة (القاعدة + ملفات العيادات + manifest) | `cd ~/clinicsys/current && scripts/backup.sh >> ~/clinicsys-backups/backup.log 2>&1` | كل ليلة `15 2 * * *` |
| تجربة استرجاع (تطابق عدد صفوف كل جدول) | `cd ~/clinicsys/current && scripts/restore-check.sh >> ~/clinicsys-backups/restore-check.log 2>&1` | الأحد `0 4 * * 0` |

- **المكان:** `BACKUP_DIR` (الافتراضي `~/clinicsys-backups`) خارج `public_html` وخارج مجلد الملفات؛ السكربت يرفض غير ذلك (خروج 4).
- **الاحتفاظ:** آخر 7 نسخ يومية و 4 أسبوعية (نسخة الأحد أسبوعية): `BACKUP_KEEP_DAILY` و `BACKUP_KEEP_WEEKLY`.
- **المساحة:** لا تبدأ النسخة إن كانت ستُبقي أقل من `BACKUP_MIN_FREE_MB` (الافتراضي 1024) حرة (خروج 3) — ويصل تنبيه الموارد (S8).
- **الاتساق:** الـ dump وعدد صفوف كل جدول من لقطة واحدة (`db/backup-tools.js`)، بسياق النظام (`app.system = on`) لأن جداول العيادات FORCE RLS. الـ manifest فيه sha256 لكل ملف.
- **قاعدة الاسترجاع:** قاعدة ثانية فارغة تُنشأ مرة واحدة في cPanel (مثل `<account>_clinicsys_restore`) لنفس المستخدم، وعنوانها في `RESTORE_DATABASE_URL`. السكربت يرفض أن تكون هي القاعدة الحية.
- **استرجاع حقيقي بعد كارثة:** أوقف التطبيق (cPanel ← Setup Node.js App ← Stop)، ثم `pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" ~/clinicsys-backups/<stamp>/db.dump` مع `PGOPTIONS="-c app.system=on"`، وفك `files.tar.gz` داخل `FILES_DIR`، ثم شغّل التطبيق.
- **خطر معروف:** النسخ على نفس الخادم لا تحمي من فقدان الخادم نفسه. **نزّل النسخة الأسبوعية إلى جهازك** (File Manager أو SFTP) حتى يُعتمد مكان خارجي، وفعّل نسخ cPanel/JetBackup من hosting.com إن وُجد في الخطة.

### النشر والتراجع (S2) ✅

**الترتيب على الخادم** (`APP_HOME`، الافتراضي `~/clinicsys`):

| المسار | المحتوى |
|---|---|
| `releases/<stamp>-<id>/` | إصدار كامل: `api/` و `db/` و `dist/` و `scripts/` وملف `RELEASE` |
| `current` | رابط رمزي إلى الإصدار العامل. في cPanel ← Setup Node.js App: **Application root = `clinicsys/current/api`**، و Startup file = `app.js` |
| `shared/` | ما يبقى بين الإصدارات (مجلد ملفات العيادات `FILES_DIR`) |

**الخطوات:**

1. على جهازك (أو في CI): `scripts/package-release.sh` ← `release-<sha>.tar.gz` (البناء على جهازك، لأن esbuild أداة تطوير).
2. ارفع الملف إلى الخادم.
3. شغّل `DATABASE_URL=… PORT=… ~/clinicsys/current/scripts/deploy.sh release-<sha>.tar.gz` (في أول نشر يُشغّل من النسخة المفكوكة).
4. ما يحدث تلقائيًا: نسخة احتياطية للقاعدة ← فك الإصدار ← `npm ci --omit=dev` ← migrations ← تبديل `current` ← إعادة التشغيل (`tmp/restart.txt`) ← فحص `GET /api/health` لمدة 60 ثانية.
5. إن لم يصح الإصدار الجديد: يعود `current` تلقائيًا إلى الإصدار السابق (خروج 2)، ويُعلَّم الإصدار الفاشل بملف `.failed`.

**التراجع اليدوي:** `scripts/rollback.sh` يعود إلى أحدث إصدار سابق سليم، و `scripts/rollback.sh <release>` إلى إصدار بعينه. يُحتفظ بآخر 5 إصدارات.

**البيئة على الخادم:** ملف `~/clinicsys/shared/env` (صلاحية 600، خارج Git) فيه `export NODE_ENV=production DATABASE_URL=… FILES_DIR=… BACKUP_DIR=… PORT=…`، و `. ~/clinicsys/shared/env` قبل `deploy.sh` و `rollback.sh` وأي `node db/migrate.js` يدوي. `deploy.sh` يشغّل الـ migrations بـ `NODE_ENV=production` إن لم يُضبط.

### القاعدة الحية أثناء الـ migrations (S3) ✅

- **لا انتظار طويل:** كل ملف ينتظر القفل 5 ث على الأكثر (`MIGRATE_LOCK_TIMEOUT`) ويعمل 15 دقيقة على الأكثر (`MIGRATE_STATEMENT_TIMEOUT`). عند التجاوز (SQLSTATE `55P03` أو `57014`) يُلغى الملف كاملًا ويقف النشر قبل التبديل (خروج 1، الإصدار الحالي يعمل)؛ أعد المحاولة في وقت أهدأ.
- **نسخة قبل كل migration:** مع `NODE_ENV=production` يرفض `migrate.js` ملفات معلقة بلا نسخة أحدث من ساعتين في `BACKUP_DIR` (خروج 5): شغّل `scripts/backup.sh --db-only` أولًا. `deploy.sh` يأخذها تلقائيًا (من الإصدار العامل، وفي أول نشر من الإصدار الجديد). `--no-backup-check` للحالات المقصودة فقط.
- **expand/contract:** من `0010` يرفض `migrate.js` الحذف وإعادة التسمية وتغيير النوع و `set not null` إلا بسطر `-- contract: <السبب>` قبلها ([05](05-Backend-Schema.md) «Migration and seed data»).

**القاعدة لا تُرجع تلقائيًا أبدًا:** كل migration يُبقي الإصدار السابق عاملًا (expand/contract، المهمة S3). إن أفسد migration البيانات: استرجع النسخة التي أخذها `deploy.sh` قبل النشر (أحدث مجلد في `BACKUP_DIR`) كما في «استرجاع حقيقي بعد كارثة» أعلاه، ثم `rollback.sh`.
