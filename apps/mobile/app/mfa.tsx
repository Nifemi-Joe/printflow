import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";
import { Body, Button, ErrorBox, Field, Screen, Sheet } from "@/components/ui";
import { api } from "@/lib/api";
import { homeFor, useSession } from "@/lib/session";
import { F, S } from "@/lib/theme";

/** Staff must verify (or enrol) an authenticator before using shop or admin screens. */
export default function Mfa() {
  const { me, refresh, signOut } = useSession();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const enrolled = me?.mfa.totpEnrolled;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api(enrolled ? "/auth/mfa/verify" : "/auth/mfa/totp/confirm", { method: "POST", body: { code } });
      const m = await refresh();
      if (m) router.replace(homeFor(m) as never);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={enrolled ? "Verify it's you" : "Two-step sign-in"}>
      <Body muted style={{ marginBottom: S.lg }}>
        Staff accounts can change orders and payments, so they need a code from an authenticator app.
      </Body>
      <ErrorBox error={error} />
      {!enrolled && !setup ? (
        <Button
          label="Start setup"
          onPress={async () => {
            try {
              setSetup(await api("/auth/mfa/totp/setup", { method: "POST" }));
            } catch (e) {
              setError(e);
            }
          }}
        />
      ) : null}
      {setup ? (
        <Sheet>
          <Body>Add this key to your authenticator app:</Body>
          <Text selectable style={{ fontFamily: F.display, fontSize: 18, letterSpacing: 2, marginVertical: S.md }}>
            {setup.secret.match(/.{1,4}/g)?.join(" ")}
          </Text>
          <Button label="Open in authenticator app" tone="quiet" onPress={() => void Linking.openURL(setup.otpauthUri)} />
        </Sheet>
      ) : null}
      {enrolled || setup ? (
        <>
          <Field label="6-digit code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" />
          <Button label={enrolled ? "Verify" : "Finish setup"} onPress={submit} busy={busy} disabled={code.length !== 6} />
        </>
      ) : null}
      <Button
        label="Sign out"
        tone="quiet"
        onPress={async () => {
          await signOut();
          router.replace("/login");
        }}
      />
    </Screen>
  );
}
