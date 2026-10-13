import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, Pressable } from "react-native";
import { Body, Button, Empty, ErrorBox, Field, H2, Notice, Screen, Sheet, Skeleton, st } from "@/components/ui";
import { api } from "@/lib/api";
import { useActiveShop } from "@/lib/shop";
import { C, S, when } from "@/lib/theme";
import { useData } from "@/lib/use-data";

interface Ready {
  id: string;
  reference: string;
  studentName: string;
  pickupLocation: string;
  statusChangedAt: string;
}

const buzz = (ok: boolean) => {
  if (Platform.OS === "web") return;
  void Haptics.notificationAsync(ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error);
};

export default function Collect() {
  const shop = useActiveShop();
  const params = useLocalSearchParams<{ order?: string }>();
  const q = useData<{ readyForPickup: Ready[] }>(shop ? `/shops/${shop.shopId}/queue` : null, 15_000);
  const [orderId, setOrderId] = useState(params.order ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (params.order) setOrderId(params.order);
  }, [params.order]);

  const ready = q.data?.readyForPickup ?? [];
  const selected = ready.find((r) => r.id === orderId);

  async function confirm() {
    if (!shop || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/shops/${shop.shopId}/orders/${selected.id}/collect`, { method: "POST", body: { code } });
      buzz(true);
      setDone(`${selected.reference} handed to ${selected.studentName}.`);
      setOrderId("");
      setCode("");
      await q.reload();
    } catch (e) {
      buzz(false);
      setError(e);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  if (!shop || !shop.can("orders.collect"))
    return (
      <Screen title="Collect">
        <Empty title="You can't hand over orders">Ask your shop manager for the collection permission.</Empty>
      </Screen>
    );

  return (
    <Screen title="Collect" refreshing={q.refreshing} onRefresh={q.refresh}>
      <Body muted style={{ marginBottom: S.md }}>
        Pick the order, then type the 6-digit code from the student's phone. Each code works once.
      </Body>
      {done ? <Notice>{done}</Notice> : null}
      <ErrorBox error={q.error} onRetry={q.reload} />
      {q.loading ? (
        <Skeleton lines={4} />
      ) : ready.length === 0 ? (
        <Empty title="Nothing waiting">Orders appear here once they pass the quality check.</Empty>
      ) : (
        <>
          <H2>Order</H2>
          {ready.map((r) => (
            <Pressable
              key={r.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: orderId === r.id }}
              onPress={() => {
                setOrderId(r.id);
                setDone(null);
                setError(null);
              }}
              style={[st.chip, { marginBottom: S.sm, paddingVertical: S.md }, orderId === r.id && { borderColor: C.emerald, backgroundColor: C.emeraldWash }]}
            >
              <Body style={{ fontWeight: "700" }}>
                {r.reference}, {r.studentName}
              </Body>
              <Body muted>
                {r.pickupLocation}, ready {when(r.statusChangedAt)}
              </Body>
            </Pressable>
          ))}
          {selected ? (
            <Sheet style={{ marginTop: S.lg }}>
              <Field
                label="Pickup code"
                value={code}
                onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
                keyboardType="number-pad"
                maxLength={6}
                autoComplete="off"
                textContentType="oneTimeCode"
              />
              <ErrorBox error={error} />
              <Button label="Hand over order" busy={busy} disabled={code.length !== 6} onPress={() => void confirm()} />
            </Sheet>
          ) : null}
        </>
      )}
    </Screen>
  );
}
