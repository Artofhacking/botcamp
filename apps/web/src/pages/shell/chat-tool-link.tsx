import { Trans, useLingui } from "@lingui/react/macro";
import { linkableChatApps, messagingProviderName } from "@botcamp/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@botcamp/ui-web";
import { ChevronLeft } from "lucide-react";
import QRCode from "qrcode";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type ChatToolRow = { provider: string; address: string; botId: string };
type ChatToolPoll =
  | { status: "wait" | "scanned" | "need_pin" | "expired" | "already_linked" }
  | { status: "linked"; link: ChatToolRow };

/** A real picture can be shown directly. A login URL is drawn as a code instead. */
function chatToolPicture(image: string): string | null {
  const value = image.trim();
  if (value.startsWith("data:image/")) return value;
  if (value.length > 32 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    return `data:image/png;base64,${value.replace(/\s/g, "")}`;
  }
  return null;
}

async function chatToolCodeSrc(image: string): Promise<string | null> {
  const picture = chatToolPicture(image);
  if (picture) return picture;
  const text = image.trim();
  if (!text) return null;
  const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
  const [src, setSrc] = useState<string | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [needPin, setNeedPin] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"choose" | "code">("choose");
  const [provider, setProvider] = useState("");
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
    if (!image) {
      setSrc(null);
      return;
    }
    let stop = false;
    void chatToolCodeSrc(image).then((next) => {
      if (!stop) setSrc(next);
    });
    return () => {
      stop = true;
    };
  }, [image]);

  useEffect(() => {
    if (!isPrimary || !open || !loginId || needPin) return;
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
        setStep("choose");
        setOpen(false);
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
  }, [isPrimary, open, loginId, needPin]);

  if (!isPrimary) return null;

  const linked = rows ?? [];

  async function choose(id: string) {
    setBusy(true);
    setError(null);
    setProvider(id);
    setStep("code");
    try {
      const started = await rpc.messaging.chatTools.start({ botId, provider: id });
      setImage(started.image);
      setLoginId(started.loginId);
      setNeedPin(false);
      setPin("");
    } catch (err) {
      setStep("choose");
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function back() {
    setLoginId(null);
    setImage(null);
    setNeedPin(false);
    setPin("");
    setError(null);
    setStep("choose");
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
        setStep("choose");
        setOpen(false);
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

  const title = step === "code" && provider ? messagingProviderName(provider) : undefined;

  return (
    <div data-testid="chat-tool-link" className="overflow-hidden rounded-xl bg-muted/50 px-4">
      <div className="flex min-h-12 items-center justify-between gap-3 text-sm">
        <span>
          <Trans>Link your chat app</Trans>
        </span>
        {linked.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void unlink()}
          >
            <Trans>Unlink</Trans>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || rows === null}
            onClick={() => {
              setError(null);
              setStep(loginId ? "code" : "choose");
              setOpen(true);
            }}
          >
            <Trans>Link</Trans>
          </Button>
        )}
      </div>
      {error && !open ? (
        <p className="border-t border-border py-3 text-sm text-destructive">{error}</p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <div className="flex items-center gap-2">
              {step === "code" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Back`}
                  onClick={back}
                >
                  <ChevronLeft />
                </Button>
              ) : null}
              <DialogTitle>{title ?? <Trans>Link your chat app</Trans>}</DialogTitle>
            </div>
            <DialogDescription className="sr-only">
              {title ?? <Trans>Link your chat app</Trans>}
            </DialogDescription>
          </DialogHeader>
          {step === "choose" ? (
            <div className="grid gap-2">
              {linkableChatApps().map((id) => (
                <button
                  key={id}
                  type="button"
                  className="flex min-h-12 items-center rounded-xl bg-muted/50 px-4 text-start text-sm"
                  disabled={busy}
                  onClick={() => void choose(id)}
                >
                  {messagingProviderName(id)}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              {src ? (
                <img
                  alt={t`Chat app code`}
                  src={src}
                  className="size-64 max-w-full rounded-xl bg-muted/50"
                />
              ) : (
                <div className="size-64 max-w-full rounded-xl bg-muted/50" />
              )}
              {needPin ? (
                <form
                  className="flex w-full items-center gap-2"
                  onSubmit={(event) => void submitPin(event)}
                >
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
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
