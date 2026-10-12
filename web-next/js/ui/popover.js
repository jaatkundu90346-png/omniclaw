// Anchored popover: open(anchorEl, contentEl, {align, child}).
// Closes on Esc, outside click, route change. Traps focus. Arrow-key nav.
// child:true stacks a submenu WITHOUT closing the parent (for two-level menus).
//
// Positioning: side "below" (default) | "right" | "auto" (collision-aware flip:
// opens above the anchor when space below is insufficient). place() measures
// the CURRENT content height, so callers with async content call
// handle.reposition() after paint. maxHeight caps the popover to the real
// available space; the list inside scrolls (see popover.css). With
// repositionOnResize:true, zoom/resize re-places instead of closing.

const stack = [];

function closeTop() {
  const current = stack.pop();
  if (!current) return null;
  const { el, anchor, onClose, disposers } = current;
  for (const d of disposers) { try { d(); } catch {} }
  el.remove();
  if (anchor && anchor.setAttribute) anchor.setAttribute("aria-expanded", "false");
  // Focus restoration: if focus was inside the closing popover, hand it back
  // to the trigger so keyboard users don't lose their place.
  try {
    if (anchor && anchor.focus && el.contains(document.activeElement)) anchor.focus();
  } catch {}
  if (onClose) { try { onClose(); } catch {} }
  return current;
}

function closeAll() {
  while (stack.length) closeTop();
}

function trapFocus(el, e) {
  if (e.key !== "Tab") return;
  const items = [...el.querySelectorAll("button, [href], input, [tabindex]:not([tabindex='-1'])")]
    .filter((n) => !n.disabled && n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function place(el, anchorEl, { align = "start", side = "below", maxHeight = 480 } = {}) {
  // P1: clamp to viewport. Submenus flip LEFT when no room on the right;
  // bottom overflow shifts up. Max-height/scroll live in popover.css.
  const M = 12;
  const r = anchorEl.getBoundingClientRect();
  const pw = Math.min(320, Math.max(200, el.offsetWidth || 220));
  const ph = el.offsetHeight || 200;
  if (side === "right" && r.right + 6 + pw <= window.innerWidth - M) {
    el.style.left = `${r.right + 6}px`;
  } else if (side === "right") {
    el.style.left = `${Math.max(M, r.left - pw - 6)}px`;
  } else if (align === "end") {
    el.style.left = `${Math.max(M, Math.min(r.right - pw, window.innerWidth - pw - M))}px`;
  } else {
    el.style.left = `${Math.max(M, Math.min(r.left, window.innerWidth - pw - M))}px`;
  }
  if (side === "right") {
    el.style.top = `${Math.max(M, Math.min(r.top, window.innerHeight - Math.min(ph, maxHeight) - M))}px`;
    el.style.maxHeight = `${Math.min(maxHeight, window.innerHeight - M * 2)}px`;
  } else if (side === "auto") {
    // Collision-aware flip: measure both sides, open where the content fits.
    const below = window.innerHeight - r.bottom - 6 - M;
    const above = r.top - 6 - M;
    const need = Math.min(ph, maxHeight);
    const openAbove = need > below && above > below;
    const avail = Math.max(120, Math.min(maxHeight, (openAbove ? above : below)));
    el.style.maxHeight = `${avail}px`;
    el.style.top = openAbove
      ? `${Math.max(M, r.top - 6 - Math.min(ph, avail))}px`
      : `${r.bottom + 6}px`;
  } else {
    const below = r.bottom + 6 + Math.min(ph, maxHeight);
    el.style.top = below <= window.innerHeight - M
      ? `${r.bottom + 6}px`
      : `${Math.max(M, window.innerHeight - Math.min(ph, maxHeight) - M)}px`;
    el.style.maxHeight = `${Math.min(maxHeight, window.innerHeight - M * 2)}px`;
  }
}

export function openPopover(anchorEl, contentEl, { align = "start", onClose, child = false, side = "below", focusFirst = true, maxHeight = 480, repositionOnResize = false } = {}) {
  if (!child) closeAll();
  const el = document.createElement("div");
  el.className = "popover";
  el.setAttribute("role", "menu");
  el.append(contentEl);
  document.body.append(el);

  const opts = { align, side, maxHeight };
  place(el, anchorEl, opts);

  anchorEl.setAttribute("aria-expanded", "true");

  const record = { el, anchor: anchorEl, onClose, disposers: [], child };
  const disposers = record.disposers;
  const onDocDown = (e) => {
    // A click inside ANY stacked popover or its anchor keeps the stack alive.
    for (const s of stack) {
      if (s.el.contains(e.target)) return;
    }
    if (!el.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) closeAll();
  };
  // Arrow-key navigation across menu rows (roving focus); Enter activates natively.
  // Right opens a submenu (handled by the row), Left closes a child level.
  const menuItems = () => [...el.querySelectorAll(".pop-item:not(:disabled)")];
  const onKey = (e) => {
    // Only the topmost level handles keys (listeners stack with each level).
    if (stack[stack.length - 1] !== record) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      const closed = closeTop();
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.anchor.focus?.();
      } else if (closed) {
        closed.anchor.focus?.();
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = menuItems();
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = e.key === "ArrowDown"
        ? items[(i + 1) % items.length]
        : items[(i - 1 + items.length) % items.length];
      next.focus();
      // P1: keep the focused row visible inside scrollable popovers.
      try { next.scrollIntoView({ block: "nearest" }); } catch {}
    } else if (e.key === "Home" || e.key === "End") {
      const items = menuItems();
      if (!items.length) return;
      e.preventDefault();
      (e.key === "Home" ? items[0] : items[items.length - 1]).focus();
    } else if (e.key === "ArrowLeft" && child) {
      e.preventDefault();
      closeTop();
      anchorEl.focus?.();
    } else trapFocus(el, e);
  };
  const onHash = () => closeAll();
  // Zoom/resize: re-place popovers that asked for it, close the rest (their
  // anchors may have moved; a stale menu is worse than none).
  const onResize = () => {
    if (repositionOnResize && el.isConnected && stack.includes(record)) {
      try { place(el, anchorEl, opts); } catch { closeTop(); }
    } else {
      closeAll();
    }
  };
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("hashchange", onHash);
  window.addEventListener("resize", onResize);
  disposers.push(
    () => document.removeEventListener("pointerdown", onDocDown, true),
    () => document.removeEventListener("keydown", onKey, true),
    () => window.removeEventListener("hashchange", onHash),
    () => window.removeEventListener("resize", onResize),
  );
  stack.push(record);
  const first = el.querySelector("button, input");
  if (first && !child && focusFirst) first.focus();
  return {
    close: () => closeTop(),
    reposition: () => { try { place(el, anchorEl, opts); } catch {} },
    el,
  };
}

export function closePopover() { closeTop(); }
export function closeAllPopovers() { closeAll(); }
export function isPopoverOpen() { return stack.length > 0; }
