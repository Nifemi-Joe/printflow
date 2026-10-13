import { View } from "react-native";
import { Body, Pill } from "@/components/ui";
import { powerSummary, type Power, S } from "@/lib/theme";

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

/** The shop's reported power, e.g. "Light out, back about 2:00 pm". Hidden when never reported. */
export function PowerLine({ power, showWho }: { power: Power | null | undefined; showWho?: boolean }) {
  if (!power || power.status === "UNKNOWN") return null;
  return (
    <View style={{ marginTop: S.xs, gap: 2 }}>
      <Pill status={power.status === "OUTAGE" ? "FAULT" : "READY"} label={powerSummary(power)} />
      {power.note ? <Body muted>{power.note}</Body> : null}
      {power.updatedAt ? (
        <Body muted style={{ fontSize: 13 }}>
          {power.stale ? "Reported" : "Updated"} {ago(power.updatedAt)}
          {showWho && power.updatedBy ? ` by ${power.updatedBy}` : ""}
          {power.stale ? ", may be out of date" : ""}
        </Body>
      ) : null}
    </View>
  );
}
