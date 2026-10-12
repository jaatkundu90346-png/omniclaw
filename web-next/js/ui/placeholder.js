// Single placeholder page reused by not-yet-built routes.
// Text only — never mock data.

import { h } from "../utils/dom.js";

export function placeholderPage(title) {
  return h("div", { class: "empty" },
    h("h1", null, title),
    h("p", { class: "sub" }, "Not available in this build yet."),
  );
}
