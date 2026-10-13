import { router } from "expo-router";
import { Body, Button, ErrorBox, Screen, Sheet, Skeleton } from "@/components/ui";
import { naira } from "@/lib/theme";
import { useSession } from "@/lib/session";
import { useData } from "@/lib/use-data";

/** University and platform staff get a read-only summary on mobile; full controls are on the web. */
export default function Overview() {
  const { me } = useSession();
  const uni = me?.universityRoles[0];
  const uniData = useData<{ ordersLast30DaysByStatus: Array<{ status: string; n: number }>; paymentsLast30DaysKobo: number; openDisputes: number; shopsByStatus: Array<{ status: string; n: number }> }>(
    uni ? `/admin/universities/${uni.universityId}/overview` : null,
  );
  const platform = useData<{ checkout: string; deadJobs: unknown[]; webhooksLast24h: { total: number; invalidSignatures: number } }>(me?.user.platformRole ? "/platform/health" : null);

  return (
    <Screen title="Overview" onRefresh={() => (void uniData.refresh(), void platform.refresh())} refreshing={uniData.refreshing || platform.refreshing}>
      <ErrorBox error={uniData.error ?? platform.error} />
      {uni ? (
        <Sheet>
          <Body style={{ fontWeight: "700" }}>{uni.universityName}</Body>
          {uniData.loading || !uniData.data ? (
            <Skeleton />
          ) : (
            <>
              <Body>Paid in the last 30 days: {naira(uniData.data.paymentsLast30DaysKobo)}</Body>
              <Body>Orders: {uniData.data.ordersLast30DaysByStatus.reduce((s, x) => s + x.n, 0)}</Body>
              <Body>Open disputes: {uniData.data.openDisputes}</Body>
              <Body>Shops waiting for approval: {uniData.data.shopsByStatus.find((s) => s.status === "PENDING_APPROVAL")?.n ?? 0}</Body>
            </>
          )}
        </Sheet>
      ) : null}
      {me?.user.platformRole && platform.data ? (
        <Sheet>
          <Body style={{ fontWeight: "700" }}>Platform</Body>
          <Body>Checkout: {platform.data.checkout.toLowerCase()}</Body>
          <Body>Failed background jobs: {platform.data.deadJobs.length}</Body>
          <Body>
            Webhooks today: {platform.data.webhooksLast24h.total} ({platform.data.webhooksLast24h.invalidSignatures} with bad signatures)
          </Body>
        </Sheet>
      ) : null}
      <Body muted>Approvals, prices, refunds and staff are managed on the PrintFlow website.</Body>
      <Button label="Account" tone="quiet" onPress={() => router.push("/account")} />
    </Screen>
  );
}
