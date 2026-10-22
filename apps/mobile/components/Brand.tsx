import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, Text, View } from "react-native";
// The same artwork the app icon and the native splash are built from, so the
// hand-off from the system splash to this screen has nothing to notice.
import MARK from "../assets/icon.png";
import { C, F, S } from "@/lib/theme";

/** The PrintFlow mark. Decorative: every place it appears, the name is beside it. */
export function Logo({ size = 32 }: { size?: number }) {
    return <Image source={MARK} accessible={false} accessibilityIgnoresInvertColors style={{ width: size, height: size, borderRadius: size * 0.22 }} />;
}

/**
 * The splash. Android and iOS show their own version of this screen from the moment
 * the icon is tapped; this one takes over the instant JavaScript is running and
 * stays until the session has been restored from secure storage — which on a cold
 * start over campus data is the part that actually takes time.
 *
 * It is deliberately identical to the native splash, so the swap is invisible. The
 * only thing that moves is the three squares trailing off the mark, lit in turn.
 */
export function Splash({ visible, label = "Getting things ready…", onHidden }: { visible: boolean; label?: string; onHidden?: () => void }) {
    const fade = useRef(new Animated.Value(1)).current;
    const [gone, setGone] = useState(false);
    const [still, setStill] = useState(false);

    useEffect(() => {
        AccessibilityInfo.isReduceMotionEnabled()
            .then(setStill)
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        if (visible) {
            fade.setValue(1);
            setGone(false);
            return;
        }
        Animated.timing(fade, { toValue: 0, duration: still ? 0 : 300, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(({ finished }) => {
            if (!finished) return;
            setGone(true);
            onHidden?.();
        });
    }, [visible, still, fade, onHidden]);

    if (gone) return null;
    return (
        <Animated.View
            style={[StyleSheet.absoluteFill, st.splash, { opacity: fade }]}
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            // Nothing behind it is reachable until it is gone.
            accessibilityViewIsModal
            pointerEvents={visible ? "auto" : "none"}
        >
            <Logo size={112} />
            <Text style={st.word}>PrintFlow</Text>
            <Text style={st.label}>{label}</Text>
            <Dots still={still} />
        </Animated.View>
    );
}

/** Three squares from the mark, lit in sequence. Still — but lit — under reduced motion. */
function Dots({ still }: { still: boolean }) {
    const a = useRef(new Animated.Value(0.25)).current;
    const b = useRef(new Animated.Value(0.25)).current;
    const c = useRef(new Animated.Value(0.25)).current;

    useEffect(() => {
        const vals = [a, b, c];
        if (still) {
            for (const v of vals) v.setValue(1);
            return;
        }
        const loops = vals.map((v, i) =>
            Animated.loop(
                Animated.sequence([
                    Animated.delay(i * 160),
                    Animated.timing(v, { toValue: 1, duration: 400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
                    Animated.timing(v, { toValue: 0.25, duration: 400, easing: Easing.in(Easing.quad), useNativeDriver: true }),
                    Animated.delay(480 - i * 160),
                ]),
            ),
        );
        for (const l of loops) l.start();
        return () => {
            for (const l of loops) l.stop();
        };
    }, [still, a, b, c]);

    return (
        <View style={st.dots}>
            {[a, b, c].map((v, i) => (
                <Animated.View
                    key={i}
                    style={[st.dot, { opacity: v, transform: [{ scale: v.interpolate({ inputRange: [0.25, 1], outputRange: [0.82, 1] }) }] }]}
                />
            ))}
        </View>
    );
}

const st = StyleSheet.create({
    splash: { backgroundColor: C.ink, alignItems: "center", justifyContent: "center", zIndex: 100 },
    word: { marginTop: S.lg, color: C.onInk, fontFamily: F.displayHeavy, fontSize: 30, letterSpacing: -0.8 },
    label: { marginTop: S.sm, color: C.onInkMuted, fontFamily: F.body, fontSize: 14 },
    dots: { flexDirection: "row", gap: 6, marginTop: S.xl },
    dot: { width: 9, height: 9, borderRadius: 2, backgroundColor: C.emerald },
});