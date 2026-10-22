import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PwaRegister } from "@/components/Pwa";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PrintFlow — campus printing without the queue", template: "%s | PrintFlow" },
  description: "Upload your document, see the exact price, pay, and collect your prints with a one-time code. Built for Nigerian universities.",
  applicationName: "PrintFlow",
  appleWebApp: { capable: true, title: "PrintFlow", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Most PrintFlow links are shared in WhatsApp groups, where the preview is the
  // only thing a student sees before deciding to tap.
  openGraph: {
    type: "website",
    siteName: "PrintFlow",
    title: "PrintFlow — campus printing without the queue",
    description: "Upload your document, see the exact price, pay, and collect your prints with a one-time code.",
    images: [{ url: "/brand/mark-1024.png", width: 1024, height: 1024, alt: "PrintFlow" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#05402d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
      <html lang="en-NG">
      {/*
       * Extensions edit <body> before React hydrates — Grammarly adds
       * data-gr-ext-installed, password managers and translators add their own —
       * and React reports every one as a hydration mismatch. Suppressing it here
       * covers this element's own attributes only, one level deep, so a genuine
       * mismatch anywhere inside the app is still reported.
       */}
      <body suppressHydrationWarning>
      <PwaRegister />
      <SessionProvider>{children}</SessionProvider>
      </body>
      </html>
  );
}