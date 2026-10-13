import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { PowerLine } from "@/components/PowerLine";
import {
  Body,
  Button,
  Empty,
  ErrorBox,
  Field,
  H2,
  Notice,
  Pill,
  Screen,
  Sheet,
  Skeleton,
} from "@/components/ui";
import { api } from "@/lib/api";
import { isOffline, useActiveShop, useDrafts, useOnline } from "@/lib/shop";
import { type Power, S, STATUS_LABEL, when } from "@/lib/theme";
import { useData } from "@/lib/use-data";

interface Item {
  id: string;
  reference: string;
  status: string;
  version: number;
  position: number;
  totalSheets: number;
  studentName: string;
  pickupLocation: string;
  spec: {
    copies: number;
    paperSize: string;
    colourMode: string;
    sides: string;
    finishingCodes?: string[];
  };
  actions: string[];
}
interface Queue {
  items: Item[];
  readyForPickup: Array<{
    id: string;
    reference: string;
    studentName: string;
    statusChangedAt: string;
  }>;
  summary: {
    jobs: number;
    sheets: number;
    estimatedMinutesToClear: number | null;
  };
  power: Power | null;
}

/** Actions that need a dedicated online flow, not a plain status change. */
const DEDICATED = new Set(["READY_FOR_PICKUP", "COLLECTED"]);
const NEEDS_REASON = new Set(["REJECTED", "PAUSED", "PRINT_FAILED"]);
const ACTION_LABEL: Record<string, string> = {
  ACCEPTED: "Accept",
  REJECTED: "Reject",
  PRINTING: "Start printing",
  PAUSED: "Pause",
  PRINT_FAILED: "Report problem",
  QUALITY_CHECK: "Printed, check it",
};

