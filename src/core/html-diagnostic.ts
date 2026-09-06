import type { Post } from "../shared/types";

export async function captureMissingPostHtml(post: Post, card: Element): Promise<void> {
  if (post.post_url) return;
  // Snapshot before awaiting: the live card may change while compression runs.
  const html = card.outerHTML;
  const stream = new CompressionStream("gzip");
  const bytes = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(html));
  await writer.close();
  let binary = "";
  for (const byte of new Uint8Array(await bytes)) binary += String.fromCharCode(byte);
  post.missing_post_url_html = { encoding: "gzip-base64", data: btoa(binary) };
}
