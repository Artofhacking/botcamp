import type { WorkspaceBundle } from "./types";

type BotOk<T> = T & { ok?: boolean; error?: { message?: string } };

async function bot<T>(
  endpoint: string,
  payload: unknown = null,
): Promise<T> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = localStorage.getItem("botcamp_token");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch("api/bot", {
    method: "POST",
    headers,
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify({ endpoint, payload }),
  });
  const data = (await res.json().catch(() => ({}))) as BotOk<T>;
  if (!res.ok || data.ok === false) {
    const message =
      (data.error && typeof data.error.message === "string"
        ? data.error.message
        : null) || `请求失败 (${res.status})`;
    const err = new Error(message);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return data;
}

export type DemoUser = { username: string; display_name: string };

export type AuthUser = {
  owner_user_id: string;
  username: string | null;
  display_name: string | null;
};

export async function fetchDemoUsers(): Promise<DemoUser[]> {
  const data = await bot<{ users: DemoUser[] }>("media/demo-users");
  return data.users;
}

export async function login(
  username: string,
): Promise<AuthUser & { token: string }> {
  const data = await bot<{
    owner_user_id: string;
    username: string;
    display_name: string;
    token: string;
  }>("media/login", { username });
  localStorage.setItem("botcamp_token", data.token);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await bot("media/logout", {});
  } finally {
    localStorage.removeItem("botcamp_token");
  }
}

export async function fetchMe(): Promise<AuthUser> {
  return bot<AuthUser>("media/me");
}

export async function fetchWorkspace(): Promise<WorkspaceBundle> {
  const data = await bot<{ workspace: WorkspaceBundle }>("media/workspace");
  return data.workspace;
}

export async function fetchManuscript(
  accountId: string,
  manuscriptId: string,
): Promise<{
  manuscript: { title: string; status: string };
  body: string | null;
  published_edition: string | null;
}> {
  return bot("media/manuscript", { accountId, manuscriptId });
}
