// English dictionary for src/clinical.jsx, src/dental.jsx and src/general.jsx
// (the patient file and the diagnosis per department, 0018) and the physio
// diagnosis form's new texts (src/screens2.jsx). Key: the Arabic text
// exactly as the code passes it to tt() / ttx(), placeholders included;
// value: the English text with the same placeholders.
Object.assign((window.I18N_EN = window.I18N_EN || {}), {
  // ── shared (src/clinical.jsx) ──
  "السجل السريري للطبيب والأخصائي والمدير فقط": "The clinical record is for doctors, therapists and admins only",
  "هذه الوحدة غير مفعّلة لعيادتك": "This module is not enabled for your clinic",
  "بعض البيانات غير صالحة — راجعها ثم احفظ": "Some data is not valid — check it and save again",
  "تعذّر تحميل السجل السريري": "Could not load the clinical record",
  "لا يمكنك حذف هذا السجل — يحذفه كاتبه أو الطبيب أو المدير": "You cannot delete this record — its author, a doctor or an admin can",
  "مخطط الجسم: {n} موضع ألم": "Body chart: {n} pain point(s)",
  "مخطط الجسم": "Body chart",
  "الفحص": "Examination",
  "ما تم اليوم": "Done today",
  "المتابعة": "Follow-up",
  "الجانب الأيسر": "Left side",
  "الخلف": "Back",
  "الأمام": "Front",
  "الجانب الأيمن": "Right side",
  // ── physio: the patient file's «التشخيص» tab and the form ──
  "مخطط الألم والتشخيص": "Pain chart and diagnosis",
  "المواضع التي حددها الأخصائي على مخطط الجسم عند التشخيص.": "The places the therapist marked on the body chart at the diagnosis.",
  "تشخيص جديد": "New diagnosis",
  "لا تشخيص محفوظ بعد": "No saved diagnosis yet",
  "سجّل أول تشخيص لهذا المريض وحدد مواضع الألم على مخطط الجسم.": "Record this patient's first diagnosis and mark the pain points on the body chart.",
  "التشخيصات السابقة": "Previous diagnoses",
  "تم حفظ التشخيص في ملف المريض": "Diagnosis saved to the patient file",
  "حفظ التعديلات": "Save changes",
  "حفظ التشخيص": "Save diagnosis",
  "مسودة محفوظة على هذا الجهاز فقط لهذا المريض — احفظها لنقلها إلى ملفه فيراها الطاقم كله.": "A draft for this patient is saved on this device only — save it to move it to the patient file, where the whole team can see it.",
  "بدأ النموذج من آخر تشخيص ({date}). الحفظ يضيف تشخيصًا جديدًا بتاريخ اليوم ويبقى السابق في ملف المريض.": "The form starts from the latest diagnosis ({date}). Saving adds a new diagnosis dated today; the earlier one stays in the patient file.",
});
