"use client";

import { useState } from "react";

const CONTACT = process.env.NEXT_PUBLIC_ONBOARDING_EMAIL ?? "";

/**
 * Composes an onboarding request in the visitor's email app. No form data is
 * stored by PrintFlow. Set NEXT_PUBLIC_ONBOARDING_EMAIL for this to be offered.
 */
export function OnboardingForm() {
  const [sent, setSent] = useState(false);
  if (!CONTACT) {
    return <p className="muted">University onboarding requests are handled by the PrintFlow team. Ask your PrintFlow contact for the onboarding address.</p>;
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body = `Name: ${f.get("name")}\nRole: ${f.get("role")}\nUniversity: ${f.get("university")}\nPhone: ${f.get("phone") ?? ""}\n\n${f.get("message") ?? ""}`;
        window.location.href = `mailto:${CONTACT}?subject=${encodeURIComponent(`PrintFlow onboarding: ${String(f.get("university"))}`)}&body=${encodeURIComponent(body)}`;
        setSent(true);
      }}
    >
      <div className="field">
        <label htmlFor="ob-name">Your name</label>
        <input id="ob-name" name="name" required autoComplete="name" />
      </div>
      <div className="field">
        <label htmlFor="ob-role">Your role</label>
        <input id="ob-role" name="role" required placeholder="e.g. Director of Student Affairs" />
      </div>
      <div className="field">
        <label htmlFor="ob-uni">University</label>
        <input id="ob-uni" name="university" required />
      </div>
      <div className="field">
        <label htmlFor="ob-phone">Phone (optional)</label>
        <input id="ob-phone" name="phone" type="tel" autoComplete="tel" />
      </div>
      <div className="field">
        <label htmlFor="ob-msg">Anything we should know</label>
        <textarea id="ob-msg" name="message" />
      </div>
      <button className="btn btn-primary" type="submit">
        Email the onboarding team
      </button>
      {sent && <p className="muted" role="status">Your email app should open with the request filled in.</p>}
    </form>
  );
}
