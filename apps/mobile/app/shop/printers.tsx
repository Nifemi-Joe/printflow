import { useState } from "react";
import { Pressable, View } from "react-native";
import { PowerLine } from "@/components/PowerLine";
import { Body, Button, Empty, ErrorBox, Field, H2, Notice, Pill, Screen, Sheet, Skeleton, st } from "@/components/ui";
import { api } from "@/lib/api";
import { useActiveShop } from "@/lib/shop";
import { C, type Power, S, when } from "@/lib/theme";
import { useData } from "@/lib/use-data";

interface Device {
  id: string;
  label: string;
  reportedStatus: string;
  statusReportedAt: string | null;
  reportedBy: string | null;
}

const STATUSES: Array<{ value: string; label: string }> = [
  { value: "AVAILABLE", label: "Working" },
  { value: "BUSY", label: "Busy" },
  { value: "OUT_OF_PAPER", label: "Out of paper" },
  { value: "OUT_OF_TONER", label: "Out of toner" },
  { value: "FAULT", label: "Fault" },
  { value: "OFFLINE", label: "Switched off" },
];
const label = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? "Not reported";

export default function Printers() {
  const shop = useActiveShop();
  const { data, error, loading, refresh, refreshing, reload } = useData<{ items: Device[] }>(shop ? `/shops/${shop.shopId}/devices` : null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canReport = shop?.can("orders.produce") ?? false;
  const profile = useData<{ power: Power | null }>(shop ? `/shops/${shop.shopId}` : null);
  const [note, setNote] = useState("");
  const [askBack, setAskBack] = useState(false);

  async function reportPower(status: "GRID" | "GENERATOR" | "OUTAGE", backInHours?: number) {
    if (!shop) return;
    setBusy(`power:${status}`);
    setActionError(null);
    try {
      await api(`/shops/${shop.shopId}/power`, {
        method: "PUT",
        body: { status, ...(backInHours ? { backAt: new Date(Date.now() + backInHours * 3_600_000).toISOString() } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setNote("");
      setAskBack(false);
      await profile.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function report(d: Device, status: string) {
    if (!shop) return;
    setBusy(`${d.id}:${status}`);
    setActionError(null);
    try {
      await api(`/shops/${shop.shopId}/devices/${d.id}`, { method: "PATCH", body: { reportedStatus: status } });
      await reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen title="Power & printers" refreshing={refreshing} onRefresh={async () => (await refresh(), await profile.reload())}>
      <Sheet>
        <H2>Power</H2>
        <PowerLine power={profile.data?.power} showWho />
        {!profile.data?.power || profile.data.power.status === "UNKNOWN" ? <Body muted>Not reported yet. Students see what you set here.</Body> : null}
        {canReport ? (
          <View style={{ marginTop: S.md }}>
            <Field label="Note for students (optional)" value={note} onChangeText={setNote} maxLength={140} placeholder="e.g. Diesel until 6pm" />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm }}>
              <Button label="Light on" tone="quiet" small busy={busy === "power:GRID"} onPress={() => void reportPower("GRID")} />
              <Button label="Generator on" tone="quiet" small busy={busy === "power:GENERATOR"} onPress={() => void reportPower("GENERATOR")} />
              <Button label="Light out" tone="danger" small onPress={() => setAskBack(true)} />
            </View>
            {askBack ? (
              <View style={{ marginTop: S.md }}>
                <Body style={{ fontWeight: "700", marginBottom: S.sm }}>When do you expect power back?</Body>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm }}>
                  {[1, 2, 4].map((h) => (
                    <Button key={h} label={`In ${h} hour${h === 1 ? "" : "s"}`} tone="quiet" small busy={busy === "power:OUTAGE"} onPress={() => void reportPower("OUTAGE", h)} />
                  ))}
                  <Button label="Not sure" tone="quiet" small onPress={() => void reportPower("OUTAGE")} />
                </View>
              </View>
            ) : null}
          </View>
        ) : null}
      </Sheet>
      <Notice>PrintFlow doesn't read printer status automatically. What you see here is what staff last reported.</Notice>
      <ErrorBox error={error ?? actionError} onRetry={reload} />
      {loading ? (
        <Skeleton lines={4} />
      ) : !data?.items.length ? (
        <Empty title="No printers listed">A shop manager can add printers on the PrintFlow website.</Empty>
      ) : (
        data.items.map((d) => (
          <Sheet key={d.id}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Body style={{ fontWeight: "700", flex: 1 }}>{d.label}</Body>
              <Pill status={d.reportedStatus} label={label(d.reportedStatus)} />
            </View>
            <Body muted>{d.statusReportedAt ? `Reported ${when(d.statusReportedAt)}${d.reportedBy ? ` by ${d.reportedBy}` : ""}` : "No report yet"}</Body>
            {canReport ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm, marginTop: S.md }}>
                {STATUSES.map((s) => {
                  const on = d.reportedStatus === s.value;
                  return (
                    <Pressable
                      key={s.value}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on, busy: busy === `${d.id}:${s.value}` }}
                      accessibilityLabel={`${d.label}: ${s.label}`}
                      disabled={on || busy !== null}
                      onPress={() => void report(d, s.value)}
                      style={[st.chip, on && { borderColor: C.emerald, backgroundColor: C.emeraldWash }]}
                    >
                      <Body>{s.label}</Body>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </Sheet>
        ))
      )}
    </Screen>
  );
}
