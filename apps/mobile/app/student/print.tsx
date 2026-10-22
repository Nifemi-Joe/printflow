import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Body, Button, Choice, Empty, ErrorBox, Field, H2, Line, Notice, Screen, Sheet, Skeleton, st } from "@/components/ui";
import { api, idempotencyKey } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PowerLine } from "@/components/PowerLine";
import { TrustBadge, UnverifiedProviderNotice, type Trust } from "@/components/Trust";
import { C, METHOD_HINT, METHOD_LABEL, naira, type Power, S } from "@/lib/theme";
import { useData } from "@/lib/use-data";

interface Doc {
  title: string;
  latestVersion: { id: string; status: string; pageCount: number | null };
}
interface Shop {
  id: string;
  name: string;
  acceptingOrders: boolean;
  pickupLocations: Array<{ id: string; name: string }>;
  queue: { jobsAhead: number; estimatedMinutes: number | null };
  power: Power | null;
  trust: Trust;
}
interface PriceList {
  configured: boolean;
  message?: string;
  sheetPrices?: Array<{ paperSize: string; colourMode: string; sides: string }>;
  finishing?: Array<{ code: string; name: string; price: number; unit: string; paperSizes?: string[] }>;
}
interface Quote {
  id: string;
  provider?: Trust & { needsAcknowledgement: boolean; orderCapKobo: number | null };
  lines: Array<{ code: string; description: string; quantity: number; amount: number }>;
  serviceFeeKobo: number;
  totalKobo: number;
  expiresAt: string;
  checkout: "LIVE" | "TEST" | "DISABLED";
  paymentMethods: Method[];
}

type Method = "CARD" | "BANK_TRANSFER" | "USSD";

