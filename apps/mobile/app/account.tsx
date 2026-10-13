import { router } from "expo-router";
import { Body, Button, H2, Notice, Screen, Sheet } from "@/components/ui";
import { PhoneVerify } from "@/components/PhoneVerify";
import { useSession } from "@/lib/session";
import { S } from "@/lib/theme";

export default function Account() {
  const { me, signOut, refresh } = useSession();
  return (
    <Screen title="Account">
      <Sheet>
        <Body style={{ fontWeight: "700" }}>{me?.user.fullName}</Body>
        <Body muted>
          {me?.user.email}
          {me && !me.user.emailVerified ? " (not confirmed)" : ""}
        </Body>
        {me?.student ? (
          <Body muted>
            {me.student.universityName}, {me.student.campusName}
          </Body>
        ) : null}
      </Sheet>

      {me?.student && !me.user.emailVerified && !me.user.phoneVerified ? (
        <Notice tone="warn">Confirm your phone number below (or your email) to place orders.</Notice>
      ) : null}

      <Sheet>
        <H2>Phone number</H2>
        <Body muted style={{ marginBottom: S.md }}>
          Sign in with a texted code, and get a text when your prints are ready.
        </Body>
        {me ? <PhoneVerify phone={me.user.phone} verified={me.user.phoneVerified} onVerified={refresh} /> : null}
      </Sheet>

      <Body muted style={{ marginBottom: S.lg }}>
        Change your password, download your data or request erasure from the PrintFlow website.
      </Body>
      {me?.student && me.shopMemberships.length > 0 ? <Button label="Switch to shop" tone="quiet" onPress={() => router.replace("/shop/queue")} /> : null}
      {me?.shopMemberships.length && me.student ? <Button label="Switch to my printing" tone="quiet" onPress={() => router.replace("/student/orders")} /> : null}
      <Button
        label="Sign out"
        tone="danger"
        onPress={async () => {
          await signOut();
          router.replace("/login");
        }}
      />
    </Screen>
  );
}
