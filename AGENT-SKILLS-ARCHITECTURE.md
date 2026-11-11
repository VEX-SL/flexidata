# خطة تنفيذ نظام الـ Agent Skills في مشروع FlexiData AI — الإصدار الثاني (المُطوّر)

توضح هذه الوثيقة الخطة الشاملة والهندسة المعمارية المُحدّثة لإنشاء ونظام إدارة الـ **Agent Skills** داخل مشروع **FlexiData AI**. تم تصميم هذا النظام بناءً على أفضل ممارسات هندسة الوكلاء الذكاء الاصطناعي ليكون آمناً، قابلاً للتوسع، ذا كفاءة عالية في استهلاك الـ Tokens، وقابلاً للمراقبة والتحسين المستمر.

---

## 1. نظرة عامة على الهندسة المعمارية (Architecture)

يتكون نظام الـ Skills من أربع طبقات أساسية:

1. **طبقة التخزين (Database Layer - Supabase):** جداول مخصصة لحفظ الـ Skills، الموارد المرتبطة بها، وسجلات الاستخدام، مدعومة بسياسات الأمان على مستوى الصف (RLS) وفهارس (Indexes) مُحسّنة.
2. **طبقة الخدمة والمنطق (Service Layer - TypeScript):** مدير الـ Skills الذي يدير عمليات الاكتشاف، البحث، التحميل الكسول (Lazy Loading)، التخزين المؤقت (Caching)، وحقن السياق.
3. **طبقة التفاعل والـ Agent (Execution & Runtime Layer):** الأدوات المخصصة التي تسمح للـ Agent باكتشاف واستدعاء الـ Skills المتاحة بناءً على حاجة المستخدم الفعلية.
4. **طبقة المراقبة والإدارة (Observability & Admin Layer):** تتبع أداء واستخدام الـ Skills لتوفير مؤشرات دقيقة وجودة تشغيل عالية.

### مبدأ التصميم الأساسي: فصل الاكتشاف عن التحميل (Discovery vs. Loading)
- **اكتشاف (Discover):** يستعرض الـ Agent الأسماء، الأوصاف، والتصنيفات فقط (بتكلفة رمزية من الـ Tokens) ليحدد الـ Skill الملائمة.
- **تحميل (Load):** يتم فقط بعد اختيار الـ Skill المطلوبة، حيث يُجلب محتواها الكامل ومواردها المرفقة.

هذا الفصل يمنع تشويش سياق الـ Agent ويقلل التكاليف التشغيلية بشكل جذري.

---

## 2. هيكل قاعدة البيانات (Supabase Schema)

### أ. جدول `agent_skills`
يخزن البيانات الأساسية لكل Skill مع حقول الدعم المتقدمة:
- `id` (UUID / Primary Key)
- `name` (TEXT UNIQUE): اسم فريد بالصيغة `snake_case`.
- `display_name` (TEXT): الاسم المعروض للمستخدم أو الواجهة.
- `description` (TEXT): وصف تفصيلي لما تفعله الـ Skill ومتى تُستخدم (يُستخدم للبحث الدلالي أو النصي).
- `version` (TEXT): رقم الإصدار (مثل `1.0.0`) لدعم التحديثات والرجوع عند الحاجة.
- `category` (TEXT): تصنيف عام للـ Skill (مثل `data-analysis`, `file-export`).
- `tags` (TEXT[]): كلمات مفتاحية للتصفية السريعة.
- `priority` (INTEGER): أولوية العرض والاقتراح.
- `is_active` (BOOLEAN): مفتاح لتفعيل أو تعطيل الـ Skill دون حذفها.
- `required_tools` (TEXT[]): الأدوات البرمجية المطلوبة لتشغيل الـ Skill.
- `metadata` (JSONB): إعدادات إضافية مرنة.
- `created_at` / `updated_at` (TIMESTAMPTZ)

### ب. جدول `skill_resources`
يخزن الملفات أو الموارد التابعة لكل Skill (مثل إرشادات التشغيل أو القوالب):
- `id` (UUID / Primary Key)
- `skill_id` (UUID / Foreign Key → `agent_skills.id` مع `ON DELETE CASCADE`)
- `filename` (TEXT): اسم الملف (مثل `guidelines.md` أو `examples.json`).
- `content` (TEXT): المحتوى النصي للموارد ذات الحجم الصغير/المتوسط.
- `storage_path` (TEXT): مسار التخزين في Supabase Storage للملفات الكبيرة.
- `content_type` (TEXT): نوع المحتوى (مثل `text/markdown`, `application/json`).
- `is_primary` (BOOLEAN): لتحديد الملف الرئيسي للـ Skill.
- `sort_order` (INTEGER): ترتيب قراءة الملفات.
- `created_at` (TIMESTAMPTZ)

### ج. جدول `skill_usage_logs`
سجل استدعاءات الـ Skills لمراقبة الأداء والاستهلاك:
- `id` (UUID / Primary Key)
- `skill_id` (UUID / Foreign Key → `agent_skills.id`)
- `conversation_id` (TEXT): ربط الاستخدام بسياق المحادثة.
- `tokens_used` (INTEGER): عدد الرموز المستهلكة.
- `latency_ms` (INTEGER): زمن الاستجابة والتحميل.
- `success` (BOOLEAN): حالة نجاح التنفيذ.
- `error_message` (TEXT): رسالة الخطأ إن وجدت.
- `created_at` (TIMESTAMPTZ)

---

## 3. طبقة الخدمات والأكواد (TypeScript Services)

يتم تنظيم الأكواد داخل مسار `src/lib/skills/` كالتالي:
1. **`types.ts`:** تعريف الأنواع والواجهات البرمجية (Interfaces).
2. **`registry.ts`:** إدارة وجلب الـ Skills المتاحة وتصفيتها بناءً على المعايير المختلفة مع دعم التخزين المؤقت (Caching).
3. **`loader.ts`:** التحميل الكسول (Lazy Loading) للموارد المرتبطة، وحقن السياق في رسائل الـ Agent.
4. **`matcher.ts`:** مطابقة طلبات المستخدم مع أوصاف الـ Skills.

---

## 4. سياسات الأمان والحماية (Security & RLS)

- **Row Level Security (RLS):** مفعّلة بالكامل على جداول الـ Skills والموارد بحيث يُسمح بالقراءة العامة للـ Skills النشطة فقط.
- **Admin Privileges:** عمليات الإضافة، التعديل، والحذف تتم حصرياً عبر Service Role بالتحقق من صلاحيات المشرفين.
- **Sanitization:** مراجعة محتويات الـ Skills لمنع أي ثغرات حقن أوامر (Prompt Injection).

---

## 5. خطة التنفيذ المرحلية

1. **المرحلة الأولى:** تنفيذ مخطط قاعدة البيانات (SQL Migration) وتجهيز الأنواع والخدمات الأساسية (`registry.ts` و `loader.ts`).
2. **المرحلة الثانية:** بناء أدوات الـ Agent (`list_skills` و `load_skill`) وربطها بالبيئة التشغيلية.
3. **المرحلة الثالثة:** إضافة آليات التخزين المؤقت (Caching) وتسجيل الاستخدام (`skill_usage_logs`).
4. **المرحلة الرابعة:** إطلاق واجهة الإدارة والمتابعة لوكلاء الذكاء الاصطناعي.
