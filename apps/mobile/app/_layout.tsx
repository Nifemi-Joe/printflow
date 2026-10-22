import { AtkinsonHyperlegible_400Regular, AtkinsonHyperlegible_700Bold } from "@expo-google-fonts/atkinson-hyperlegible";
import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold } from "@expo-google-fonts/bricolage-grotesque";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Splash } from "@/components/Brand";
import { SessionProvider, useSession } from "@/lib/session";
import { C, F } from "@/lib/theme";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
    const [loaded, failed] = useFonts({ AtkinsonHyperlegible_400Regular, AtkinsonHyperlegible_700Bold, BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });
    // Fall back to system fonts rather than block the app if fonts fail to load.
    // Until one or the other happens the system splash is still on screen, so there
    // is nothing to render and nothing to flash.
    if (!loaded && !failed) return null;

    return (
        <SafeAreaProvider>
            <SessionProvider>
                <View style={{ flex: 1, backgroundColor: C.paper }}>
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
                    <Boot />
                </View>
            </SessionProvider>
        </SafeAreaProvider>
    );
}

/**
 * Holds the splash over the app until the stored session has been read back, then
 * hands over. The system splash is dismissed in the same breath that ours appears,
 * so the two never both leave the screen blank between them.
 */
function Boot() {
    const { loading } = useSession();

    useEffect(() => {
        void SplashScreen.hideAsync().catch(() => undefined);
    }, []);

    return (
        <>
            <StatusBar style={loading ? "light" : "dark"} />
            <Splash visible={loading} />
        </>
    );
}