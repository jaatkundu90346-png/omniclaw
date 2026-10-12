// SSE streaming client for POST /api/chat/stream.
// Envelope types (docs/STREAM_EVENTS.md): start, heartbeat, event(record),
// final, done, error. CALLER stops the server run via api.stopRun(runId);
// signal only cancels the local fetch.

// The idle watchdog only exists to stop the UI from pretending a DEAD socket is
// still live. It must never be shorter than the longest legitimate silence, and
// firing it must NOT mean the run died.
//
// Live 2026-09-27: this was 90_000 while shell-executor.js:310 allows a single
// tool up to 900_000ms. A 5-minute `npm run build` is a normal, healthy silence —
// the watchdog fired anyway, and because the server used to cancel on disconnect
// that killed a 16-minute run. The server no longer cancels on disconnect, so a
// trip here now only means "this tab lost the stream".
//
// Sized above the tool ceiling (900s) with margin. Server heartbeats every 15s,
// so a genuinely dead connection still surfaces quickly in practice.
const IDLE_TIMEOUT_MS = 960000;
let warnedMalformed = false;

function warnMalformed(line) {
  // console.warn once: a malformed data: line must never spam the console.
  if (warnedMalformed) return;
  warnedMalformed = true;
  console.warn("sse: ignoring malformed packet", line.slice(0, 120));
}

export function streamChat({ message, sessionId, label, agentId, workspacePath, attachments }, handlers = {}, signal) {
  const h = handlers;
  // Same headers/body as neo.js:903-911. No mode fields (C1/C2).
  // workspacePath binds a NEW chat to the client's project folder; existing
  // chats keep the folder stored on their own session record (server-side).
  const body = { message, agentId };
  if (sessionId) body.sessionId = sessionId;
  if (label) body.label = label;
  if (workspacePath) body.workspacePath = workspacePath;
  // Attachment descriptors let the SERVER attach the image natively when the
  // active model has vision. Without them the model only sees the file path in
  // text and has to call describe_image — which fails outright when no vision
  // backend is configured. The server re-validates every path.
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;

  let runId = "";
  let reader = null;
  let watchdog = null;
  let finished = false;

  const poke = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { reader && reader.cancel(); } catch {}
      // Deliberately NOT onError: the run is still alive server-side (the server
      // no longer cancels on disconnect), so reporting this as a failure would be
      // a lie that invites a pointless "Retry" and a duplicated run.
      h.onDetach && h.onDetach({
        runId,
        message: "Connection to the run was lost. The agent is still working in the background — reopen this chat to pick it back up.",
      });
      h.onClose && h.onClose({ runId, detached: true });
    }, IDLE_TIMEOUT_MS);
  };

  const clean = () => {
    finished = true;
    if (watchdog) clearTimeout(watchdog);
    try { reader && reader.releaseLock(); } catch {}
  };

  const dispatch = (packet) => {
    poke();
    if (!packet || typeof packet !== "object") return;
    switch (packet.type) {
      case "start":
        h.onStart && h.onStart(packet);
        break;
      case "heartbeat":
        h.onHeartbeat && h.onHeartbeat(packet);
        break;
      case "event": {
        const record = packet.record || {};
        const payload = record.payload || {};
        if (!runId && payload.runId) {
          runId = payload.runId;
          h.onRunId && h.onRunId(runId);
        }
        h.onEvent && h.onEvent(record);
        break;
      }
      case "final":
        h.onFinal && h.onFinal(packet);
        break;
      case "done":
        if (packet.sessionId) h.onSession && h.onSession(packet.sessionId);
        clean();
        h.onDone && h.onDone(packet);
        break;
      case "error":
        clean();
        h.onError && h.onError({ message: packet.error || "Stream error" });
        break;
      default:
        break;
    }
  };

  (async () => {
    poke();
    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        let msg = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          if (data && data.error) msg = data.error;
        } catch {}
        throw new Error(msg);
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            dispatch(JSON.parse(line.slice(5)));
          } catch {
            warnMalformed(line);
          }
        }
        if (finished) break;
      }
      clean();
      h.onClose && h.onClose({ runId });
    } catch (error) {
      clean();
      if (error && error.name === "AbortError") {
        h.onAbort && h.onAbort({ runId });
        return;
      }
      h.onError && h.onError({ message: (error && error.message) || "Stream failed" });
    }
  })();

  return {
    get runId() { return runId; },
  };
}

// 4B.1: persistent gateway feed for the GLOBAL approvals store (js/approvals.js).
// GET /api/events carries EVERY record unfiltered (server.js:
// agent.gateway.onEvent(broadcastEvent)); the store is the ONLY consumer and it
// filters to approval.* + run.question* — nothing else from here drives the
// thread. One SSE request, counted once by the limiter; backoff reconnect.
export function subscribeGatewayEvents(onRecord, { retryBase = 2000, retryMax = 30000 } = {}) {
  let es = null;
  let dead = false;
  let delay = retryBase;
  let fails = 0;

  const schedule = () => {
    if (dead) return;
    const wait = delay;
    delay = Math.min(delay * 2, retryMax);
    setTimeout(open, wait);
  };

  function open() {
    if (dead) return;
    let stream = null;
    try {
      stream = new EventSource("/api/events");
    } catch {
      schedule();
      return;
    }
    es = stream;
    stream.onmessage = (ev) => {
      if (dead || es !== stream) return;
      let data = null;
      try { data = JSON.parse(ev.data); } catch { return; }
      if (!data || data.type === "hello" || data.type === "heartbeat") return;
      delay = retryBase;
      fails = 0;
      const record = data.record || data;
      try { onRecord && onRecord(record); } catch (e) { console.error(e); }
    };
    stream.onerror = () => {
      if (dead || es !== stream) return;
      try { stream.close(); } catch {}
      if (es === stream) es = null;
      fails++;
      schedule();
    };
  }

  open();

  return {
    get failures() { return fails; },
    close() {
      dead = true;
      try { es && es.close(); } catch {}
      es = null;
    },
  };
}
