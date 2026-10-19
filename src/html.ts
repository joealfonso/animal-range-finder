const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
/** An outbound link, or just its text if the stored URL is not http(s), so bad data can never become a javascript: link. */
export const extLink = (url: string, html: string) =>
  /^https?:\/\//i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${html}</a>` : html;
export const nf = new Intl.NumberFormat('en-US');
export const plural = (n: number, one: string, many: string) => `${nf.format(n)} ${n === 1 ? one : many}`;
