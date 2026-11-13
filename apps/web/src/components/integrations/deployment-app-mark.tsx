import feishuMark from "../../assets/app-marks/feishu.png?url";
import githubMark from "../../assets/app-marks/github.svg?url";
import notionMark from "../../assets/app-marks/notion.svg?url";
import qqMailMark from "../../assets/app-marks/qq-mail.png?url";

/**
 * Artwork ships with the app: Connect apps shows an app's mark on the first paint,
 * with no logo service or network request, and keeps working offline.
 */
const APP_MARKS = {
  "qq-mail": qqMailMark,
  notion: notionMark,
  github: githubMark,
  feishu: feishuMark,
} as const;

type KnownApp = keyof typeof APP_MARKS;

/** A deployment app is its endpoint; the built-in apps are the ones we ship artwork for. */
function knownApp(endpoint: string | undefined): KnownApp | null {
  if (!endpoint) return null;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return null;
  }
  if (host === "api.mail.qq.com") return "qq-mail";
  if (host === "mcp.notion.com") return "notion";
  if (host === "api.githubcopilot.com") return "github";
  return null;
}

/** The directory row has no endpoint: its sign-in name is all the deployment gives us. */
function directoryApp(name: string): KnownApp | null {
  return /^(飞书|feishu|lark)$/i.test(name.trim()) ? "feishu" : null;
}

export function DeploymentAppMark({
  name,
  endpoint,
}: {
  name: string;
  /** The app's MCP endpoint; omitted for the directory row. */
  endpoint?: string;
}) {
  const known = knownApp(endpoint) ?? directoryApp(name);
  if (!known) {
    return (
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
        {name[0]}
      </div>
    );
  }
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-favicon-plate">
      <img
        src={APP_MARKS[known]}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-contain p-1"
      />
    </div>
  );
}
