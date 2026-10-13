import Link from "next/link";
import { AuthFrame } from "@/components/AuthFrame";

export const metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <AuthFrame title="How PrintFlow handles your data" footer={<Link href="/">Back to PrintFlow</Link>}>
      <p>We keep what is needed to print your documents and run your orders: your name, email, campus, the files you upload, and order and payment records.</p>
      <p>Your files are stored privately. Only you and staff at the shop printing your job can open them, through links that expire within minutes. Every download by shop staff is logged.</p>
      <p>Files are deleted after your university&apos;s retention period once your orders are finished. Payment and order records are kept as required for accounting, without your name if you ask us to erase your account.</p>
      <p>You can download a copy of your data or ask for your account to be erased from your account page.</p>
    </AuthFrame>
  );
}
