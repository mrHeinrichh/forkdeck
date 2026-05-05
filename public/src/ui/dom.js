export const $ = (selector, root = document) => root.querySelector(selector);

export function iconRefresh() {
  if (window.lucide) window.lucide.createIcons();
}
