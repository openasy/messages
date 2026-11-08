// How an email, a phone number and a user id are written before they are compared. Two records are one person only
// when one of these is the same after this step; nothing is guessed, and nothing else is compared.

/** Countries whose numbers may be written without a country code: their calling code and whether a leading 0 is dropped. */
export const COUNTRIES = {
  TR: { code: "90", trunk: true },
  DE: { code: "49", trunk: true },
  AT: { code: "43", trunk: true },
  CH: { code: "41", trunk: true },
  NL: { code: "31", trunk: true },
  BE: { code: "32", trunk: true },
  FR: { code: "33", trunk: true },
  GB: { code: "44", trunk: true },
  IE: { code: "353", trunk: true },
  AZ: { code: "994", trunk: true },
  US: { code: "1", trunk: false },
} as const;
export type Country = keyof typeof COUNTRIES;

/** Trimmed and lowercased, or null when it is not an email address. */
export function normalEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && /^[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}$/.test(s) ? s : null;
}

/**
 * In E.164: +905551112233. A number with + or 00 keeps its country; one without is taken to be in `country`, so with TR
 * 0555 111 22 33, 555 111 22 33 and 905551112233 are all +905551112233, as Consent and İYS write them. Null when it is
 * not a phone number, such as a masked one.
 */
export function normalPhone(v: unknown, country: Country = "TR"): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/[\s().\-/]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;
  const { code, trunk } = COUNTRIES[country];
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  else if (trunk && s.startsWith("0")) s = code + s.slice(1);
  else if (country === "TR" && /^90\d{10}$/.test(s)) {
    // already has the country code without a plus
  } else if (country === "US" && /^1\d{10}$/.test(s)) {
    // the same
  } else s = code + s;
  if (country === "TR" && s.startsWith("90") && s.length !== 12) return null;
  return /^[1-9]\d{7,14}$/.test(s) ? `+${s}` : null;
}

/** Your application's own id for the person, as it sends it: 1 to 128 characters without spaces. */
export function normalUserId(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^[^\s]{1,128}$/.test(s) ? s : null;
}

/** Lowercased for comparisons that ignore case, with I, İ, ı and i all the same letter, so İzmir, IZMIR and izmir match. */
export const fold = (s: string) => s.normalize("NFC").toLocaleLowerCase("tr").replaceAll("ı", "i");
