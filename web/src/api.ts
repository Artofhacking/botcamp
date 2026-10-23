import type { WorkspaceBundle } from "./types";

export async function fetchWorkspace(): Promise<WorkspaceBundle> {
  const res = await fetch("/api/me/workspace");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`加载失败 (${res.status}): ${text}`);
  }
  return res.json();
}

export async function fetchManuscript(
  accountId: string,
  manuscriptId: string,
): Promise<{
  manuscript: { title: string; status: string };
  body: string | null;
  published_edition: string | null;
}> {
  const res = await fetch(
    `/api/accounts/${accountId}/manuscripts/${manuscriptId}`,
  );
  if (!res.ok) throw new Error("稿件加载失败");
  return res.json();
}
