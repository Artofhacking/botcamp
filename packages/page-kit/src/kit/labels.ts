import { createContext, useContext } from "react";

/**
 * Every word the kit writes on its own (buttons, empty states, accessible names), in the app's
 * shipped languages. A page picks its language with `Page lang`; without one the kit follows the
 * language the host gave the frame, then English. Dates and numbers use the same language.
 */
export const PAGE_LOCALES = ["en", "zh-CN"] as const;

type PageLocale = (typeof PAGE_LOCALES)[number];

/** A message whose wording depends on `{count}`, by the language's plural rules. */
type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
type Message = string | Plural;

const en = {
  more: "more",
  eventTime: "{name}, {start} to {end}",
  weekOf: "Week of {date}",
  day: "Day",
  series: "Series {n}",
  values: "Values",
  none: "none",
  noValue: "No value",
  comparison: "Comparison",
  other: "Other",
  total: "Total",
  part: "part {n}",
  size: "Size",
  copied: "Copied",
  up: "Up",
  down: "Down",
  filterRows: "Filter rows",
  noRowsMatch: "No rows match.",
  showing: "Showing {shown} of {total}",
  showMore: "Show more",
  allZero: "All values are 0",
  against: "{x} against {y}",
  againstSized: "{x} against {y}, sized by {size}",
  fewer: "Fewer",
  less: "Less",
  rampMore: "More",
  dailyValues: "Daily values from {from} to {to}, highest {top}",
  shared: "shared {value}",
  matrixAxes: "{x} across, {y} up",
  topLeft: "Top left",
  topRight: "Top right",
  bottomLeft: "Bottom left",
  bottomRight: "Bottom right",
  pointAt: "{label} at {x}, {y}",
  updated: "Updated {ago}",
  asOf: "As of {date}",
  updating: "Updating…",
  refreshFailed: "Refresh failed, showing last value",
  noDataToChart: "No data to chart",
  noData: "No data",
  edge: "{from} to {to}",
  edgeLabeled: "{from} to {to} ({label})",
  sources: "Sources",
  enlarge: "Enlarge {name}",
  enlargeImage: "Enlarge image",
  image: "Image",
  close: "Close",
  photos: { one: "{count} photo", other: "{count} photos" },
  slideOf: "{n} of {total}",
  showPhoto: "Show photo {n}",
  view: "View",
  viewTitle: "View {title}",
  rated: "Rated {rating} out of 5",
  ratedFrom: {
    one: "Rated {rating} out of 5 from {count} rating",
    other: "Rated {rating} out of 5 from {count} ratings",
  },
  ratings: { one: "{count} rating", other: "{count} ratings" },
  moreCount: "{count} more",
  watch: "Watch",
  pros: "Pros",
  cons: "Cons",
  backToTop: "Back to top",
  onThisPage: "On this page",
  showFewer: "Show fewer",
  showAll: "Show all {count}",
} satisfies Record<string, Message>;

type LabelKey = keyof typeof en;
type Messages = Record<LabelKey, Message>;

// "Close", "Copied", "Show more" and "Updating…" match the app's own translations.
const zhCN: Messages = {
  more: "更多",
  eventTime: "{name}，{start}至{end}",
  weekOf: "{date}这一周",
  day: "日",
  series: "系列 {n}",
  values: "数值",
  none: "无",
  noValue: "无数值",
  comparison: "对比",
  other: "其他",
  total: "合计",
  part: "部分 {n}",
  size: "大小",
  copied: "已复制",
  up: "上升",
  down: "下降",
  filterRows: "筛选行",
  noRowsMatch: "没有匹配的行。",
  showing: "显示 {shown} / {total}",
  showMore: "显示更多",
  allZero: "所有数值均为 0",
  against: "{x} 对比 {y}",
  againstSized: "{x} 对比 {y}，大小表示 {size}",
  fewer: "较少",
  less: "较少",
  rampMore: "较多",
  dailyValues: "{from}至{to}的每日数值，最高 {top}",
  shared: "共有 {value}",
  matrixAxes: "横轴 {x}，纵轴 {y}",
  topLeft: "左上",
  topRight: "右上",
  bottomLeft: "左下",
  bottomRight: "右下",
  pointAt: "{label}：{x}，{y}",
  updated: "{ago}更新",
  asOf: "截至{date}",
  updating: "正在更新…",
  refreshFailed: "刷新失败，显示的是上次的数值",
  noDataToChart: "没有可绘制的数据",
  noData: "无数据",
  edge: "{from} 到 {to}",
  edgeLabeled: "{from} 到 {to}（{label}）",
  sources: "来源",
  enlarge: "放大{name}",
  enlargeImage: "放大图片",
  image: "图片",
  close: "关闭",
  photos: { other: "{count} 张照片" },
  slideOf: "第 {n} 张，共 {total} 张",
  showPhoto: "显示第 {n} 张照片",
  view: "查看",
  viewTitle: "查看{title}",
  rated: "评分 {rating}/5",
  ratedFrom: { other: "评分 {rating}/5，共 {count} 条评价" },
  ratings: { other: "{count} 条评价" },
  moreCount: "另外 {count} 人",
  watch: "关注",
  pros: "优点",
  cons: "缺点",
  backToTop: "返回顶部",
  onThisPage: "本页内容",
  showFewer: "收起",
  showAll: "显示全部 ({count})",
};

