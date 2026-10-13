import { router } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { Body, Button, Choice, ErrorBox, Field, Screen, st } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { homeFor, useSession } from "@/lib/session";
import { C, S } from "@/lib/theme";

type Mode = "password" | "code";

export default function Login() {
  const { signIn, requestCode, signInWithCode } = useSession();
  const [mode, setMode] = useState<Mode>("password");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [smsCode, setSmsCode] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needMfa, setNeedMfa] = useState(false);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setLeft(60);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const done = (r: { me: Parameters<typeof homeFor>[0]; needsCode: boolean }) => {
    if (r.needsCode && !needMfa) {
      setNeedMfa(true);
      return;
    }
    router.replace(homeFor(r.me) as never);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen title="PrintFlow">
        <Text style={[st.h2, { marginTop: S.md }]}>Sign in</Text>
        <Body muted style={{ marginBottom: S.lg }}>
          Students print and track orders here. Shop staff run the queue and hand over prints.
        </Body>
        <Choice
          label="Sign in with"
          value={mode}
          onChange={(m) => (setMode(m), setError(null), setNeedMfa(false))}
          options={[
            { value: "password", label: "Password" },
            { value: "code", label: "Text me a code" },
          ]}
        />
        <ErrorBox error={error} />

        {mode === "password" ? (
          <>
            <Field
              label="Email or phone number"
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoComplete="username"
              keyboardType="email-address"
              textContentType="username"
            />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" />
            {needMfa ? (
              <Field label="Code from your authenticator app" value={mfaCode} onChangeText={setMfaCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" autoFocus />
            ) : null}
            <Button
              label={busy ? "Signing in…" : "Sign in"}
              busy={busy}
              disabled={!identifier || !password || (needMfa && mfaCode.length !== 6)}
              onPress={() => run(async () => done(await signIn(identifier, password, needMfa ? mfaCode : undefined)))}
            />
          </>
        ) : !sentTo ? (
          <>
            <Field
              label="Phone number"
              hint="Works once your number is confirmed on your account"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              placeholder="0801 234 5678"
            />
            <Button
              label={left > 0 ? `Send again in ${left}s` : "Text me a sign-in code"}
              busy={busy}
              disabled={phone.trim().length < 7 || left > 0}
              onPress={() =>
                run(async () => {
                  const r = await requestCode(phone);
                  setSentTo(r.sentTo);
                  setLeft(r.resendAfterSeconds);
                })
              }
            />
          </>
        ) : (
          <>
            <Body style={{ marginBottom: S.md }}>If {sentTo} is confirmed on a PrintFlow account, a code is on its way. It works for 10 minutes.</Body>
            <Field label="6-digit code" value={smsCode} onChangeText={(t) => setSmsCode(t.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad" maxLength={6} autoComplete="sms-otp" textContentType="oneTimeCode" autoFocus />
            {needMfa ? <Field label="Code from your authenticator app" value={mfaCode} onChangeText={setMfaCode} keyboardType="number-pad" maxLength={6} /> : null}
            <Button
              label={busy ? "Signing in…" : "Sign in"}
              busy={busy}
              disabled={smsCode.length !== 6 || (needMfa && mfaCode.length !== 6)}
              onPress={() => run(async () => done(await signInWithCode(phone, smsCode, needMfa ? mfaCode : undefined)))}
            />
            <View style={{ flexDirection: "row", gap: S.sm, marginTop: S.md, flexWrap: "wrap" }}>
              <Button
                label={left > 0 ? `Resend in ${left}s` : "Resend code"}
                tone="quiet"
                small
                disabled={left > 0 || busy}
                onPress={() =>
                  run(async () => {
                    const r = await requestCode(phone);
                    setLeft(r.resendAfterSeconds);
                  })
                }
              />
              <Button label="Use a different number" tone="quiet" small onPress={() => (setSentTo(null), setSmsCode(""))} />
            </View>
          </>
        )}

        <View style={{ marginTop: S.xl }}>
          <Body muted>New students create an account on the PrintFlow website. Forgot your password? Sign in with a texted code, or reset it on the website.</Body>
        </View>
        <Text style={{ color: C.graphite2, marginTop: S.lg, fontSize: 12 }}>Your session is stored in this device&apos;s secure storage.</Text>
      </Screen>
    </KeyboardAvoidingView>
  );
}
