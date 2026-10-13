import { useEffect, useRef, type ReactNode } from "react";
import { ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorMessage } from "@/lib/api";
import { C, F, S, STATUS_LABEL } from "@/lib/theme";

export function Screen({ title, children, refreshing, onRefresh, right }: { title: string; children: ReactNode; refreshing?: boolean; onRefresh?: () => void; right?: ReactNode }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.paper }} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={{ padding: S.lg, paddingBottom: S.xxl * 2 }}
        refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={C.emerald} /> : undefined}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: S.lg }}>
          <Text style={st.h1} accessibilityRole="header">
            {title}
          </Text>
          {right}
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <Text style={st.h2} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  return <Text style={[st.body, muted && { color: C.graphite2 }, style]}>{children}</Text>;
}

export function Sheet({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[st.sheet, style]}>{children}</View>;
}

export function Button({ label, onPress, tone = "primary", disabled, busy, small }: { label: string; onPress: () => void; tone?: "primary" | "quiet" | "danger"; disabled?: boolean; busy?: boolean; small?: boolean }) {
  const bg = tone === "primary" ? C.emerald : C.sheet;
  const fg = tone === "primary" ? "#fff" : tone === "danger" ? C.red : C.emeraldDeep;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        st.btn,
        small && { minHeight: 40, paddingHorizontal: S.md },
        { backgroundColor: bg, borderColor: tone === "primary" ? bg : tone === "danger" ? "#e6b8b3" : C.rule, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[st.btnText, { color: fg }, small && { fontSize: 14 }]}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, error, ...props }: TextInputProps & { label: string; hint?: string; error?: string }) {
  return (
    <View style={{ marginBottom: S.lg }}>
      <Text style={st.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor="#8a9096" style={[st.input, error ? { borderColor: C.red } : null]} {...props} />
      {hint && !error ? <Text style={[st.small, { color: C.graphite2 }]}>{hint}</Text> : null}
      {error ? <Text style={[st.small, { color: C.red }]}>{error}</Text> : null}
    </View>
  );
}

export function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <View style={{ marginBottom: S.lg }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={st.label}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => onChange(o.value)}
              style={[st.chip, on && { borderColor: C.emerald, backgroundColor: C.emeraldWash }]}
            >
              <Text style={[st.body, on && { fontFamily: F.bodyBold, color: C.emeraldDeep }]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Pill({ status, label }: { status: string; label?: string }) {
  const go = ["READY_FOR_PICKUP", "COLLECTED", "READY", "AVAILABLE", "SUCCEEDED"].includes(status);
  const bad = ["REJECTED", "CANCELLED", "EXPIRED", "FAILED", "INFECTED", "FAULT", "OFFLINE"].includes(status);
  const warn = !go && !bad && ["PAUSED", "PRINT_FAILED", "REFUND_PENDING", "AWAITING_PAYMENT", "PENDING", "PROCESSING", "OUT_OF_PAPER", "OUT_OF_TONER", "BUSY"].includes(status);
  const [bg, fg] = go ? [C.emeraldWash, C.emeraldDeep] : bad ? [C.redWash, C.red] : warn ? [C.amberWash, C.amber] : ["#eef0ed", C.graphite];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start" }}>
      <Text style={{ color: fg, fontFamily: F.bodyBold, fontSize: 13 }}>{label ?? STATUS_LABEL[status] ?? status.toLowerCase().replace(/_/g, " ")}</Text>
    </View>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <View style={[st.notice, { borderLeftColor: C.red, backgroundColor: C.redWash }]} accessibilityRole="alert">
      <Body>{errorMessage(error)}</Body>
      {onRetry ? (
        <View style={{ marginTop: S.sm }}>
          <Button label="Try again" tone="quiet" small onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <View style={[st.notice, tone === "warn" && { borderLeftColor: C.amber, backgroundColor: C.amberWash }]}>
      <Body>{children}</Body>
    </View>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={st.empty}>
      <Text style={st.h3}>{title}</Text>
      {children ? <Body muted>{children}</Body> : null}
    </View>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  const o = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([Animated.timing(o, { toValue: 1, duration: 700, useNativeDriver: true }), Animated.timing(o, { toValue: 0.5, duration: 700, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [o]);
  return (
    <View accessibilityLabel="Loading" accessible>
      {Array.from({ length: lines }, (_, i) => (
        <Animated.View key={i} style={{ opacity: o, height: i === 0 ? 22 : 14, width: `${90 - i * 12}%`, backgroundColor: "#e3e7e2", borderRadius: 4, marginBottom: S.md }} />
      ))}
    </View>
  );
}

export function Line({ left, right, strong }: { left: string; right: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: S.sm, borderBottomWidth: strong ? 0 : 1, borderStyle: "dashed", borderColor: C.rule }}>
      <Text style={[strong ? st.total : st.body, { flex: 1, paddingRight: S.md }]}>{left}</Text>
      <Text style={strong ? st.total : st.body}>{right}</Text>
    </View>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <View style={{ height: 8, backgroundColor: "#e3e7e2", borderRadius: 999, overflow: "hidden" }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}>
      <View style={{ height: 8, width: `${Math.round(value * 100)}%`, backgroundColor: C.emerald }} />
    </View>
  );
}

export const st = StyleSheet.create({
  h1: { fontFamily: F.displayHeavy, fontSize: 32, color: C.emeraldDeep, letterSpacing: -0.5, flexShrink: 1 },
  h2: { fontFamily: F.display, fontSize: 22, color: C.emeraldDeep, marginBottom: S.md },
  h3: { fontFamily: F.display, fontSize: 18, color: C.emeraldDeep, marginBottom: S.sm },
  body: { fontFamily: F.body, fontSize: 16, color: C.graphite, lineHeight: 23 },
  small: { fontFamily: F.body, fontSize: 13, marginTop: 4 },
  label: { fontFamily: F.bodyBold, fontSize: 14, color: C.graphite, marginBottom: 6 },
  total: { fontFamily: F.display, fontSize: 22, color: C.emeraldDeep },
  sheet: { backgroundColor: C.sheet, borderWidth: 1, borderColor: C.rule, borderRadius: 3, padding: S.lg, marginBottom: S.lg },
  btn: { minHeight: 48, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: S.xl },
  btnText: { fontFamily: F.bodyBold, fontSize: 16 },
  input: { minHeight: 48, borderWidth: 1, borderColor: "#b9c0b8", borderRadius: 8, backgroundColor: C.sheet, paddingHorizontal: S.md, fontFamily: F.body, fontSize: 16, color: C.graphite },
  chip: { minHeight: 44, paddingHorizontal: S.lg, borderWidth: 1, borderColor: "#b9c0b8", borderRadius: 8, justifyContent: "center", backgroundColor: C.sheet },
  notice: { borderLeftWidth: 4, borderLeftColor: C.emerald, backgroundColor: C.emeraldWash, padding: S.md, borderRadius: 4, marginBottom: S.lg },
  empty: { borderWidth: 2, borderStyle: "dashed", borderColor: C.rule, borderRadius: 3, padding: S.xl },
});
