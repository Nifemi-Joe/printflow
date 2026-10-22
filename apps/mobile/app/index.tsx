import { Redirect } from "expo-router";
import { homeFor, useSession } from "@/lib/session";

export default function Index() {
  const { me, loading } = useSession();
  // The root layout holds the splash over everything until the session is read
  // back, so there is nothing for this screen to show in the meantime.
  if (loading) return null;
  return <Redirect href={me ? (homeFor(me) as never) : "/login"} />;
}