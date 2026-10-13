// Plans-first onboarding, branches after registration, per-customer discount limits and category pictures. Same keys as locales/en/flow.js.
export default {
  // ---- plans page (first step of restaurant registration)
  'plans.title': 'باقات المطاعم | Foodies',
  'plans.heading': 'اختر باقة لمطعمك',
  'plans.intro': 'قارن بين الباقات، واختر الأنسب لك، ثم أنشئ حسابك. يمكنك تغيير الباقة لاحقًا من لوحة التحكم.',
  'plans.billingPeriod': 'فترة الفوترة',
  'plans.period.month': 'شهريًا',
  'plans.period.year': 'سنويًا',
  'plans.haveAccount': 'لديك حساب مالك مطعم بالفعل؟',
  'plans.limitBranches': 'عدد الفروع: {n}',
  'plans.select': 'اختر هذه الباقة',
  'plans.selected': 'الباقة المختارة',
  'plans.none': 'لا توجد باقات متاحة حاليًا. حاول مرة أخرى لاحقًا.',
  'register.selectedPlan': 'الباقة المختارة:',
  'register.changePlan': 'تغيير الباقة',
  'login.planKept': 'باقتك المختارة ({plan}، {price}) محفوظة أثناء تسجيل الدخول.',

  // ---- onboarding steps
  'flow.stepPlan': 'الباقة',
  'flow.stepConfirm': 'التأكيد',
  'flow.choosePlanTitle': 'اختر باقتك',
  'flow.choosePlanIntro': 'اختر الباقة المناسبة لمطعمك. لن يتم خصم أي مبلغ قبل تأكيدك، وفي الباقات المدفوعة قبل إتمام الدفع.',
  'flow.intro': 'سننشئ بهذا صفحة الطلب العامة لمطعمك. بعد ذلك تراجع كل شيء، ثم يراجع فريقنا كل مطعم جديد قبل ظهوره للعملاء.',
  'flow.branchesLater': 'لا تحتاج إلى إعداد الفروع الآن. بعد التسجيل أضفها من لوحة التحكم ← الفريق والفروع.',
  'flow.continueConfirm': 'المتابعة إلى المراجعة',
  'flow.yourPlan': 'باقتك',
  'flow.price': 'السعر',
  'flow.planFree': 'هذه الباقة مجانية. لن يتم خصم أي مبلغ.',
  'flow.planTrial': 'تبدأ هذه الباقة بفترة تجريبية مجانية مدتها {n} يومًا، ويُطلب الدفع عند انتهائها.',
  'flow.planPay': 'تُفعَّل هذه الباقة بعد أول دفعة بقيمة {price}. بعد إنشاء المطعم ستنتقل إلى صفحة الدفع الآمنة.',
  'flow.planInvoice': 'تُفعَّل هذه الباقة بعد أول دفعة بقيمة {price}. الدفع الإلكتروني غير متاح بعد: سيتم إنشاء فاتورة، ويفعّل فريق المنصة الباقة بعد استلام الدفعة.',
  'flow.branchesRow': 'الفروع',
  'flow.branchesN': '{n} فرع نشط',
  'flow.branchesOptional': 'اختياري: أضف أول فرع لك متى كنت جاهزًا',
  'flow.manageBranches': 'إدارة الفروع',
  'flow.addFirstBranch': 'أضف أول فرع',

  // ---- dashboard: no branches yet
  'flow.checklistTitle': 'أكمل الإعداد',
  'flow.checklistIntro': 'يعمل مطعمك بدون فروع. أضفها عندما تريد مخزونًا وتوجيهًا للتوصيل لكل موقع.',
  'flow.branchNeeds': 'لكل فرع موقعه ومخزونه الخاص. تحتاج إلى فرع واحد على الأقل لتتبّع المخزون لكل فرع ولتوجيه طلبات التوصيل إلى أقرب فرع.',
  'flow.noBranchesTitle': 'لا توجد فروع بعد',
  'flow.noBranchesText': 'أضف فرعًا ليكون لكل موقع عنوانه على الخريطة ومخزونه الخاص. حتى ذلك الحين يواصل مطعمك استقبال الطلبات ويُحفظ المخزون على الأطباق.',

  // ---- category pictures
  'cat.image': 'الصورة',
  'cat.imageNone': 'لم تُختر صورة',
  'cat.imageAlt': 'صورة التصنيف {name}',
  'cat.imageHint': 'PNG أو JPEG أو WebP، بحد أقصى 2 ميغابايت. تظهر بجانب التصنيف في قائمتك.',
  'cat.removeImage': 'إزالة الصورة',

  // ---- discount limits
  'disc.limitsTitle': 'حدود الاستخدام',
  'disc.perCustomer': 'الحد الأقصى للاستخدام لكل عميل',
  'disc.perCustomerHint': 'كم مرة يمكن للعميل نفسه استخدام هذا الخصم. الافتراضي: 1. اتركه فارغًا لعدم وضع حد لكل عميل.',
  'disc.perCustomerShort': '{n} استخدام لكل عميل',
  'disc.perCustomerNone': 'بلا حد لكل عميل',
  'err.discount_customer_limit': 'لقد استخدمت هذا العرض بالحد الأقصى المسموح. راجع الأسعار وحاول مرة أخرى.',
};
