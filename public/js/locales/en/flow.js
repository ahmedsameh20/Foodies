// Plans-first onboarding, branches after registration, per-customer discount limits and category pictures. Same keys as locales/ar/flow.js.
export default {
  // ---- plans page (first step of restaurant registration)
  'plans.title': 'Plans for restaurants | Foodies',
  'plans.heading': 'Choose a plan for your restaurant',
  'plans.intro': 'Compare the plans, pick the one that fits, then create your account. You can change plan later from your dashboard.',
  'plans.billingPeriod': 'Billing period',
  'plans.period.month': 'Monthly',
  'plans.period.year': 'Yearly',
  'plans.haveAccount': 'Already have an owner account?',
  'plans.limitBranches': 'Branches: {n}',
  'plans.select': 'Choose this plan',
  'plans.selected': 'Selected plan',
  'plans.none': 'No plans are available right now. Please try again later.',
  'register.selectedPlan': 'Selected plan:',
  'register.changePlan': 'Change plan',
  'login.planKept': 'Your selected plan ({plan}, {price}) is kept while you sign in.',

  // ---- onboarding steps
  'flow.stepPlan': 'Plan',
  'flow.stepConfirm': 'Confirm',
  'flow.choosePlanTitle': 'Choose your plan',
  'flow.choosePlanIntro': 'Pick the plan for your restaurant. Nothing is charged until you confirm and, for paid plans, complete the payment.',
  'flow.intro': 'This creates your public ordering page. Next you review everything, then our team reviews every new restaurant before it goes live.',
  'flow.branchesLater': 'You do not need to set up branches now. After you register, add them in Dashboard → Team & branches.',
  'flow.continueConfirm': 'Continue to review',
  'flow.yourPlan': 'Your plan',
  'flow.price': 'Price',
  'flow.planFree': 'This plan is free. Nothing is charged.',
  'flow.planTrial': 'This plan starts with a {n}-day free trial. Payment is requested when the trial ends.',
  'flow.planPay': 'This plan activates after your first payment of {price}. After the restaurant is created you go to the secure payment page.',
  'flow.planInvoice': 'This plan activates after your first payment of {price}. Online payment is not available yet: an invoice is created and the platform team activates the plan once payment is received.',
  'flow.branchesRow': 'Branches',
  'flow.branchesN': '{n} active branch(es)',
  'flow.branchesOptional': 'Optional: add your first branch whenever you are ready',
  'flow.manageBranches': 'Manage branches',
  'flow.addFirstBranch': 'Add your first branch',

  // ---- dashboard: no branches yet
  'flow.checklistTitle': 'Finish setting up',
  'flow.checklistIntro': 'Your restaurant works without branches. Add them when you want stock and delivery routing per location.',
  'flow.branchNeeds': 'A branch holds its own location and stock. You need at least one to track stock per branch and to send delivery orders to the nearest branch.',
  'flow.noBranchesTitle': 'No branches yet',
  'flow.noBranchesText': 'Add a branch to give each location its own address on the map and its own stock. Until then your restaurant keeps taking orders and stock is kept on the dishes.',

  // ---- category pictures
  'cat.image': 'Picture',
  'cat.imageNone': 'No picture chosen',
  'cat.imageAlt': 'Picture of the category {name}',
  'cat.imageHint': 'PNG, JPEG or WebP, up to 2 MB. Shown next to the category on your menu.',
  'cat.removeImage': 'Remove picture',

  // ---- discount limits
  'disc.limitsTitle': 'Usage limits',
  'disc.perCustomer': 'Maximum uses per customer',
  'disc.perCustomerHint': 'How many times the same customer may redeem this discount. Default: 1. Leave empty for no per-customer limit.',
  'disc.perCustomerShort': '{n} use(s) per customer',
  'disc.perCustomerNone': 'No per-customer limit',
  'err.discount_customer_limit': 'You have already used this offer the maximum number of times. Please review the prices and try again.',
};
