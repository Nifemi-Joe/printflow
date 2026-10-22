import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * How far a print shop's identity has been proven, and what follows from it.
 *
 * A registered business is inspected by the university before it trades. A student with
 * a printer in their room is a peer: cheap and quick to onboard, but the student sending
 * their coursework has no shopfront to judge. So the product proves what it can, says
 * plainly what it could not prove, and limits the exposure in between.
 */

export const PROVIDER_KINDS = ["BUSINESS", "STUDENT_RUN"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Ordered weakest to strongest. A shop's level is derived from its passed checks. */
export const VERIFICATION_LEVELS = ["UNVERIFIED", "EMAIL_VERIFIED", "MATRIC_VERIFIED", "UNIVERSITY_APPROVED"] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const VERIFICATION_CHECKS = ["STUDENT_EMAIL", "MATRIC_NUMBER", "UNIVERSITY_REVIEW"] as const;
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];

export const CHECK_STATUSES = ["PENDING", "PASSED", "FAILED", "EXPIRED", "REVOKED"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Which check grants which level, when it passes. */
export const CHECK_GRANTS: Record<VerificationCheck, VerificationLevel> = {
  STUDENT_EMAIL: "EMAIL_VERIFIED",
  MATRIC_NUMBER: "MATRIC_VERIFIED",
  UNIVERSITY_REVIEW: "UNIVERSITY_APPROVED",
};

export function levelRank(level: VerificationLevel): number {
  return VERIFICATION_LEVELS.indexOf(level);
}

export function atLeast(level: VerificationLevel, floor: VerificationLevel): boolean {
  return levelRank(level) >= levelRank(floor);
}

/** The level at and above which a student-run shop trades without extra limits. */
export const TRUSTED_FROM: VerificationLevel = "MATRIC_VERIFIED";

export interface TrustBadge {
  /** Shown on the badge itself. Short enough for a chip next to a shop name. */
  label: string;
  /** One sentence a student can act on, in plain words. */
  detail: string;
  /** How prominent the badge should be. */
  tone: "good" | "caution" | "warn";
}

/**
 * What a student is told about who is behind a shop. Business shops are described by
 * their inspection; student-run shops by exactly what was proven about the person.
 */
export function trustBadge(kind: ProviderKind, level: VerificationLevel): TrustBadge {
  if (kind === "BUSINESS") {
    return atLeast(level, "UNIVERSITY_APPROVED")
      ? { label: "Approved print shop", detail: "A registered print shop the university has checked.", tone: "good" }
      : { label: "Not checked yet", detail: "The university has not finished checking this shop.", tone: "warn" };
  }
  switch (level) {
    case "UNIVERSITY_APPROVED":
      return { label: "Student, university approved", detail: "A student who prints for others. The university has met them and checked their ID.", tone: "good" };
    case "MATRIC_VERIFIED":
      return { label: "Verified student", detail: "A student who prints for others. Their matric number has been confirmed with the university.", tone: "good" };
    case "EMAIL_VERIFIED":
      return {
        label: "Student email only",
        detail: "A student who prints for others. They confirmed a university email address, but their matric number has not been checked yet.",
        tone: "caution",
      };
    default:
      return {
        label: "Not verified",
        detail: "A student who prints for others. Nothing about who they are has been confirmed yet. Avoid sending anything private.",
        tone: "warn",
      };
  }
}

export interface ProviderLimits {
  /** Students must be shown the risk and agree before ordering. */
  needsAcknowledgement: boolean;
  /** Largest order this shop may take, or null for no limit. */
  orderCapKobo: number | null;
  /** Whether the shop is offered without the student asking to see unverified shops. */
  listedByDefault: boolean;
}

/**
 * The limits that go with a level. One cap, one question: a student-run shop carries
 * extra limits until its matric number is confirmed, and none afterwards.
 */
export function providerLimits(kind: ProviderKind, level: VerificationLevel, capKobo: number): ProviderLimits {
  if (kind !== "STUDENT_RUN" || atLeast(level, TRUSTED_FROM)) {
    return { needsAcknowledgement: false, orderCapKobo: null, listedByDefault: true };
  }
  return { needsAcknowledgement: true, orderCapKobo: capKobo, listedByDefault: level === "EMAIL_VERIFIED" };
}

// ---------------------------------------------------------------- student email

/** Whether an address belongs to one of a university's student-mail domains. */
export function emailOnDomain(email: string, domains: readonly string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const domain = email.slice(at + 1).toLowerCase().replace(/\.$/, "");
  // A subdomain of an allowed domain counts (mail.unilag.edu.ng under unilag.edu.ng),
  // but a lookalike that merely ends with it does not (evil-unilag.edu.ng).
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// ---------------------------------------------------------------- matric numbers

/** Upper-cased, with spaces and surrounding punctuation removed. Slashes are kept. */
export function normaliseMatric(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "").replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, "");
}

