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
    icon: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
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
      <body>
        <PwaRegister />
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
