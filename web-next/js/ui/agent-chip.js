// A small "who is asking / who is working" chip for cards.
//
// It used to be a bot avatar fetched from GET /api/bots. There is no bots
// surface any more, so the chip is now a plain initial + label: same job in a
// card (name the agent a row belongs to, or "System" for an unattributed one),
// with no extra request and no avatar lookup.

import { h } from "../utils/dom.js";

function initial(id) {
  const text = String(id || "").trim();
  return text ? text.charAt(0).toUpperCase() : "?";
}

export function agentChip(agentId) {
  const id = String(agentId || "").trim();
  if (!id || id === "system") {
    return h("span", { class: "agent-chip system", text: "System" });
  }
  return h("span", { class: "agent-chip", title: id },
    h("span", { class: "agent-chip-initial", text: initial(id) }),
    h("span", { text: id }));
}