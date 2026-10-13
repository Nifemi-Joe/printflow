import { Redirect } from "expo-router";
import { View } from "react-native";
import { Skeleton } from "@/components/ui";
import { homeFor, useSession } from "@/lib/session";

export default function Index() {
  const { me, loading } = useSession();
  if (loading)
    return (
      <View style={{ padding: 24, paddingTop: 80 }}>
        <Skeleton />
      </View>
    );
  return <Redirect href={me ? (homeFor(me) as never) : "/login"} />;
}
