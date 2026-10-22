import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Text, View } from "react-native";
import { Body, Button, Choice, Empty, ErrorBox, Field, H2, Line, Notice, Screen, Sheet, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { C, F, METHOD_HINT, METHOD_LABEL, naira, S, when } from "@/lib/theme";
import { useData } from "@/lib/use-data";

type Method = "CARD" | "BANK_TRANSFER" | "USSD";

interface Wallet {
    cashKobo: number;
    promoKobo: number;
    totalKobo: number;
    limits: { maxBalanceKobo: number; topupMinKobo: number; topupMaxKobo: number };
    topUp: { available: boolean; mode: string; methods: Method[] };
    pendingTopups: Array<{ reference: string; amountKobo: number }>;
    entries: Array<{ id: number; label: string; amountKobo: number; orderReference: string | null; note: string | null; kind: string; createdAt: string }>;
    terms: string;
}

const QUICK = [500, 1000, 2000, 5000];
const whole = (kobo: number) => naira(kobo).replace(/\.00$/, "");

/** Student wallet: balance, top-up, and activity. Spend-only: it cannot be withdrawn. */
export default function WalletScreen() {
    const { data: w, error, loading, refresh, refreshing, reload } = useData<Wallet>("/me/wallet", 15_000);
    const [amount, setAmount] = useState("1000");
    const [method, setMethod] = useState<Method | null>(null);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<unknown>(null);

    if (loading || !w)
        return (
            <Screen title="Wallet">
                <ErrorBox error={error} onRetry={reload} />
                <Skeleton lines={6} />
            </Screen>
        );

    const kobo = Math.round(Number(amount) * 100);
    const valid = Number.isInteger(Number(amount)) && kobo >= w.limits.topupMinKobo && kobo <= w.limits.topupMaxKobo;
    const chosen = method ?? w.topUp.methods[0] ?? "CARD";

    const topUp = async () => {
        setBusy(true);
        setActionError(null);
        try {
            const r = await api<{ checkoutUrl: string }>("/me/wallet/topups", { method: "POST", body: { amountKobo: kobo, method: chosen } });
            await WebBrowser.openBrowserAsync(r.checkoutUrl);
            await reload();
        } catch (e) {
            setActionError(e);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Screen title="Wallet" refreshing={refreshing} onRefresh={refresh}>
            <Sheet style={{ borderColor: C.emerald }}>
                <Body muted>Balance</Body>
                <Text accessibilityLabel={`Wallet balance ${naira(w.totalKobo)}`} style={{ fontFamily: F.displayHeavy, fontSize: 40, color: C.emeraldDeep, marginVertical: S.sm }}>
                    {naira(w.totalKobo)}
                </Text>
                {w.promoKobo > 0 ? (
                    <>
                        <Line left="Your money" right={naira(w.cashKobo)} />
                        <Line left="Print credit from your university" right={naira(w.promoKobo)} />
                    </>
                ) : null}
                <Body muted style={{ marginTop: S.sm, fontSize: 13 }}>
                    {w.terms}
                </Body>
            </Sheet>

            <Sheet>
                <H2>Top up</H2>
                {!w.topUp.available ? (
                    <Body muted>Top-ups are not available yet: payments have not been set up.</Body>
                ) : w.limits.topupMaxKobo < w.limits.topupMinKobo ? (
                    <Body muted>Your wallet is at its {whole(w.limits.maxBalanceKobo)} limit.</Body>
                ) : (
                    <>
                        <Choice
                            label="Amount"
                            value={QUICK.includes(Number(amount)) ? amount : ""}
                            onChange={(v) => setAmount(v)}
                            options={QUICK.filter((n) => n * 100 <= w.limits.topupMaxKobo).map((n) => ({ value: String(n), label: whole(n * 100) }))}
                        />
                        <Field
                            label="Or type an amount (₦)"
                            keyboardType="number-pad"
                            value={amount}
                            onChangeText={(t) => setAmount(t.replace(/[^\d]/g, ""))}
                            hint={`Between ${whole(w.limits.topupMinKobo)} and ${whole(w.limits.topupMaxKobo)}.`}
                        />
                        {w.topUp.methods.length > 1 ? (
                            <Choice label="Pay with" value={chosen} onChange={setMethod} options={w.topUp.methods.map((m) => ({ value: m, label: METHOD_LABEL[m] ?? m }))} />
                        ) : null}
                        <Body muted style={{ marginBottom: S.md }}>
                            {METHOD_HINT[chosen]}
                        </Body>
                        <ErrorBox error={actionError} />
                        <Button label={valid ? `Top up ${whole(kobo)}` : "Top up"} disabled={!valid} busy={busy} onPress={() => void topUp()} />
                    </>
                )}
                {w.pendingTopups.length > 0 ? (
                    <View style={{ marginTop: S.md }}>
                        <Notice tone="warn">Waiting for confirmation: {w.pendingTopups.map((p) => naira(p.amountKobo)).join(", ")}. If you paid, it appears here automatically.</Notice>
                    </View>
                ) : null}
                {w.topUp.mode === "TEST" ? <Body muted>Test mode: top-ups use the simulated checkout. No money moves.</Body> : null}
            </Sheet>

            <Sheet>
                <H2>Activity</H2>
                {w.entries.length === 0 ? (
                    <Empty title="Nothing yet">Top up, then switch on &quot;Use my wallet&quot; when you pay for a print.</Empty>
                ) : (
                    w.entries.map((e) => (
                        <View key={e.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: S.sm, borderBottomWidth: 1, borderBottomColor: C.rule }}>
                            <View style={{ flex: 1, paddingRight: S.md }}>
                                <Body style={{ fontWeight: "700" }}>
                                    {e.label}
                                    {e.orderReference ? ` ${e.orderReference}` : ""}
                                </Body>
                                <Body muted style={{ fontSize: 13 }}>
                                    {when(e.createdAt)}
                                    {(e.kind === "PROMO_GRANT" || e.kind === "PROMO_REVOKE") && e.note ? `, ${e.note}` : ""}
                                </Body>
                            </View>
                            <Text style={{ fontFamily: F.bodyBold, color: e.amountKobo > 0 ? C.emeraldDeep : C.graphite }}>
                                {e.amountKobo > 0 ? "+" : "−"}
                                {naira(Math.abs(e.amountKobo))}
                            </Text>
                        </View>
                    ))
                )}
            </Sheet>
        </Screen>
    );
}
