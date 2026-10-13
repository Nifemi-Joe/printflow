"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { ErrorNotice, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { METHOD_LABEL, naira } from "@/lib/format";
import { useRequireSession } from "@/lib/session";
import { useData } from "@/lib/use-data";

type Method = "CARD" | "BANK_TRANSFER" | "USSD";

interface TestPayment {
  amountKobo: number;
  orderId: string;
  orderReference: string;
  shopName: string;
  status: string;
  requestedMethod: Method | null;
  simulated: {
    bankTransfer: { bank: string; accountNumber: string; accountName: string; note: string };
    ussd: { code: string; note: string };
  };
}

/**
 * Simulated checkout used only when the API runs with PAYMENT_PROVIDER=TEST.
 * It mirrors what Paystack shows for each method, with obviously fake details.
 */
function Checkout() {
  useRequireSession();
  const { reference } = useParams<{ reference: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const { data, error, loading } = useData<TestPayment>(`/test-payments/${reference}`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [picked, setPicked] = useState<Method | null>(null);
  const method: Method = picked ?? data?.requestedMethod ?? (params.get("method") as Method | null) ?? "CARD";
  const locked = Boolean(data?.requestedMethod);

  const complete = async (outcome: "success" | "failed") => {
    setBusy(true);
    try {
      const r = await api<{ orderId: string }>(`/test-payments/${reference}/complete`, { method: "POST", body: { outcome, method } });
      router.replace(`/student/orders/${r.orderId}`);
    } catch (e) {
      setActionError(e);
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Test payment">
      <div className="notice notice-warn">
        <p>This is a simulated checkout for testing. No money moves, and the account number and USSD code below are not real.</p>
      </div>
      <ErrorNotice error={error ?? actionError} />
      {loading ? (
        <Skeleton />
      ) : (
        data && (
          <>
            <div className="ticket" style={{ marginBottom: "1.5rem" }}>
              <div className="ticket-line">
                <span>Order</span>
                <span className="num">{data.orderReference}</span>
              </div>
              <div className="ticket-line">
                <span>Shop</span>
                <span>{data.shopName}</span>
              </div>
              <div className="ticket-total">
                <span>Amount</span>
                <span className="num">{naira(data.amountKobo)}</span>
              </div>
            </div>

            {!locked && (
              <div className="choice-row" role="radiogroup" aria-label="Payment method" style={{ marginBottom: "1rem" }}>
                {(["CARD", "BANK_TRANSFER", "USSD"] as const).map((m) => (
                  <label className="choice" key={m}>
                    <input type="radio" name="m" checked={method === m} onChange={() => setPicked(m)} />
                    <span>{METHOD_LABEL[m]}</span>
                  </label>
                ))}
              </div>
            )}

            <section className="sheet" aria-labelledby="how-title" style={{ marginBottom: "1.5rem" }}>
              <h2 id="how-title" style={{ fontSize: "var(--t-lg)" }}>
                {METHOD_LABEL[method]}
              </h2>
              {method === "BANK_TRANSFER" && (
                <>
                  <p>Transfer exactly {naira(data.amountKobo)} to:</p>
                  <dl className="ticket" style={{ margin: 0 }}>
                    <div className="ticket-line">
                      <dt>Bank</dt>
                      <dd>{data.simulated.bankTransfer.bank}</dd>
                    </div>
                    <div className="ticket-line">
                      <dt>Account number</dt>
                      <dd className="num">{data.simulated.bankTransfer.accountNumber}</dd>
                    </div>
                    <div className="ticket-line">
                      <dt>Account name</dt>
                      <dd>{data.simulated.bankTransfer.accountName}</dd>
                    </div>
                  </dl>
                  <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                    {data.simulated.bankTransfer.note}
                  </p>
                </>
              )}
              {method === "USSD" && (
                <>
                  <p>Dial this from the phone linked to your bank account:</p>
                  <p className="num" style={{ fontSize: "var(--t-2xl)", fontWeight: 700 }}>
                    {data.simulated.ussd.code}
                  </p>
                  <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                    {data.simulated.ussd.note}
                  </p>
                </>
              )}
              {method === "CARD" && <p>In live mode you enter your card details on Paystack&apos;s secure page.</p>}
            </section>

            {data.status === "INITIATED" ? (
              <div className="row">
                <button className="btn btn-primary" disabled={busy} onClick={() => complete("success")}>
                  {method === "CARD" ? "Simulate successful payment" : method === "BANK_TRANSFER" ? "Simulate: I've sent the transfer" : "Simulate: USSD payment approved"}
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => complete("failed")}>
                  Simulate failed payment
                </button>
              </div>
            ) : (
              <p>This payment is already {data.status.toLowerCase()}.</p>
            )}
          </>
        )
      )}
    </AuthFrame>
  );
}

export default function TestCheckout() {
  return (
    <Suspense>
      <Checkout />
    </Suspense>
  );
}
