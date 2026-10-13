"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { RateCardForm, RateCardView, type RateCard } from "@/components/RateCardEditor";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { naira, SPEC_LABEL } from "@/lib/format";
import { useData } from "@/lib/use-data";

export default function ShopPricing() {
  const { shopId } = useParams<{ shopId: string }>();
  const own = useData<{ pricingMode: string; items: RateCard[]; bounds: { sheet: Array<{ paperSize: string; colourMode: string; sides: string; min: number; max: number }> } | null }>(`/shops/${shopId}/rate-cards`);
  const pub = useData<{ configured: boolean; message?: string; sheetPrices?: RateCard["sheetPrices"] }>(`/shops/${shopId}/price-list`);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  if (own.loading) return <Skeleton />;
  if (own.error) return <ErrorNotice error={own.error} onRetry={own.reload} />;
  const merchant = own.data?.pricingMode === "MERCHANT_CONTROLLED";

  return (
    <>
      <PageHead title="Prices" />
      {done && (
        <div className="notice" role="status">
          <p>{done}</p>
        </div>
      )}
      <ErrorNotice error={error} />
      {!merchant ? (
        <div className="sheet">
          <p>Your university sets prices for every shop on campus. This is what students are charged at your shop:</p>
          {pub.data?.configured ? (
            <ul>
              {pub.data.sheetPrices?.map((s) => (
                <li key={`${s.paperSize}${s.colourMode}${s.sides}`}>
                  {s.paperSize} {SPEC_LABEL[s.colourMode]?.toLowerCase()}, {SPEC_LABEL[s.sides]?.toLowerCase()}: {naira(s.pricePerSheet)} per sheet
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{pub.data?.message}</p>
          )}
        </div>
      ) : (
        <>
          {own.data?.bounds ? (
            <div className="notice">
              <p>
                Your university allows these ranges:{" "}
                {own.data.bounds.sheet.map((b) => `${b.paperSize} ${SPEC_LABEL[b.colourMode]?.toLowerCase()} ${SPEC_LABEL[b.sides]?.toLowerCase()} ${naira(b.min)} to ${naira(b.max)}`).join("; ")}.
              </p>
            </div>
          ) : (
            <div className="notice notice-warn">
              <p>Your university has not agreed price ranges yet, so you cannot publish prices.</p>
            </div>
          )}
          <div className="grid-2" style={{ alignItems: "start" }}>
            <div className="stack">
              {own.data?.items.map((c) => (
                <RateCardView
                  key={c.id}
                  card={c}
                  actions={
                    c.status === "DRAFT" && (
                      <button
                        className="btn btn-primary btn-small"
                        onClick={async () => {
                          setError(null);
                          try {
                            await api(`/shops/${shopId}/rate-cards/${c.id}/publish`, { method: "POST" });
                            setDone(`Version ${c.version} published.`);
                            await own.reload();
                          } catch (e) {
                            setError(e);
                          }
                        }}
                      >
                        Publish
                      </button>
                    )
                  }
                />
              ))}
            </div>
            <RateCardForm
              base={own.data?.items.find((c) => c.status === "PUBLISHED")}
              onSubmit={async (d) => {
                setError(null);
                try {
                  await api(`/shops/${shopId}/rate-cards`, { method: "POST", body: d });
                  setDone("Draft saved. Publish it to start using it.");
                  await own.reload();
                } catch (e) {
                  setError(e);
                }
              }}
            />
          </div>
        </>
      )}
    </>
  );
}
