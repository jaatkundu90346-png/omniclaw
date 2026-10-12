// Toast: bottom-center, 3s, error/success variants.

import { h } from "../utils/dom.js";

let host = null;

function getHost() {
  if (!host) {
    host = h("div", { class: "toasts", "aria-live": "polite" });
    document.body.append(host);
  }
  return host;
}

export function toast(message, kind = "error") {
  const el = h("div", { class: `toast ${kind}`, text: String(message || "") });
  getHost().append(el);
  setTimeout(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 3000);
}
