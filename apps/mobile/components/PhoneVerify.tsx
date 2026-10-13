import { useEffect, useState } from "react";
import { View } from "react-native";
import { Body, Button, ErrorBox, Field, Pill } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { S } from "@/lib/theme";

/** Add or change a phone number and confirm it with the texted 6-digit code. */
export function PhoneVerify({ phone, verified, onVerified }: { phone: string | null; verified: boolean; onVerified: () => Promise<unknown> }) {
  const [number, setNumber] = useState(phone ?? "");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [editing, setEditing] = useState(!phone || !verified);
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

  const send = () =>
    run(async () => {
      const r = await api<{ alreadyVerified: boolean; sentTo: string | null; resendAfterSeconds?: number }>("/me/phone", { method: "POST", body: { phone: number } });
      if (r.alreadyVerified) {
        setEditing(false);
        await onVerified();
        return;
      }
      setSentTo(r.sentTo);
      setLeft(r.resendAfterSeconds ?? 60);
    });

  if (verified && !editing) {
    return (
      <View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: S.sm, marginBottom: S.sm }}>
          <Body style={{ fontWeight: "700" }}>{phone}</Body>
          <Pill status="READY" label="Confirmed" />
        </View>
        <Button label="Use a different number" tone="quiet" small onPress={() => (setEditing(true), setNumber(""))} />
      </View>
    );
  }

  return (
    <View>
      <ErrorBox error={error} />
      {!sentTo ? (
        <>
          <Field label="Phone number" hint="We text you a 6-digit code" value={number} onChangeText={setNumber} keyboardType="phone-pad" autoComplete="tel" placeholder="0801 234 5678" />
          <Button label={left > 0 ? `Send again in ${left}s` : "Text me a code"} busy={busy} disabled={number.trim().length < 7 || left > 0} onPress={send} />
        </>
      ) : (
        <>
          <Body style={{ marginBottom: S.md }}>We sent a code to {sentTo}. It works for 10 minutes.</Body>
          <Field label="6-digit code" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad" maxLength={6} autoComplete="sms-otp" textContentType="oneTimeCode" autoFocus />
          <Button
            label="Confirm number"
            busy={busy}
            disabled={code.length !== 6}
            onPress={() =>
              run(async () => {
                await api("/me/phone/verify", { method: "POST", body: { code } });
                setSentTo(null);
                setCode("");
                setEditing(false);
                await onVerified();
              })
            }
          />
          <View style={{ flexDirection: "row", gap: S.sm, marginTop: S.sm, flexWrap: "wrap" }}>
            <Button label={left > 0 ? `Resend in ${left}s` : "Resend code"} tone="quiet" small disabled={left > 0 || busy} onPress={send} />
            <Button label="Change number" tone="quiet" small onPress={() => setSentTo(null)} />
          </View>
        </>
      )}
    </View>
  );
}
