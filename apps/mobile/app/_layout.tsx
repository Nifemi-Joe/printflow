import { AtkinsonHyperlegible_400Regular, AtkinsonHyperlegible_700Bold } from "@expo-google-fonts/atkinson-hyperlegible";
import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold } from "@expo-google-fonts/bricolage-grotesque";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "@/lib/session";
import { C, F } from "@/lib/theme";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const [loaded, failed] = useFonts({ AtkinsonHyperlegible_400Regular, AtkinsonHyperlegible_700Bold, BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });
  useEffect(() => {
    if (loaded || failed) void SplashScreen.hideAsync().catch(() => undefined);
  }, [loaded, failed]);
  // Fall back to system fonts rather than block the app if fonts fail to load.
  if (!loaded && !failed) return null;

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: C.paper },
            headerTintColor: C.emeraldDeep,
            headerTitleStyle: { fontFamily: F.display },
          }}
        >
          <Stack.Screen name="order/[id]" options={{ headerShown: true, title: "Order" }} />
          <Stack.Screen name="account" options={{ headerShown: true, title: "Account" }} />
        </Stack>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