export const PAGE_MESSAGES: Record<PageLocale, Messages> = {
  en,
  "zh-CN": zhCN,
};

// Languages written right to left, by their primary subtag.
const RTL = new Set(["ar", "ckb", "dv", "fa", "he", "iw", "ps", "sd", "ug", "ur", "yi"]);

/** The tag as Intl spells it, or nothing when it is not a language tag. */
function canonical(tag: string | undefined): string | undefined {
  if (typeof tag !== "string" || !tag.trim()) return undefined;
  try {
    return Intl.getCanonicalLocales(tag.trim())[0];
  } catch {
    return undefined;
  }
}

/** The shipped language closest to a tag: exact, then by script or region, then the language. */
export function pageLocaleOf(tag: string | undefined): PageLocale {
  const name = canonical(tag);
  if (!name) return "en";
  const exact = PAGE_LOCALES.find((locale) => locale.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const language = name.split("-")[0]!.toLowerCase();
  if (language === "zh") return "zh-CN";
  return PAGE_LOCALES.find((locale) => locale === language) ?? "en";
}

export type Words = {
  /** The shipped language the words come from. */
  locale: PageLocale;
  /** What Intl formats dates and numbers with: the page's own tag when it is valid. */
  intl: string;
  dir: "ltr" | "rtl";
  t: (key: LabelKey, vars?: Record<string, string | number>) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  date: (time: number, options: Intl.DateTimeFormatOptions) => string;
  list: (items: string[]) => string;
  ago: (ms: number) => string;
};

const made = new Map<string, Words>();

/** The words and formats for a language tag; untagged pages read as US English. */
export function wordsFor(tag: string | undefined): Words {
  const key = canonical(tag) ?? "";
  const cached = made.get(key);
  if (cached) return cached;
  const locale = pageLocaleOf(key);
  const intl = key || "en-US";
  const numbers = new Map<string, Intl.NumberFormat>();
  const number = (value: number, options?: Intl.NumberFormatOptions) => {
    const id = JSON.stringify(options ?? {});
    let format = numbers.get(id);
    if (!format) {
      format = new Intl.NumberFormat(intl, options);
      numbers.set(id, format);
    }
    return format.format(value);
  };
  const plurals = new Intl.PluralRules(intl);
  const messages = PAGE_MESSAGES[locale];
  const t = (label: LabelKey, vars: Record<string, string | number> = {}) => {
    const message = messages[label] ?? en[label];
    const count = vars.count;
    const template =
      typeof message === "string"
        ? message
        : (message[plurals.select(typeof count === "number" ? count : Number.NaN)] ??
          message.other);
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = vars[name];
      if (value === undefined) return whole;
      return typeof value === "number" ? number(value) : value;
    });
  };
  const relative = new Intl.RelativeTimeFormat(intl, { style: "long", numeric: "always" });
  const ago = (ms: number) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return relative.format(-seconds, "second");
    if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), "minute");
    if (seconds < 86_400) return relative.format(-Math.floor(seconds / 3600), "hour");
    return relative.format(-Math.floor(seconds / 86_400), "day");
  };
  const conjunction = new Intl.ListFormat(intl, { type: "conjunction" });
  const words: Words = {
    locale,
    intl,
    dir: RTL.has(key.split("-")[0]!.toLowerCase()) ? "rtl" : "ltr",
    t,
    number,
    date: (time, options) => new Intl.DateTimeFormat(intl, options).format(time),
    list: (items) => conjunction.format(items),
    ago,
  };
  made.set(key, words);
  return words;
}

/** The language a Page sets for everything inside it. */
export const PageLanguage = createContext<string | undefined>(undefined);

/** The language the host gave the frame, read when no Page sets one. */
export function documentLanguage(): string | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement.lang || undefined;
}

export function useWords(): Words {
  return wordsFor(useContext(PageLanguage) ?? documentLanguage());
}