export class MatricError extends Error {
  override readonly name = "MatricError";
  constructor(
    message: string,
    readonly code: "MATRIC_FORMAT" | "MATRIC_PATTERN_INVALID",
  ) {
    super(message);
  }
}

/**
 * Checks a matric number against the university's own format. The pattern is set by the
 * university, so it is validated before use and anchored, and a pattern that could run
 * away on a long input is rejected rather than trusted.
 */
export function checkMatricFormat(raw: string, pattern: string | null): string {
  const matric = normaliseMatric(raw);
  if (matric.length < 3 || matric.length > 40) throw new MatricError("a matric number is between 3 and 40 characters", "MATRIC_FORMAT");
  if (!pattern) return matric;
  let re: RegExp;
  try {
    re = new RegExp(pattern.startsWith("^") ? pattern : `^(?:${pattern})$`, "u");
  } catch {
    throw new MatricError("this university's matric number format is not a valid pattern", "MATRIC_PATTERN_INVALID");
  }
  if (!re.test(matric)) throw new MatricError("that does not look like a matric number at this university", "MATRIC_FORMAT");
  return matric;
}

/**
 * Surnames are compared as a keyed hash, so a university can upload its roll for
 * automatic matching without PrintFlow holding a copy of the student register.
 */
export function normaliseSurname(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function surnameHash(pepper: string, surname: string): string {
  return createHmac("sha256", pepper).update(`surname:${normaliseSurname(surname)}`).digest("hex");
}

export function surnameMatches(pepper: string, surname: string, hash: string): boolean {
  const a = Buffer.from(surnameHash(pepper, surname), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The surname of a full name as written in Nigeria, where either part may come first. */
export function surnameCandidates(fullName: string): string[] {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const first = normaliseSurname(parts[0]!);
  const last = normaliseSurname(parts[parts.length - 1]!);
  return [...new Set([last, first])].filter((s) => s.length >= 2);
}

// ---------------------------------------------------------------- undertaking

/**
 * What a student-run provider agrees to before any document reaches them. Raising the
 * version re-asks everyone; the exact wording accepted is recorded as a hash, so a later
 * edit cannot be passed off as what somebody signed.
 */
export const UNDERTAKING_VERSION = 1;

export const UNDERTAKING_TEXT = [
  "I am printing other students' documents, and I will treat them as private.",
  "",
  "1. I print the document, hand it over, and delete every copy from my devices.",
  "2. I do not read, keep, copy, photograph, forward or sell anyone's document.",
  "3. I do not print anything for myself from a document sent to me.",
  "4. I hand an order over only to the person with the pickup code.",
  "5. I keep my PrintFlow account to myself and never let anyone else use it.",
  "6. If a document is exposed, lost or printed wrongly, I report it in the app the same day.",
  "7. I understand my university can stop my shop at any time, and that breaking this",
  "   undertaking may be a disciplinary matter for them, not only for PrintFlow.",
].join("\n");

export function undertakingSha256(text: string = UNDERTAKING_TEXT): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
