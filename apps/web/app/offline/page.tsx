import type { Metadata } from "next";
import { AuthFrame } from "@/components/AuthFrame";
import { RetryButton } from "./retry";

export const metadata: Metadata = { title: "Offline" };

export default function Offline() {
  return (
    <AuthFrame title="You're offline">
      <p>PrintFlow needs a connection to upload documents, get prices, pay and see your orders.</p>
      <p className="muted">Shop staff: actions you take on the queue while offline are saved on this device as drafts and sent when you reconnect.</p>
      <RetryButton />
    </AuthFrame>
  );
}
