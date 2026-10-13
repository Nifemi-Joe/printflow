import { router } from "expo-router";
import { Pressable } from "react-native";
import { Body, Button, Empty, ErrorBox, Screen, Skeleton, st } from "@/components/ui";
import { api } from "@/lib/api";
import { when } from "@/lib/theme";
import { useData } from "@/lib/use-data";

interface Note {
  id: string;
  title: string;
  body: string;
  orderId: string | null;
  readAt: string | null;
  createdAt: string;
}

export default function Notifications() {
  const { data, error, loading, refresh, refreshing, reload } = useData<{ items: Note[]; unread: number }>("/notifications", 15_000);
  return (
    <Screen
      title="Alerts"
      refreshing={refreshing}
      onRefresh={refresh}
      right={data && data.unread > 0 ? <Button label="Mark read" tone="quiet" small onPress={async () => (await api("/notifications/read-all", { method: "POST" }), void reload())} /> : null}
    >
      <ErrorBox error={error} onRetry={reload} />
      {loading ? (
        <Skeleton />
      ) : !data?.items.length ? (
        <Empty title="Nothing new">We let you know here when documents are ready and orders move along.</Empty>
      ) : (
        data.items.map((n) => (
          <Pressable
            key={n.id}
            accessibilityRole={n.orderId ? "button" : undefined}
            onPress={() => n.orderId && router.push({ pathname: "/order/[id]", params: { id: n.orderId } })}
            style={st.sheet}
          >
            <Body style={{ fontWeight: n.readAt ? "400" : "700" }}>{n.title}</Body>
            <Body muted>{n.body}</Body>
            <Body muted style={{ fontSize: 13 }}>
              {when(n.createdAt)}
            </Body>
          </Pressable>
        ))
      )}
    </Screen>
  );
}
