import * as DocumentPicker from "expo-document-picker";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { Body, Button, Empty, ErrorBox, Notice, Pill, Progress, Screen, Sheet, Skeleton } from "@/components/ui";
import { errorMessage, uploadDocument } from "@/lib/api";
import { S } from "@/lib/theme";
import { useData } from "@/lib/use-data";

interface Doc {
  id: string;
  title: string;
  latestVersion: { id: string; filename: string; status: string; pageCount: number | null; failureReason: string | null; versionNumber: number };
}
interface Upload {
  key: string;
  name: string;
  uri: string;
  mime: string;
  size: number;
  progress: number;
  state: "uploading" | "done" | "failed";
  error?: string;
}

const LABEL: Record<string, string> = { PENDING: "Checking", PROCESSING: "Preparing", READY: "Ready to print", REJECTED: "Rejected", FAILED: "Failed" };

export default function Documents() {
  const { data, error, loading, refresh, refreshing, reload } = useData<{ items: Doc[] }>("/documents", 4000);
  const [uploads, setUploads] = useState<Upload[]>([]);

  const start = (u: Omit<Upload, "progress" | "state">) => {
    setUploads((list) => [...list.filter((x) => x.key !== u.key), { ...u, progress: 0, state: "uploading" }]);
    const set = (patch: Partial<Upload>) => setUploads((list) => list.map((x) => (x.key === u.key ? { ...x, ...patch } : x)));
    uploadDocument(u.uri, u.name, u.mime, (p) => set({ progress: p }))
      .then(() => {
        set({ state: "done", progress: 1 });
        void reload();
      })
      .catch((e: unknown) => set({ state: "failed", error: errorMessage(e) }));
  };

  async function pick() {
    const r = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (r.canceled) return;
    for (const a of r.assets) {
      if ((a.size ?? 0) > 50 * 1024 * 1024) {
        setUploads((l) => [...l, { key: a.uri, name: a.name, uri: a.uri, mime: a.mimeType ?? "", size: a.size ?? 0, progress: 0, state: "failed", error: "This file is larger than 50 MB." }]);
        continue;
      }
      start({ key: `${a.uri}-${Date.now()}`, name: a.name, uri: a.uri, mime: a.mimeType ?? "application/octet-stream", size: a.size ?? 0 });
    }
  }

  return (
    <Screen title="Documents" refreshing={refreshing} onRefresh={refresh}>
      <Button label="Upload a PDF or Word file" onPress={pick} />
      <View style={{ height: S.lg }} />
      {uploads.map((u) => (
        <Sheet key={u.key}>
          <Body style={{ fontWeight: "700" }}>{u.name}</Body>
          {u.state === "uploading" ? (
            <>
              <Body muted>{Math.round(u.progress * 100)}% uploaded</Body>
              <Progress value={u.progress} />
            </>
          ) : u.state === "done" ? (
            <Body muted>Uploaded. We are checking it now.</Body>
          ) : (
            <>
              <Body style={{ color: "#b42318" }}>{u.error}</Body>
              {u.error !== "This file is larger than 50 MB." ? <Button label="Retry" tone="quiet" small onPress={() => start(u)} /> : null}
            </>
          )}
        </Sheet>
      ))}
      <ErrorBox error={error} onRetry={reload} />
      {loading ? (
        <Skeleton lines={4} />
      ) : !data?.items.length ? (
        <Empty title="No documents yet">Upload lecture notes, assignments or project reports. We check each file and count its pages.</Empty>
      ) : (
        data.items.map((d) => (
          <Sheet key={d.id}>
            <Body style={{ fontWeight: "700" }}>{d.title}</Body>
            <Body muted>
              {d.latestVersion.filename}
              {d.latestVersion.pageCount ? `, ${d.latestVersion.pageCount} pages` : ""}
            </Body>
            <View style={{ marginVertical: S.sm }}>
              <Pill status={d.latestVersion.status} label={LABEL[d.latestVersion.status]} />
            </View>
            {d.latestVersion.failureReason ? <Notice tone="warn">{d.latestVersion.failureReason}</Notice> : null}
            {d.latestVersion.status === "READY" ? <Button label="Print this" small onPress={() => router.push({ pathname: "/student/print", params: { document: d.latestVersion.id } })} /> : null}
          </Sheet>
        ))
      )}
    </Screen>
  );
}
