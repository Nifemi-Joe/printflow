import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Alert, Platform, Text, View } from "react-native";
import { Body, Button, Choice, ErrorBox, H2, Line, Pill, Screen, Sheet, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { C, F, METHOD_LABEL, naira, S, STATUS_LABEL, when } from "@/lib/theme";
import { useData } from "@/lib/use-data";

interface Order {
  id: string;
  reference: string;
  status: string;
  totalKobo: number;
  lines: Array<{ code: string; description: string; amount: number }>;
  display: { serviceFee: string; total: string };
  shop: { name: string };
  pickupLocation: string;
  document: { title: string };
  cancellation: "CANCEL_NO_CHARGE" | "CANCEL_WITH_REFUND" | "NOT_ELIGIBLE";
  queue: { position: number; estimatedMinutes: number | null } | null;
  canRequestPickupCode: boolean;
  events: Array<{ to: string; reason: string | null; at: string }>;
  payments: Array<{ status: string; reference: string; paidWith: string | null }>;
  paymentMethods: Array<"CARD" | "BANK_TRANSFER" | "USSD">;
}

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: o, error, loading, refresh, refreshing, reload } = useData<Order>(`/orders/${id}`, 8000);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<"CARD" | "BANK_TRANSFER" | "USSD" | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };

  if (loading || !o)
    return (
      <Screen title="Order">
        <ErrorBox error={error} onRetry={reload} />
        <Skeleton lines={6} />
      </Screen>
    );

  return (
    <Screen title={o.document.title} refreshing={refreshing} onRefresh={refresh}>
      <View style={{ marginBottom: S.md }}>
        <Pill status={o.status} />
      </View>
      <Body muted>
        {o.reference}, {o.shop.name}, collect from {o.pickupLocation}
      </Body>
      <ErrorBox error={actionError} />

      {o.status === "AWAITING_PAYMENT" ? (
        <Sheet style={{ marginTop: S.lg }}>
          <H2>Pay to send this job to the shop</H2>
          {o.paymentMethods.length > 1 ? (
            <Choice
              label="Pay with"
              value={method ?? o.paymentMethods[0]!}
              onChange={setMethod}
              options={o.paymentMethods.map((m) => ({ value: m, label: METHOD_LABEL[m] ?? m }))}
            />
          ) : null}
          <Button
            label={`Pay ${o.display.total}`}
            busy={busy}
            onPress={() =>
              run(async () => {
                const r = await api<{ checkoutUrl: string }>(`/orders/${o.id}/payments`, { method: "POST", body: { method: method ?? o.paymentMethods[0] } });
                await WebBrowser.openBrowserAsync(r.checkoutUrl);
              })
            }
          />
        </Sheet>
      ) : null}

      {o.queue ? (
        <Sheet style={{ marginTop: S.lg }}>
          <H2>{o.queue.position === 1 ? "Next in the queue" : `Number ${o.queue.position} in the queue`}</H2>
          <Body muted>{o.queue.estimatedMinutes ? `About ${o.queue.estimatedMinutes} minutes, based on this shop's recent jobs.` : "Not enough history for a time estimate yet."}</Body>
        </Sheet>
      ) : null}

      {o.canRequestPickupCode ? (
        <Sheet style={{ marginTop: S.lg, borderColor: C.emerald }}>
          <H2>Ready to collect</H2>
          {code ? (
            <>
              <Text
                accessibilityLabel={`Pickup code ${code.code.split("").join(" ")}`}
                style={{ fontFamily: F.displayHeavy, fontSize: 52, letterSpacing: 8, color: C.emeraldDeep, textAlign: "center", marginVertical: S.md }}
              >
                {code.code.slice(0, 3)} {code.code.slice(3)}
              </Text>
              <Body muted>Show this at the counter. It works once and expires {when(code.expiresAt)}.</Body>
            </>
          ) : (
            <Body>Get your code when you reach the shop.</Body>
          )}
          <View style={{ height: S.md }} />
          <Button
            label={code ? "Get a new code" : "Show my pickup code"}
            busy={busy}
            onPress={() =>
              run(async () => {
                setCode(await api(`/orders/${o.id}/pickup-code`, { method: "POST" }));
                if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              })
            }
          />
        </Sheet>
      ) : null}

      <Sheet style={{ marginTop: S.lg }}>
        <H2>Price</H2>
        {o.lines.map((l) => (
          <Line key={l.code} left={l.description} right={naira(l.amount)} />
        ))}
        <Line left="Service fee" right={o.display.serviceFee} />
        <Line strong left="Total" right={o.display.total} />
        {o.payments
          .filter((p) => p.status === "SUCCEEDED" && p.paidWith)
          .map((p) => (
            <Body key={p.reference} muted>
              Paid by {METHOD_LABEL[p.paidWith!] ?? p.paidWith}
            </Body>
          ))}
      </Sheet>

      <Sheet>
        <H2>Progress</H2>
        {o.events.map((e, i) => (
          <View key={i} style={{ paddingVertical: S.sm, borderLeftWidth: 2, borderLeftColor: C.emerald, paddingLeft: S.md, marginBottom: 2 }}>
            <Body style={{ fontWeight: "700" }}>{STATUS_LABEL[e.to] ?? e.to}</Body>
            <Body muted>
              {when(e.at)}
              {e.reason ? `: ${e.reason}` : ""}
            </Body>
          </View>
        ))}
      </Sheet>

      {o.cancellation !== "NOT_ELIGIBLE" ? (
        <Button
          tone="danger"
          label={o.cancellation === "CANCEL_WITH_REFUND" ? "Cancel and refund" : "Cancel order"}
          busy={busy}
          onPress={() => {
            const go = () => void run(() => api(`/orders/${o.id}/cancel`, { method: "POST", body: {} }));
            if (Platform.OS === "web") go();
            else Alert.alert("Cancel this order?", o.cancellation === "CANCEL_WITH_REFUND" ? "You will get a full refund." : undefined, [{ text: "Keep it" }, { text: "Cancel order", style: "destructive", onPress: go }]);
          }}
        />
      ) : null}
    </Screen>
  );
}
