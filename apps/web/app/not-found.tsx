import Link from "next/link";
import { AuthFrame } from "@/components/AuthFrame";

export default function NotFound() {
  return (
    <AuthFrame title="This page does not exist">
      <p>The link may be old, or the page may have moved.</p>
      <Link className="btn btn-primary" href="/">
        Go to PrintFlow
      </Link>
    </AuthFrame>
  );
}
