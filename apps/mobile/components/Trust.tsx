import { Switch, Text, View } from "react-native";
import { Body } from "./ui";
import { C, F, naira, S } from "@/lib/theme";

export interface Trust {
  kind: "BUSINESS" | "STUDENT_RUN";
  level: "UNVERIFIED" | "EMAIL_VERIFIED" | "MATRIC_VERIFIED" | "UNIVERSITY_APPROVED";
  badge: { label: string; detail: string; tone: "good" | "caution" | "warn" };
  limits?: { needsAcknowledgement: boolean; orderCapKobo: number | null; listedByDefault: boolean };
}

const TONE: Record<Trust["badge"]["tone"], [string, string]> = {
  good: [C.emeraldWash, C.emeraldDeep],
  caution: [C.amberWash, C.amber],
  warn: [C.redWash, C.red],
};

/** Who is behind a shop, wherever a student is choosing one or looking at an order. */
export function TrustBadge({ trust }: { trust: Trust }) {
  const [bg, fg] = TONE[trust.badge.tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start", marginTop: 4 }}>
      <Text style={{ color: fg, fontFamily: F.bodyBold, fontSize: 13 }}>{trust.badge.label}</Text>
    </View>
  );
}

/** The warning and the switch a student must turn on before using an unproven provider. */
export function UnverifiedProviderNotice({
  trust,
  shopName,
  agreed,
  onAgree,
}: {
  trust: Trust;
  shopName: string;
  agreed: boolean;
  onAgree: (v: boolean) => void;
}) {
  if (!trust.limits?.needsAcknowledgement) return null;
  const cap = trust.limits.orderCapKobo;
  return (
    <View style={{ borderLeftWidth: 3, borderLeftColor: trust.badge.tone === "warn" ? C.red : C.amber, backgroundColor: trust.badge.tone === "warn" ? C.redWash : C.amberWash, padding: S.md, borderRadius: 8, marginTop: S.md }}>
      <Body style={{ fontWeight: "700" }}>{shopName} is a student, not a registered shop.</Body>
      <Body>{trust.badge.detail}</Body>
      <Body muted style={{ fontSize: 13, marginTop: S.sm }}>
        They will be able to open your document. Do not send anything you would not show them in person.
        {cap !== null ? ` Orders here are capped at ${naira(cap)} until their matric number is confirmed.` : ""}
      </Body>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: S.md }}>
        <Body>I understand, use this shop</Body>
        <Switch accessibilityLabel="I understand, use this shop" value={agreed} onValueChange={onAgree} trackColor={{ true: C.emerald, false: C.rule }} />
      </View>
    </View>
  );
}
