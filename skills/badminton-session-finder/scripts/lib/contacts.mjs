function uniqueLinks(links) {
  const seen = new Set();
  return links.filter((item) => {
    const key = `${item.method}\u001f${item.url ?? ""}\u001f${item.value ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function priceDisplay(priceOptions) {
  if (!priceOptions?.length) return "原文未公開，請聯絡確認";
  return priceOptions.map((option) => {
    const details = [option.condition, option.duration_minutes ? `${option.duration_minutes} 分鐘` : null].filter(Boolean);
    return `NT$${option.amount}${details.length ? `（${details.join("、")}）` : ""}`;
  }).join("／");
}

export function buildContact(registration, links, authorName) {
  const methods = registration?.methods ?? [];
  const registrationUrls = (links?.registration ?? [])
    .filter(({ kind }) => (kind === "line" && methods.includes("line")) || (kind === "external" && methods.includes("url")))
    .map(({ raw_url }) => raw_url)
    .filter(Boolean);
  const contactLinks = [];
  for (const url of registrationUrls) contactLinks.push({ method: "url", label: "直接報名", url, value: null });
  if (registration?.line_id) contactLinks.push({ method: "line", label: `LINE ID: ${registration.line_id}`, url: null, value: registration.line_id });
  if (registration?.phone) contactLinks.push({ method: "phone", label: `電話：${registration.phone}`, url: null, value: registration.phone });
  if (links?.post?.raw_url) contactLinks.push({ method: "facebook_post", label: "開啟原貼文留言／查看最新狀態", url: links.post.raw_url, value: null });
  if (links?.author?.raw_url) contactLinks.push({ method: "facebook_author", label: `開啟作者${authorName ? ` ${authorName}` : ""}的頁面私訊`, url: links.author.raw_url, value: null });

  const hasDirect = Boolean(registrationUrls.length || registration?.line_id || registration?.phone);
  const hasSourceAction = Boolean(
    (methods.includes("facebook_comment") && links?.post?.raw_url)
    || (methods.includes("facebook_message") && (links?.author?.raw_url || links?.post?.raw_url)),
  );
  const hasSourceLink = Boolean(links?.post?.raw_url || links?.author?.raw_url);
  const contactability = hasDirect ? "direct" : hasSourceAction ? "source" : hasSourceLink ? "partial" : "unavailable";
  const allLinks = uniqueLinks(contactLinks);
  const primary = allLinks[0] ?? null;
  return {
    registration_urls: registrationUrls,
    primary_method: primary?.method ?? null,
    primary_label: primary?.label ?? "無直接聯絡入口",
    primary_url: primary?.url ?? null,
    contactability,
    links: allLinks,
  };
}
