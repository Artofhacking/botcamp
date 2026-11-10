import { Trans, useLingui } from "@lingui/react/macro";
import { messagingProviderName } from "@rakazo/core";
import { Button, Input, SectionHeading } from "@rakazo/ui-web";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type ChatToolRow = { provider: string; address: string; botId: string };
type ChatToolPoll =
  | { status: "wait" | "scanned" | "need_pin" | "expired" | "already_linked" }
  | { status: "linked"; link: ChatToolRow };

/** Only an https URL or an image data URL may become the code image. */
function chatToolImage(image: string): string | null {
  const value = image.trim();
  if (value.startsWith("https://") || value.startsWith("data:image/")) return value;
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    return `data:image/png;base64,${value.replace(/\s/g, "")}`;
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function isTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const code = "code" in error ? String(error.code) : "";
  return code === "TIMEOUT" || code === "BAD_GATEWAY" || code === "GATEWAY_TIMEOUT";
}

/** QR link for the primary bot. Other bots render nothing, but the hooks still run. */
export function ChatToolLink({ botId, isPrimary }: { botId: string; isPrimary?: boolean }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ChatToolRow[] | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [needPin, setNeedPin] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = useRef({ expired: "", already: "" });
  copy.current = { expired: t`The code expired`, already: t`Already linked` };

  useEffect(() => {
    if (!isPrimary) return;
    let stop = false;
    void rpc.messaging.chatTools
      .list({ botId })
      .then((links) => {
        if (!stop) setRows(links);
      })
      .catch((err: unknown) => {
        if (!stop) setError(errorText(err));
      });
    return () => {
      stop = true;
    };
  }, [botId, isPrimary]);

  useEffect(() => {
    if (!isPrimary || !loginId || needPin) return;
    const controller = new AbortController();
    const current = loginId;
    const applyPoll = (result: ChatToolPoll): boolean => {
      if (result.status === "need_pin") {
        setNeedPin(true);
        return true;
      }
      if (result.status === "linked") {
        setRows([result.link]);
        setLoginId(null);
        setImage(null);
        setNeedPin(false);
        return true;
      }
      if (result.status === "expired" || result.status === "already_linked") {
        setLoginId(null);
        setImage(null);
        setNeedPin(false);
        setError(result.status === "expired" ? copy.current.expired : copy.current.already);
        return true;
      }
      return false;
    };
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const result = await rpc.messaging.chatTools.poll({ loginId: current });
          if (controller.signal.aborted) return;
          if (applyPoll(result)) return;
        } catch (err) {
          if (controller.signal.aborted) return;
          if (!isTransportError(err)) {
            setError(errorText(err));
            return;
          }
        }
        await sleep(1000, controller.signal);
      }
    })();
    return () => controller.abort();
  }, [isPrimary, loginId, needPin]);

  if (!isPrimary) return null;

  const linked = rows ?? [];
  const src = image ? chatToolImage(image) : null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.messaging.chatTools.start({ botId });
      setImage(started.image);
      setLoginId(started.loginId);
      setNeedPin(false);
      setPin("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitPin(event: FormEvent) {
    event.preventDefault();
    if (!loginId || !/^\d{1,8}$/.test(pin)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.messaging.chatTools.poll({ loginId, pin });
      if (result.status === "need_pin") return;
      if (result.status === "linked") {
        setRows([result.link]);
        setLoginId(null);
        setImage(null);
        setNeedPin(false);
        return;
      }
      if (result.status === "expired" || result.status === "already_linked") {
        setLoginId(null);
        setImage(null);
        setNeedPin(false);
        setError(result.status === "expired" ? copy.current.expired : copy.current.already);
        return;
      }
      setNeedPin(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setPin("");
    }
  }

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await rpc.messaging.chatTools.unlink({ botId });
      setRows([]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6" data-testid="chat-tool-link">
      <SectionHeading variant="label" className="mb-2">
        <Trans>Link your chat app</Trans>
      </SectionHeading>
      {linked.length > 0 ? (
        <div className="space-y-3">
          {linked.map((row) => (
            <div
              key={row.provider}
              className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-muted/50 px-4 text-sm"
            >
              <span>{messagingProviderName(row.provider)}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void unlink()}
              >
                <Trans>Unlink</Trans>
              </Button>
            </div>
          ))}
        </div>
      ) : rows === null ? null : loginId ? (
        <div className="space-y-3">
          {src ? (
            <img alt={t`Chat app code`} src={src} className="size-40 rounded-xl bg-muted/50" />
          ) : null}
          {needPin ? (
            <form className="flex items-center gap-2" onSubmit={(event) => void submitPin(event)}>
              <Input
                aria-label={t`Number from your phone`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                value={pin}
                onChange={(event) => setPin(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={busy || !/^\d{1,8}$/.test(pin)}>
                <Trans>Link</Trans>
              </Button>
            </form>
          ) : null}
        </div>
      ) : (
        <Button type="button" size="sm" disabled={busy} onClick={() => void start()}>
          <Trans>Link</Trans>
        </Button>
      )}
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
