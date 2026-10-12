// The delegation card.
//
// This is the only place a user sees a hand-off, and it has one job: be honest
// about where the work is RIGHT NOW. The vocabulary is the server's, not ours -
// queued | running | done | failed | cancelled | stalled. In particular a
// queued task shows a WAITING note, not a spinner: with the global run gate at
// 1 the target is genuinely not moving yet, and a spinner there would be a lie.
//
// The card subscribes to the delegation store rather than fetching: the record
// is updated by the server (which mirrors the child run's events) and pushed
// here on every change, so the step counter moves without this file polling.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { cancelDelegationTask, retryDelegationTask } from "../api.js";
import { subscribe, get } from "../delegations.js";
import { agentChip } from "./agent-chip.js";
import { toast } from "./toast.js";

const OPEN = new Set(["queued", "running"]);

const STATUS_TEXT = {
  queued: "Waiting for a free run slot",
  running: "Working",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  stalled: "No activity for a minute",
};

function agoText(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function delegationCard(delegationId) {
  const card = h("div", { class: "deleg-card", "data-delegation": delegationId });
  const body = h("div", { class: "deleg-body" });
  const actions = h("div", { class: "deleg-actions" });
  card.append(body, actions);

  const paint = (d) => {
    body.innerHTML = "";
    actions.innerHTML = "";
    if (!d) {
      body.append(h("div", { class: "deleg-title", text: "Loading task…" }));
      return;
    }
    const open = OPEN.has(d.status);
    // A finished card stops re-rendering itself; a live one keeps the "Ns ago"
    // honest without a server round-trip.
    if (!open && card.dataset.settled === "1") return;
    if (!open) card.dataset.settled = "1";

    body.append(
      h("div", { class: "deleg-title", text: d.title || "(untitled task)" }),
      h("div", { class: "deleg-meta" },
        agentChip(d.targetAgentId),
        h("span", { class: `deleg-status s-${d.status}`, text: STATUS_TEXT[d.status] || d.status }),
        d.step && d.step.round
          ? h("span", { class: "deleg-step", text: `step ${d.step.round}${d.step.maxRounds ? ` of ${d.step.maxRounds}` : ""}` })
          : null,
        h("span", { class: "deleg-ago", text: agoText(d.updatedAt || d.createdAt) })),
    );
    if (d.status === "queued") {
      body.append(h("div", {
        class: "deleg-note",
        text: "The other agent starts as soon as the current run finishes.",
      }));
    }
    if (d.resultSummary) {
      body.append(h("div", { class: "deleg-result", text: d.resultSummary }));
    }
    const files = d.filesChanged || [];
    if (files.length) {
      body.append(h("div", { class: "deleg-files", text: `Changed: ${files.slice(0, 6).join(", ")}` }));
    }

    if (open) {
      const cancel = h("button", { class: "btn ghost", type: "button", text: "Cancel" });
      cancel.onclick = async () => {
        cancel.disabled = true;
        try { await cancelDelegationTask(d.id); } catch (e) { toast(String(e.message || e), "error"); }
      };
      actions.append(cancel);
    } else if (d.status === "failed" || d.status === "cancelled" || d.status === "stalled") {
      const retry = h("button", { class: "btn ghost", type: "button", text: "Retry" });
      retry.onclick = async () => {
        retry.disabled = true;
        try { await retryDelegationTask(d.id); } catch (e) { toast(String(e.message || e), "error"); }
      };
      actions.append(retry);
    }
  };

  paint(get(delegationId));
  const unsubscribe = subscribe(() => paint(get(delegationId)));
  card.unsubscribe = unsubscribe;
  return card;
}

// Mount into a thread host. Idempotent: re-subscribing an existing card is a
// no-op, so a re-render of the turn cannot stack duplicate listeners.
const mounted = new WeakMap();
export function mountDelegationCard(host, delegationId) {
  if (!delegationId) return null;
  const existing = mounted.get(host);
  if (existing && existing.dataset.delegation === delegationId) return existing;
  const card = delegationCard(delegationId);
  mounted.set(host, card);
  host.append(card);
  return card;
}