export default function ShopQueue() {
  const shop = useActiveShop();
  const online = useOnline();
  const q = useData<Queue>(
    shop ? `/shops/${shop.shopId}/queue` : null,
    online === false ? undefined : 10_000,
  );
  const drafts = useDrafts(shop?.shopId ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<{ item: Item; to: string } | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const wasOffline = useRef(false);

  // When the connection comes back, send any drafts automatically.
  useEffect(() => {
    if (online === false) wasOffline.current = true;
    if (online && wasOffline.current) {
      wasOffline.current = false;
      void sendDrafts();
    }
  }, [online]);

  async function sendDrafts() {
    setError(null);
    try {
      const r = await drafts.sync();
      if (r && (r.applied || r.problems)) {
        setNotice(
          `${r.applied} change${r.applied === 1 ? "" : "s"} saved${r.problems ? `, ${r.problems} need${r.problems === 1 ? "s" : ""} your attention` : ""}.`,
        );
      }
      await q.reload();
    } catch (e) {
      if (!isOffline(e)) setError(e);
    }
  }

  async function act(item: Item, to: string, why?: string) {
    if (!shop) return;
    setBusy(`${item.id}:${to}`);
    setError(null);
    setNotice(null);
    const draft = {
      orderId: item.id,
      reference: item.reference,
      to,
      fromStatus: item.status,
      expectedVersion: item.version,
      ...(why ? { reason: why } : {}),
    };
    try {
      if (online === false) {
        await drafts.add(draft);
        return;
      }
      await api(`/shops/${shop.shopId}/orders/${item.id}/transitions`, {
        method: "POST",
        body: {
          to,
          expectedVersion: item.version,
          ...(why ? { reason: why } : {}),
        },
      });
      await q.reload();
    } catch (e) {
      if (isOffline(e)) await drafts.add(draft);
      else setError(e);
    } finally {
      setBusy(null);
      setReasonFor(null);
      setReason("");
    }
  }

  async function passQa(item: Item) {
    if (!shop) return;
    setBusy(`${item.id}:qa`);
    setError(null);
    try {
      await api(`/shops/${shop.shopId}/orders/${item.id}/quality-checks`, {
        method: "POST",
        body: {
          result: "PASS",
          sheetsCounted: item.totalSheets,
          expectedVersion: item.version,
        },
      });
      await q.reload();
    } catch (e) {
      setError(
        isOffline(e)
          ? new Error(
              "Marking a job ready needs a connection, because the student is notified straight away.",
            )
          : e,
      );
    } finally {
      setBusy(null);
    }
  }

  if (!shop)
    return (
      <Screen title="Queue">
        <Empty title="No shop on this account">
          Ask your shop manager to add you as staff.
        </Empty>
      </Screen>
    );

  const draftFor = (orderId: string) =>
    drafts.drafts.find((d) => d.orderId === orderId);

  return (
    <Screen
      title={shop.shopName}
      refreshing={q.refreshing}
      onRefresh={async () => {
        if (drafts.drafts.length && online !== false) await sendDrafts();
        await q.refresh();
      }}
      right={
        <Button
          label="Account"
          tone="quiet"
          small
          onPress={() => router.push("/account")}
        />
      }
    >
      {online === false ? (
        <Notice tone="warn">
          You are offline. Changes you make are saved on this phone as drafts
          and sent when you reconnect. The queue below may be out of date.
        </Notice>
      ) : null}
      {notice ? <Notice>{notice}</Notice> : null}
      <ErrorBox
        error={error ?? (online === false ? null : q.error)}
        onRetry={q.reload}
      />

      {drafts.drafts.length > 0 ? (
        <Sheet>
          <H2>{`${drafts.drafts.length} change${drafts.drafts.length === 1 ? "" : "s"} not sent yet`}</H2>
          <Body muted>
            These have not reached the shop system. Nobody else can see them
            until they are sent.
          </Body>
          {drafts.drafts.map((d) => (
            <View
              key={d.clientActionId}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: S.sm,
              }}
            >
              <Body style={{ flex: 1 }}>
                {d.reference}: {STATUS_LABEL[d.fromStatus] ?? d.fromStatus} to{" "}
                {STATUS_LABEL[d.to] ?? d.to}
              </Body>
              <Button
                label="Undo"
                tone="quiet"
                small
                onPress={() => void drafts.discard(d.clientActionId)}
              />
            </View>
          ))}
          <View style={{ height: S.md }} />
          <Button
            label="Send now"
            busy={drafts.syncing}
            disabled={online === false}
            onPress={() => void sendDrafts()}
          />
        </Sheet>
      ) : null}

      {drafts.problems.length > 0 ? (
        <Sheet>
          <H2>Not applied</H2>
          {drafts.problems.map((p) => (
            <View key={p.clientActionId} style={{ marginTop: S.sm }}>
              <Body style={{ fontWeight: "700" }}>
                {p.reference}: {STATUS_LABEL[p.to] ?? p.to}
              </Body>
              <Body muted>
                {p.outcome === "CONFLICT"
                  ? "Someone changed this order while you were offline."
                  : p.message}
                {p.current
                  ? ` It is now ${STATUS_LABEL[p.current.status] ?? p.current.status}.`
                  : ""}
              </Body>
              <Button
                label="Dismiss"
                tone="quiet"
                small
                onPress={() => void drafts.discard(p.clientActionId)}
              />
            </View>
          ))}
        </Sheet>
      ) : null}

      {q.loading ? (
        <Skeleton lines={6} />
      ) : !q.data ? null : (
        <>
          {q.data.power && q.data.power.status !== "UNKNOWN" ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: S.sm }}>
              <PowerLine power={q.data.power} />
              <Button label="Update power" tone="quiet" small onPress={() => router.push("/shop/printers")} />
            </View>
          ) : (
            <Button label="Report power (light / generator)" tone="quiet" small onPress={() => router.push("/shop/printers")} />
          )}
          <Body muted style={{ marginBottom: S.md }}>
            {q.data.summary.jobs === 0
              ? "The queue is clear."
              : `${q.data.summary.jobs} job${q.data.summary.jobs === 1 ? "" : "s"}, ${q.data.summary.sheets} sheets${q.data.summary.estimatedMinutesToClear ? `, about ${q.data.summary.estimatedMinutesToClear} min to clear` : ""}.`}
          </Body>
          {q.data.items.length === 0 ? (
            <Empty title="No jobs waiting">
              Paid orders appear here as soon as the student pays.
            </Empty>
          ) : null}
          {q.data.items.map((item) => {
            const pending = draftFor(item.id);
            const actions = item.actions.filter((a) => !DEDICATED.has(a));
            return (
              <View key={item.id} testID={`queue-${item.reference}`}>
                <Sheet>
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <Body style={{ fontWeight: "700" }}>
                      {item.position}. {item.reference}
                    </Body>
                    <Pill status={item.status} />
                  </View>
                  <Body muted>
                    {item.studentName}, {item.spec.copies} ×{" "}
                    {item.spec.paperSize}{" "}
                    {item.spec.colourMode === "BW" ? "black & white" : "colour"}
                    ,{" "}
                    {item.spec.sides === "DOUBLE"
                      ? "double-sided"
                      : "single-sided"}
                    , {item.totalSheets} sheets
                  </Body>
                  {pending ? (
                    <Notice tone="warn">{`Draft, not sent: ${STATUS_LABEL[pending.to] ?? pending.to}. Undo it above to choose something else.`}</Notice>
                  ) : reasonFor?.item.id === item.id ? (
                    <View style={{ marginTop: S.md }}>
                      <Field
                        label={`Why? (${ACTION_LABEL[reasonFor.to] ?? reasonFor.to})`}
                        hint="The student sees this."
                        value={reason}
                        onChangeText={setReason}
                        maxLength={1000}
                      />
                      <Button
                        label="Confirm"
                        tone="danger"
                        disabled={reason.trim().length < 3}
                        busy={busy === `${item.id}:${reasonFor.to}`}
                        onPress={() =>
                          void act(item, reasonFor.to, reason.trim())
                        }
                      />
                      <Button
                        label="Back"
                        tone="quiet"
                        small
                        onPress={() => setReasonFor(null)}
                      />
                    </View>
                  ) : actions.length === 0 &&
                    !(
                      item.status === "QUALITY_CHECK" && shop.can("orders.qa")
                    ) ? (
                    <Body muted style={{ marginTop: S.sm }}>
                      {item.status === "PAID"
                        ? "Waiting for a manager to accept this job."
                        : "Your role can't move this job on."}
                    </Body>
                  ) : (
                    <View
                      style={{
                        flexDirection: "row",
                        flexWrap: "wrap",
                        gap: S.sm,
                        marginTop: S.md,
                      }}
                    >
                      {item.status === "QUALITY_CHECK" &&
                      shop.can("orders.qa") ? (
                        <Button
                          label="Passed, ready to collect"
                          small
                          busy={busy === `${item.id}:qa`}
                          disabled={online === false}
                          onPress={() => void passQa(item)}
                        />
                      ) : null}
                      {actions.map((to) => (
                        <Button
                          key={to}
                          small
                          tone={
                            NEEDS_REASON.has(to) ||
                            (item.status === "QUALITY_CHECK" &&
                              to === "PRINTING")
                              ? "quiet"
                              : "primary"
                          }
                          label={
                            item.status === "QUALITY_CHECK" && to === "PRINTING"
                              ? "Failed, reprint"
                              : (ACTION_LABEL[to] ?? STATUS_LABEL[to] ?? to)
                          }
                          busy={busy === `${item.id}:${to}`}
                          onPress={() =>
                            NEEDS_REASON.has(to) ||
                            (item.status === "QUALITY_CHECK" &&
                              to === "PRINTING")
                              ? setReasonFor({ item, to })
                              : void act(item, to)
                          }
                        />
                      ))}
                    </View>
                  )}
                </Sheet>
              </View>
            );
          })}

          {q.data.readyForPickup.length > 0 ? (
            <>
              <H2>Waiting for collection</H2>
              {q.data.readyForPickup.map((r) => (
                <View key={r.id} testID={`ready-${r.reference}`}>
                  <Sheet>
                    <Body style={{ fontWeight: "700" }}>{r.reference}</Body>
                    <Body muted>
                      {r.studentName}, ready {when(r.statusChangedAt)}
                    </Body>
                    <Button
                      label="Collect with code"
                      small
                      onPress={() =>
                        router.push({
                          pathname: "/shop/collect",
                          params: { order: r.id },
                        })
                      }
                    />
                  </Sheet>
                </View>
              ))}
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}