export default function Print() {
  const params = useLocalSearchParams<{ document?: string }>();
  const { me } = useSession();
  const docs = useData<{ items: Doc[] }>("/documents");
  const [showUnverified, setShowUnverified] = useState(false);
  const [agreedToProvider, setAgreedToProvider] = useState(false);
  const shops = useData<{ items: Shop[]; hiddenUnverified: number }>(
      me?.student ? `/universities/${me.student.universityId}/shops${showUnverified ? "?includeUnverified=true" : ""}` : null,
  );
  const [versionId, setVersionId] = useState(params.document ?? "");
  const [shopId, setShopId] = useState("");
  const prices = useData<PriceList>(shopId ? `/shops/${shopId}/price-list` : null);
  const [copies, setCopies] = useState("1");
  const [ranges, setRanges] = useState("");
  const [paperSize, setPaperSize] = useState("A4");
  const [colourMode, setColourMode] = useState("BW");
  const [sides, setSides] = useState("SINGLE");
  const [finishing, setFinishing] = useState<string[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [method, setMethod] = useState<Method>("CARD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => setQuote(null), [versionId, shopId, copies, ranges, paperSize, colourMode, sides, finishing]);
  useEffect(() => {
    if (params.document) setVersionId(params.document);
  }, [params.document]);

  const ready = docs.data?.items.filter((d) => d.latestVersion.status === "READY") ?? [];
  const shop = shops.data?.items.find((s) => s.id === shopId);
  const offered = useMemo(() => {
    const sp = prices.data?.sheetPrices ?? [];
    return {
      sizes: [...new Set(sp.map((s) => s.paperSize))],
      colours: [...new Set(sp.filter((s) => s.paperSize === paperSize).map((s) => s.colourMode))],
      sides: [...new Set(sp.filter((s) => s.paperSize === paperSize && s.colourMode === colourMode).map((s) => s.sides))],
      finishing: (prices.data?.finishing ?? []).filter((f) => !f.paperSizes || f.paperSizes.includes(paperSize)),
    };
  }, [prices.data, paperSize, colourMode]);

  async function getQuote() {
    setBusy(true);
    setError(null);
    try {
      const q = await api<Quote>("/quotes", {
        method: "POST",
        body: { documentVersionId: versionId, shopId, spec: { copies: Number(copies) || 1, pageRanges: ranges.trim() || undefined, paperSize, colourMode, sides, finishingCodes: finishing } },
      });
      setQuote(q);
      if (!q.paymentMethods.includes(method)) setMethod(q.paymentMethods[0] ?? "CARD");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!quote || !shop?.pickupLocations[0]) return;
    setBusy(true);
    setError(null);
    try {
      const order = await api<{ id: string }>("/orders", {
        method: "POST",
        body: {
          quoteId: quote.id,
          pickupLocationId: shop.pickupLocations[0].id,
          ...(quote.provider?.needsAcknowledgement ? { acknowledgeUnverifiedProvider: agreedToProvider } : {}),
        },
        headers: { "Idempotency-Key": idempotencyKey() },
      });
      if (quote.checkout !== "DISABLED") {
        const pay = await api<{ checkoutUrl: string }>(`/orders/${order.id}/payments`, { method: "POST", body: { method } });
        // The provider's checkout opens in the system browser; the order screen refreshes on return.
        await WebBrowser.openBrowserAsync(pay.checkoutUrl);
      }
      router.push({ pathname: "/order/[id]", params: { id: order.id } });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (docs.loading || shops.loading)
    return (
        <Screen title="Print">
          <Skeleton lines={6} />
        </Screen>
    );

  return (
      <Screen title="Print">
        <ErrorBox error={error} />
        {ready.length === 0 ? (
            <Empty title="Nothing ready to print">Upload a document first. It is ready once it has been checked.</Empty>
        ) : (
            <>
              <H2>Document</H2>
              {ready.map((d) => (
                  <Pressable
                      key={d.latestVersion.id}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: versionId === d.latestVersion.id }}
                      onPress={() => setVersionId(d.latestVersion.id)}
                      style={[st.chip, { marginBottom: S.sm, paddingVertical: S.md }, versionId === d.latestVersion.id && { borderColor: C.emerald, backgroundColor: C.emeraldWash }]}
                  >
                    <Body>
                      {d.title} ({d.latestVersion.pageCount} pages)
                    </Body>
                  </Pressable>
              ))}
              <H2>Shop</H2>
              {shops.data?.items.map((s) => (
                  <Pressable
                      key={s.id}
                      disabled={!s.acceptingOrders}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: shopId === s.id, disabled: !s.acceptingOrders }}
                      onPress={() => setShopId(s.id)}
                      style={[st.chip, { marginBottom: S.sm, paddingVertical: S.md }, shopId === s.id && { borderColor: C.emerald, backgroundColor: C.emeraldWash }, !s.acceptingOrders && { opacity: 0.5 }]}
                  >
                    <Body style={{ fontWeight: "700" }}>{s.name}</Body>
                    <Body muted>
                      {!s.acceptingOrders ? "Not taking orders now" : s.queue.jobsAhead === 0 ? "No queue" : `${s.queue.jobsAhead} jobs ahead${s.queue.estimatedMinutes ? `, about ${s.queue.estimatedMinutes} min` : ""}`}
                    </Body>
                    <PowerLine power={s.power} />
                    <TrustBadge trust={s.trust} />
                  </Pressable>
              ))}
              {(shops.data?.hiddenUnverified ?? 0) > 0 && !showUnverified ? (
                  <Button
                      tone="quiet"
                      small
                      label={`Show ${shops.data!.hiddenUnverified} unverified student${shops.data!.hiddenUnverified === 1 ? "" : "s"}`}
                      onPress={() => setShowUnverified(true)}
                  />
              ) : null}
              {shopId && prices.data && !prices.data.configured ? <Notice tone="warn">{prices.data.message}</Notice> : null}
              {shopId && prices.data?.configured ? (
                  <View style={{ marginTop: S.lg }}>
                    <Field label="Pages to print" hint="Leave empty for all pages, or e.g. 1-5, 8" value={ranges} onChangeText={setRanges} />
                    <Field label="Copies" value={copies} onChangeText={setCopies} keyboardType="number-pad" maxLength={3} />
                    <Choice label="Paper size" value={paperSize} onChange={setPaperSize} options={offered.sizes.map((v) => ({ value: v, label: v }))} />
                    <Choice label="Colour" value={colourMode} onChange={setColourMode} options={offered.colours.map((v) => ({ value: v, label: v === "BW" ? "Black & white" : "Colour" }))} />
                    <Choice label="Sides" value={sides} onChange={setSides} options={offered.sides.map((v) => ({ value: v, label: v === "SINGLE" ? "Single-sided" : "Double-sided" }))} />
                    {offered.finishing.map((f) => {
                      const on = finishing.includes(f.code);
                      return (
                          <Pressable
                              key={f.code}
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked: on }}
                              onPress={() => setFinishing(on ? finishing.filter((c) => c !== f.code) : [...finishing, f.code])}
                              style={[st.chip, { marginBottom: S.sm }, on && { borderColor: C.emerald, backgroundColor: C.emeraldWash }]}
                          >
                            <Body>
                              {on ? "✓ " : ""}
                              {f.name} ({naira(f.price)} {f.unit === "PER_COPY" ? "per copy" : f.unit === "PER_SHEET" ? "per sheet" : "per order"})
                            </Body>
                          </Pressable>
                      );
                    })}
                    <View style={{ height: S.md }} />
                    <Button label="Get exact price" onPress={getQuote} busy={busy && !quote} disabled={!versionId} />
                  </View>
              ) : null}
              {quote ? (
                  <Sheet style={{ marginTop: S.xl }}>
                    <H2>Your price</H2>
                    {quote.lines.map((l) => (
                        <Line key={l.code} left={`${l.description}${l.quantity > 1 ? ` × ${l.quantity}` : ""}`} right={naira(l.amount)} />
                    ))}
                    <Line left="Service fee" right={naira(quote.serviceFeeKobo)} />
                    <Line strong left="Total" right={naira(quote.totalKobo)} />
                    <Body muted>Held until {new Date(quote.expiresAt).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}. Collect from {shop?.pickupLocations[0]?.name}.</Body>
                    {shop?.power?.status === "OUTAGE" ? <Notice tone="warn">{`${shop.name} has reported no power. You can still order; printing starts when power is back.`}</Notice> : null}
                    {quote.checkout !== "DISABLED" && quote.paymentMethods.length > 1 ? (
                        <View style={{ marginVertical: S.md }} accessibilityRole="radiogroup" accessibilityLabel="Pay with">
                          <H2>Pay with</H2>
                          {quote.paymentMethods.map((m) => (
                              <Pressable
                                  key={m}
                                  accessibilityRole="radio"
                                  accessibilityState={{ checked: method === m }}
                                  onPress={() => setMethod(m)}
                                  style={[st.chip, { marginBottom: S.sm, paddingVertical: S.md }, method === m && { borderColor: C.emerald, backgroundColor: C.emeraldWash }]}
                              >
                                <Body style={{ fontWeight: "700" }}>{METHOD_LABEL[m]}</Body>
                                <Body muted>{METHOD_HINT[m]}</Body>
                              </Pressable>
                          ))}
                        </View>
                    ) : null}
                    {quote.checkout === "TEST" ? <Notice tone="warn">Test mode: payment is simulated and no money moves.</Notice> : null}
                    {quote.checkout === "DISABLED" ? <Notice tone="warn">Online payment is not switched on yet, so this order cannot be paid at the moment.</Notice> : null}
                    {shop ? <UnverifiedProviderNotice trust={shop.trust} shopName={shop.name} agreed={agreedToProvider} onAgree={setAgreedToProvider} /> : null}
                    <Button
                        label={`Confirm and pay ${naira(quote.totalKobo)}`}
                        onPress={confirm}
                        busy={busy}
                        disabled={Boolean(quote.provider?.needsAcknowledgement) && !agreedToProvider}
                    />
                  </Sheet>
              ) : null}
            </>
        )}
      </Screen>
  );
}
