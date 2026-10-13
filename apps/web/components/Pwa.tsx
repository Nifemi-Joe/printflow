"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Registers the service worker (production builds only) and captures the install prompt. */
export function PwaRegister() {
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferred = e as BeforeInstallPromptEvent;
      notify();
    };
    const onInstalled = () => {
      deferred = null;
      notify();
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}

function useInstallState() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  if (typeof window === "undefined") return { canPrompt: false, ios: false, installed: false };
  const installed = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  return { canPrompt: Boolean(deferred), ios, installed };
}

const DISMISS_KEY = "pf-install-dismissed";

/** "Add PrintFlow to your home screen", shown once to people who haven't installed it. */
export function InstallPrompt() {
  const { canPrompt, ios, installed } = useInstallState();
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);
  if (installed || dismissed || (!canPrompt && !ios)) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode */
    }
  };

  return (
    <div className="notice install-prompt" role="note">
      <p>
        <strong>Add PrintFlow to your home screen.</strong>{" "}
        {canPrompt ? "It opens like an app, loads faster and uses less data." : "Tap the Share button, then “Add to Home Screen”."}
      </p>
      <div className="row">
        {canPrompt && (
          <button
            className="btn btn-primary btn-small"
            onClick={async () => {
              const e = deferred;
              if (!e) return;
              await e.prompt();
              await e.userChoice.catch(() => undefined);
              deferred = null;
              notify();
            }}
          >
            Install
          </button>
        )}
        <button className="btn btn-quiet btn-small" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
