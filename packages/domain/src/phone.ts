/**
 * Phone numbers. Students type Nigerian numbers in many shapes:
 * 08012345678, 8012345678, 2348012345678, +234 801 234 5678, 0801-234-5678.
 * Everything is stored in E.164 (+2348012345678) so one person has one number.
 */

export class PhoneError extends Error {
  override readonly name = "PhoneError";
}

/** Nigerian mobile prefixes after the leading 0: 070x, 080x, 081x, 090x, 091x. */
const NG_MOBILE = /^[789][01]\d{8}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalises a phone number to E.164. Numbers without a country code are read as
 * Nigerian. International numbers must start with + (or 00).
 */
export function normalizePhone(input: string, defaultCountry: "NG" = "NG"): string {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 32) throw new PhoneError("enter a phone number");
  if (/[^\d\s+().-]/.test(raw)) throw new PhoneError("a phone number can only contain digits, spaces, +, - and brackets");
  let digits = raw.replace(/[\s().-]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (digits.indexOf("+") > 0 || (digits.match(/\+/g) ?? []).length > 1) throw new PhoneError("the + sign can only come first");

  if (digits.startsWith("+")) {
    if (digits.startsWith("+234")) return nigerian(digits.slice(4));
    if (!E164.test(digits)) throw new PhoneError("this does not look like a valid international number");
    return digits;
  }
  if (defaultCountry === "NG") {
    if (digits.startsWith("234") && digits.length === 13) return nigerian(digits.slice(3));
    if (digits.startsWith("0")) return nigerian(digits.slice(1));
    return nigerian(digits);
  }
  throw new PhoneError("include the country code, e.g. +234");
}

function nigerian(national: string): string {
  const n = national.startsWith("0") ? national.slice(1) : national;
  if (!NG_MOBILE.test(n)) throw new PhoneError("enter a Nigerian mobile number, e.g. 0801 234 5678");
  return `+234${n}`;
}

/** +2348012345678 → +234 801 234 5678 (display only). */
export function formatPhone(e164: string): string {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+234 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** +2348012345678 → +234 801 ••• 5678, for messages that must not reveal the whole number. */
export function maskPhone(e164: string): string {
  if (/^\+234\d{10}$/.test(e164)) return `+234 ${e164.slice(4, 7)} ••• ${e164.slice(-4)}`;
  return e164.length > 6 ? `${e164.slice(0, 3)} ••• ${e164.slice(-4)}` : "•••";
}
