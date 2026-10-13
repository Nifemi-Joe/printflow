import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { Body, Button, Empty, ErrorBox, Pill, Screen, Skeleton, st } from "@/components/ui";
import { naira, S } from "@/lib/theme";
import { useData } from "@/lib/use-data";

interface Row {
  id: string;
  reference: string;
  status: string;
  totalKobo: string;
  shopName: string;
  documentTitle: string;
}

export default function Orders() {
  const { data, error, loading, refresh, refreshing, reload } = useData<{ items: Row[] }>("/orders", 10_000);
  return (
    <Screen title="Orders" refreshing={refreshing} onRefresh={refresh} right={<Button label="Account" tone="quiet" small onPress={() => router.push("/account")} />}>
      <ErrorBox error={error} onRetry={reload} />
      {loading ? (
        <Skeleton lines={5} />
      ) : !data?.items.length ? (
        <Empty title="No orders yet">Upload a document, then choose a shop and get your price.</Empty>
      ) : (
        data.items.map((o) => (
          <Pressable key={o.id} accessibilityRole="button" accessibilityLabel={`${o.documentTitle}, ${o.status}`} onPress={() => router.push({ pathname: "/order/[id]", params: { id: o.id } })} style={st.sheet}>
            <Body style={{ fontWeight: "700" }}>{o.documentTitle}</Body>
            <Body muted>
              {o.reference}, {o.shopName}
            </Body>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: S.sm }}>
              <Pill status={o.status} />
              <Body>{naira(o.totalKobo)}</Body>
            </View>
          </Pressable>
        ))
      )}
    </Screen>
  );
}
