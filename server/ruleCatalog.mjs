/** System-fixed RuleCatalog — users may only enable subsets. */
export const RULE_CATALOG = [
  { rule_id: "no_external_links_in_body", label: "正文不放外链" },
  { rule_id: "no_dns_block_vpn_compare", label: "不写 DNS 污染/封锁/翻墙；不比大陆海外" },
  { rule_id: "no_crack_or_unofficial_qq", label: "不写破解/绕过风控；不教非官方 QQ 协议" },
  { rule_id: "first_person_only_if_done", label: "第一人称只写真做过的；否则教程体/「小稿实测」" },
  { rule_id: "title_oral_short_rough", label: "标题口语、短、糙；偏好可动手白嫖教程" },
  { rule_id: "final_review_before_publish", label: "发布前必须终审" },
  { rule_id: "demox_soft_mention_only", label: "Demox 只轻提不硬广" },
  { rule_id: "no_url_in_body_or_image", label: "正文与图不出现网址/域名" },
  { rule_id: "image_landscape_16_9", label: "配图横图 16:9" },
  { rule_id: "publish_window_20_21", label: "统一晚上 20:00–21:00 发" },
];
