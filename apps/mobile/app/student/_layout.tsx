import { Redirect, Tabs } from "expo-router";
import { Text } from "react-native";
import { useSession } from "@/lib/session";
import { C, F } from "@/lib/theme";

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: string }) {
    return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
  };

export default function StudentTabs() {
  const { me, loading } = useSession();
  if (!loading && !me) return <Redirect href="/login" />;
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
      <Tabs.Screen name="orders" options={{ title: "Orders", tabBarIcon: icon("▤") }} />
      <Tabs.Screen name="print" options={{ title: "Print", tabBarIcon: icon("⎙") }} />
      <Tabs.Screen name="documents" options={{ title: "Documents", tabBarIcon: icon("▢") }} />
      <Tabs.Screen name="notifications" options={{ title: "Alerts", tabBarIcon: icon("◔") }} />
    </Tabs>
  );
}
