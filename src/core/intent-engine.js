export class IntentEngine {
  detect(message) {
    const lowered = message.toLowerCase();

    const intents = [];
    const compact = lowered.replace(/[^\p{L}\p{N}]+/gu, " ").trim();

    if (/^(hi|hii|hello|hey|hlo|helo|salam|assalam|namaste|yo)\b/i.test(compact)) {
      intents.push("greeting");
    }

    if (
      lowered.includes("api key") ||
      lowered.includes("apikey") ||
      lowered.includes("byok") ||
      lowered.includes("brain") ||
      lowered.includes("mind") ||
      lowered.includes("setup")
    ) {
      intents.push("api-setup");
    }

    if (
      lowered.includes("auth") ||
      lowered.includes("authentication") ||
      lowered.includes("login") ||
      lowered.includes("reply nhi") ||
      lowered.includes("reply nahi") ||
      lowered.includes("model kam nhi") ||
      lowered.includes("model kaam nhi") ||
      lowered.includes("codex cli")
    ) {
      intents.push("api-setup");
      intents.push("provider-status");
    }

    if (
      lowered.includes("codex") ||
      lowered.includes("openclaw") ||
      lowered.includes("omniclaw") ||
      lowered.includes("v2") ||
      lowered.includes("weak") ||
      lowered.includes("kami") ||
      lowered.includes("improve") ||
      lowered.includes("upgrade") ||
      lowered.includes("khud ko build") ||
      lowered.includes("self build") ||
      lowered.includes("scratch build") ||
      lowered.includes("hands aur eyes") ||
      lowered.includes("brain")
    ) {
      intents.push("self-build");
    }

    if (
      lowered.includes("v2") ||
      lowered.includes("weak") ||
      lowered.includes("kami") ||
      lowered.includes("improve") ||
      lowered.includes("upgrade") ||
      lowered.includes("pura omniclaw") ||
      lowered.includes("sabhi feature")
    ) {
      intents.push("v2-audit");
    }

    if (
      lowered.includes("layer") ||
      lowered.includes("architecture status") ||
      lowered.includes("openclaw architecture") ||
      lowered.includes("runtime status") ||
      lowered.includes("gateway status") ||
      lowered.includes("tools aur skills") ||
      lowered.includes("tools and skills") ||
      lowered.includes("demo do")
    ) {
      intents.push("layer-status");
    }

    if (
      lowered.includes("what can you do") ||
      lowered.includes("what are your skills") ||
      lowered.includes("your skills") ||
      lowered.includes("capabilities") ||
      lowered.includes("tools do you have") ||
      lowered.includes("kon si skills") ||
      lowered.includes("kya kya kar sakta") ||
      lowered.includes("kya kar sakta") ||
      lowered.includes("tum kya kar") ||
      lowered.includes("tere pas kon si skills") ||
      lowered.includes("tara pas kon si skills") ||
      lowered.includes("apni skills")
    ) {
      intents.push("capabilities");
    }

    if (
      lowered.includes("provider status") ||
      lowered.includes("brain status") ||
      lowered.includes("model status") ||
      lowered.includes("auth status") ||
      lowered.includes("codex status")
    ) {
      intents.push("provider-status");
    }

    if (
      lowered.includes("computer access") ||
      lowered.includes("laptop access") ||
      lowered.includes("pura computer") ||
      lowered.includes("files delete") ||
      lowered.includes("file delete") ||
      lowered.includes("browser access") ||
      lowered.includes("terminal access") ||
      lowered.includes("tools aur skills dani") ||
      lowered.includes("computer dana")
    ) {
      intents.push("computer-access");
    }

    if (
      lowered.includes("copy computer") ||
      lowered.includes("copy laptop") ||
      lowered.includes("copy file") ||
      lowered.includes("file copy")
    ) {
      intents.push("computer-copy");
    }

    if (
      lowered.includes("move computer") ||
      lowered.includes("move laptop") ||
      lowered.includes("move file") ||
      lowered.includes("rename file") ||
      lowered.includes("file move")
    ) {
      intents.push("computer-move");
    }

    if (
      lowered.includes("ram") ||
      lowered.includes("memory") ||
      lowered.includes("storage") ||
      lowered.includes("disk") ||
      lowered.includes("drive") ||
      lowered.includes("system status") ||
      lowered.includes("laptop status")
    ) {
      intents.push("system-status");
    }

    if (lowered.startsWith("remember ") || lowered.includes("save note")) {
      intents.push("remember");
    }

    if (lowered.includes("notes") || lowered.includes("what do you remember")) {
      intents.push("recall");
    }

    if (
      lowered.includes("long term memory") ||
      lowered.includes("memory review") ||
      lowered.includes("promoted memory")
    ) {
      intents.push("memory-list");
    }

    if (
      lowered.includes("dream sweep") ||
      lowered.includes("memory dream") ||
      lowered.includes("dream memory") ||
      lowered.includes("review memory")
    ) {
      intents.push("memory-dream");
    }

    if (
      lowered.startsWith("task ") ||
      lowered.startsWith("todo ") ||
      lowered.includes("create task") ||
      lowered.includes("add task")
    ) {
      intents.push("task-create");
    }

    if (lowered.includes("tasks") || lowered.includes("todo list")) {
      intents.push("task-list");
    }

    if (
      lowered.includes("delegate") ||
      lowered.includes("handoff") ||
      lowered.includes("hand off") ||
      lowered.includes("assign to") ||
      lowered.includes("route to") ||
      lowered.includes("subagent") ||
      lowered.includes("research agent") ||
      lowered.includes("builder agent") ||
      lowered.includes("ops agent") ||
      lowered.includes("agent ko") ||
      lowered.includes("agent se") ||
      lowered.includes("ko de") ||
      lowered.includes("ko do") ||
      lowered.includes("bhej") ||
      lowered.includes("karwa")
    ) {
      intents.push("delegation");
    }

    if (
      lowered.includes("plan") ||
      lowered.includes("design") ||
      lowered.includes("architecture") ||
      lowered.includes("build") ||
      lowered.includes("banao") ||
      lowered.includes("bnao") ||
      lowered.includes("karo")
    ) {
      intents.push("planning");
    }

    if (
      /\b(build|rebuild|package|portable build|exe|release zip)\b/i.test(lowered) ||
      /\b(build|banao|bnao|package|exe)\s*(karo|kar|bana|bna)\b/i.test(lowered)
    ) {
      intents.push("project-build");
    }

    if (/\b(test|verify|check)\s*(karo|kar|run)?\b/i.test(lowered) || lowered.includes("smoke test")) {
      intents.push("project-test");
    }

    if (lowered.includes("release") || lowered.includes("zip banao") || lowered.includes("zip build")) {
      intents.push("project-release");
    }

    if (lowered.includes("time")) {
      intents.push("time");
    }

    if (
      lowered.includes("read file") ||
      lowered.includes("open file") ||
      lowered.includes("show file") ||
      lowered.startsWith("read ")
    ) {
      intents.push("file-read");
    }

    if (
      lowered.includes("list files") ||
      lowered.includes("show files") ||
      lowered.includes("list folder") ||
      lowered.includes("list directory")
    ) {
      intents.push("file-list");
    }

    if (
      lowered.includes("write file") ||
      lowered.includes("create file") ||
      lowered.includes("save file") ||
      lowered.includes("append file")
    ) {
      intents.push("file-write");
    }

    if (
      lowered.includes("research") ||
      lowered.includes("search web") ||
      lowered.includes("look up") ||
      lowered.includes("find on web")
    ) {
      intents.push("research");
    }

    if (
      lowered.includes("run task") ||
      lowered.includes("execute task") ||
      lowered.includes("start task")
    ) {
      intents.push("task-run");
    }

    if (
      lowered.includes("create skill") ||
      lowered.includes("new skill") ||
      lowered.includes("add skill")
    ) {
      intents.push("skill-create");
    }

    if (
      lowered.includes("set profile") ||
      lowered.includes("switch profile") ||
      lowered.includes("set provider") ||
      lowered.includes("change runtime")
    ) {
      intents.push("config-update");
    }

    if (lowered.includes("plugin echo")) {
      intents.push("plugin-echo");
    }

    if (
      lowered.includes("run command") ||
      lowered.includes("run shell") ||
      lowered.includes("run terminal") ||
      lowered.includes("terminal command") ||
      lowered.includes("powershell command") ||
      lowered.includes("command chala") ||
      lowered.includes("cmd chala")
    ) {
      intents.push("shell-plan");
    }

    if (intents.length === 0) {
      intents.push("general");
    }

    return intents;
  }
}
