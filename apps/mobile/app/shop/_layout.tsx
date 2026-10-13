import { Redirect, Tabs } from "expo-router";
import { Text } from "react-native";
import { useSession } from "@/lib/session";
import { C, F } from "@/lib/theme";

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: string }) {
    return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
  };

export default function ShopTabs() {
  const { me, loading } = useSession();
  if (!loading && !me) return <Redirect href="/login" />;
  if (me && me.shopMemberships.length === 0) return <Redirect href="/" />;
  // Staff sessions must pass MFA before any shop data loads.
  if (me && me.session.mfaRequired && !me.session.mfaVerified) return <Redirect href="/mfa" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.emeraldDeep,
        tabBarInactiveTintColor: C.graphite2,
        tabBarLabelStyle: { fontFamily: F.bodyBold, fontSize: 12 },
        tabBarStyle: { backgroundColor: C.sheet, borderTopColor: C.rule, minHeight: 60 },
      }}
    >
      <Tabs.Screen name="queue" options={{ title: "Queue", tabBarIcon: icon("▤") }} />
      <Tabs.Screen name="collect" options={{ title: "Collect", tabBarIcon: icon("✓") }} />
      <Tabs.Screen name="printers" options={{ title: "Printers", tabBarIcon: icon("⎙") }} />
    </Tabs>
  );
}
