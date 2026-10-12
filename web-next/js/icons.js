// Inline SVG icon strings: 16px, stroke 1.5, currentColor. No emoji.

function svg(inner) {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// P3: exact brand mark — 22×22 rounded tile, three claw strokes, monochrome.
export const brand = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><rect x="1" y="1" width="20" height="20" rx="6" fill="currentColor"/><path d="M6.6 15.6c0-4 1.5-7 4.4-9.2" stroke="var(--bg-sidebar)" stroke-width="1.8" stroke-linecap="round"/><path d="M11 15.6c0-3.6.7-6.6 2.1-9.2" stroke="var(--bg-sidebar)" stroke-width="1.8" stroke-linecap="round"/><path d="M15.4 15.6c.2-3.2-.4-6-1.6-8.6" stroke="var(--bg-sidebar)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

export const icons = {
  panelLeft: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><line x1="6" y1="2.5" x2="6" y2="13.5"/>'),
  panelRight: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><line x1="10" y1="2.5" x2="10" y2="13.5"/>'),
  plus: svg('<line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/>'),
  pencil: svg('<path d="M11.5 2.5l2 2L5 13H3v-2z"/>'),
  gitBranch: svg('<circle cx="4.5" cy="4" r="1.8"/><circle cx="4.5" cy="12" r="1.8"/><circle cx="11.5" cy="8" r="1.8"/><path d="M4.5 5.8v4.4M6 7.2c2.5 0 2.5 1 3.7 1"/>'),
  clock: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.3"/>'),
  puzzle: svg('<path d="M6 2h4v2.2a1.3 1.3 0 1 0 2 0H14v4h-2.2a1.3 1.3 0 1 0 0 2H14v4H6v-2.2a1.3 1.3 0 1 0-2 0H2V6h2.2A1.3 1.3 0 1 0 6 4.2z"/>'),
  folder: svg('<path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z"/>'),
  message: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5H2.5z"/>'),
  search: svg('<circle cx="7" cy="7" r="4"/><line x1="10.2" y1="10.2" x2="14" y2="14"/>'),
  bell: svg('<path d="M8 2a4 4 0 0 1 4 4c0 3 1 4 1 4H3s1-1 1-4a4 4 0 0 1 4-4z"/><path d="M6.5 12.5a1.5 1.5 0 0 0 3 0"/>'),
  chevronDown: svg('<path d="M4 6l4 4 4-4"/>'),
  chevronRight: svg('<path d="M6 4l4 4-4 4"/>'),
  more: svg('<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>'),
  terminal: svg('<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>'),
  globe: svg('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-3.5 3.5-3.5 7.5 0 11 3.5-3.5 3.5-7.5 0-11z"/>'),
  diff: svg('<path d="M3 3.5h4M3 8h7M3 12.5h4"/><path d="M11 5.5l3 3-3 3"/>'),
  settings: svg('<circle cx="8" cy="8" r="2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>'),
  sun: svg('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>'),
  moon: svg('<path d="M13 10.5A5.5 5.5 0 0 1 5.5 3 5.5 5.5 0 1 0 13 10.5z"/>'),
  sparkles: svg('<path d="M8 1.5l1.2 3.6 3.6 1.2-3.6 1.2L8 11.1l-1.2-3.6-3.6-1.2 3.6-1.2z"/><path d="M12.5 10.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
  fileSearch: svg('<path d="M3.5 1.8h6l2.5 2.5v9.2h-8.5z"/><path d="M9.5 1.8v2.5H12"/><circle cx="7" cy="9" r="1.8"/><line x1="8.4" y1="10.2" x2="10" y2="11.8"/>'),
  image: svg('<rect x="1.8" y="3" width="12.4" height="10" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="M2.5 11.5l3.5-3.5 2.5 2.5 2-2 3 3"/>'),
  info: svg('<circle cx="8" cy="8" r="5.5"/><line x1="8" y1="7.4" x2="8" y2="11"/><circle cx="8" cy="5" r="0.9" fill="currentColor"/>'),
  wrench: svg('<path d="M10.5 2.5a3 3 0 0 0-3.9 3.9L2.5 10.5l3 3 4.1-4.1a3 3 0 0 0 3.9-3.9l-2 2-2-2z"/>'),
  arrow: svg('<path d="M2.5 8h10M8.5 4.5L12.5 8l-4 3.5"/>'),
  lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  unlock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/>'),
  warn: svg('<path d="M8 2L14.5 13.5h-13z"/><line x1="8" y1="6.5" x2="8" y2="10"/><circle cx="8" cy="11.8" r="0.9" fill="currentColor"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
  redo: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.8v3h-3"/>'),
  monitor: svg('<rect x="1.5" y="3" width="13" height="8.5" rx="1.5"/><line x1="6" y1="14" x2="10" y2="14"/><line x1="8" y1="11.5" x2="8" y2="14"/>'),
  check: svg('<path d="M3 8.5l3.5 3.5L13 4.5"/>'),
  x: svg('<line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>'),
  spinner: svg('<circle cx="8" cy="8" r="5.5" stroke-dasharray="3 2.2"/>'),
};
