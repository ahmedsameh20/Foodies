// Pure helpers for international mobile numbers (no DOM): the dial-code list and the logic that turns what a person typed into the
// E.164 value the server validates ("+966500000000"). Used by phone-input.js and covered by tests/frontend.test.js.

// dial code, English name, Arabic name. Saudi Arabia first: the platform's home market (Asia/Riyadh).
export const COUNTRIES = [
  ['966', 'Saudi Arabia', 'السعودية'], ['971', 'United Arab Emirates', 'الإمارات'], ['965', 'Kuwait', 'الكويت'], ['974', 'Qatar', 'قطر'],
  ['973', 'Bahrain', 'البحرين'], ['968', 'Oman', 'عُمان'], ['967', 'Yemen', 'اليمن'], ['962', 'Jordan', 'الأردن'], ['961', 'Lebanon', 'لبنان'],
  ['963', 'Syria', 'سوريا'], ['964', 'Iraq', 'العراق'], ['970', 'Palestine', 'فلسطين'], ['20', 'Egypt', 'مصر'], ['249', 'Sudan', 'السودان'],
  ['218', 'Libya', 'ليبيا'], ['216', 'Tunisia', 'تونس'], ['213', 'Algeria', 'الجزائر'], ['212', 'Morocco', 'المغرب'], ['90', 'Türkiye', 'تركيا'],
  ['92', 'Pakistan', 'باكستان'], ['91', 'India', 'الهند'], ['880', 'Bangladesh', 'بنغلاديش'], ['63', 'Philippines', 'الفلبين'],
  ['44', 'United Kingdom', 'المملكة المتحدة'], ['1', 'United States / Canada', 'الولايات المتحدة / كندا'],
];
const BY_LENGTH = [...COUNTRIES].sort((a, b) => b[0].length - a[0].length);
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

export const asciiDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d]);

// "+966 50 000 0000" | "00966500000000" | "٠٥٠٠٠٠٠٠٠٠٠" -> { dial, national }
//   dial === null  : no country code was typed (a national number)
//   dial === ''    : a "+" number whose country is not in the list
export function splitPhone(value) {
  let v = asciiDigits(value).trim().replace(/[\s().-]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  if (!v.startsWith('+')) return { dial: null, national: v.replace(/\D/g, '') };
  const digits = v.slice(1).replace(/\D/g, '');
  const hit = BY_LENGTH.find(([dial]) => digits.startsWith(dial));
  return hit ? { dial: hit[0], national: digits.slice(hit[0].length) } : { dial: '', national: digits };
}

// The value submitted with the form. `dial` is the selected country; a complete international number typed in the box wins.
export function composePhone(dial, typed) {
  const parsed = splitPhone(typed);
  if (parsed.dial !== null) return `+${parsed.dial}${parsed.national}`;
  const national = parsed.national.replace(/^0+/, ''); // drop the local trunk prefix: 050... -> 50...
  if (!national) return '';
  return dial ? `+${dial}${national}` : `+${national}`;
}
