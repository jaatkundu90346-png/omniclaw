export class IntentEngine {
  detect(message) {
    const lowered = message.toLowerCase();

    const intents = [];
    const compact = lowered.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const slashCommand = lowered.match(/^\/([a-z0-9_-]+)\b/);

    if (slashCommand) {
      const command = slashCommand[1];
      const commandMap = {
        doctor: "hermes-doctor",
        status: "hermes-doctor",
        health: "hermes-doctor",
        model: "hermes-model",
        models: "hermes-model",
        skills: "hermes-skills",
        tools: "hermes-skills",
        usage: "hermes-usage",
        context: "hermes-usage",
        memory: "hermes-usage",
        platforms: "hermes-platforms",
        gateways: "hermes-platforms",
        channels: "hermes-platforms",
        hermes: "hermes-reference",
      };
      if (commandMap[command]) {
        intents.push(commandMap[command]);
      }
    }

    if (/^(hi|hii|hello|hey|hlo|helo|salam|assalam|namaste|yo)\b/i.test(compact)) {
      intents.push("greeting");
    }

    const setupUiOnly =
      /\bsetup\s+(screen|panel|page|ui|view|card|section)\b/i.test(lowered) &&
      !/\b(api\s*key|apikey|byok|base\s*url|endpoint|token|save\s+brain|configure\s+provider|model\s*(?:is|=|:))\b/i.test(lowered);
    if (!setupUiOnly && (
      lowered.includes("api key") ||
      lowered.includes("apikey") ||
      lowered.includes("byok") ||
      lowered.includes("brain") ||
      lowered.includes("mind") ||
      /\b(provider|model|openrouter|nvidia|openai|anthropic|minimax|glm|codex)\b.*\b(setup|configure|save|key)\b/i.test(lowered) ||
      /\b(setup|configure|save)\b.*\b(provider|model|api key|apikey|byok|base url|endpoint)\b/i.test(lowered)
    )) {
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

    const mentionsAgentProject =
      lowered.includes("codex") ||
      lowered.includes("openclaw") ||
      lowered.includes("hermes") ||
      lowered.includes("omniclaw") ||
      lowered.includes("v2");
    const asksAgentBuild =
      lowered.includes("weak") ||
      lowered.includes("kami") ||
      lowered.includes("improve") ||
      lowered.includes("upgrade") ||
      lowered.includes("build karo") ||
      lowered.includes("khud ko build") ||
      lowered.includes("self build") ||
      lowered.includes("scratch build") ||
      lowered.includes("hands aur eyes") ||
      lowered.includes("frontend rebuild");
    if ((mentionsAgentProject && asksAgentBuild) || lowered.includes("self build") || lowered.includes("scratch build")) {
      intents.push("self-build");
    }

    if (
      lowered.includes("real task") ||
      lowered.includes("real-task") ||
      lowered.includes("product bna") ||
      lowered.includes("product bana") ||
      lowered.includes("product ready") ||
      lowered.includes("tools skills") ||
      lowered.includes("tools aur skills") ||
      lowered.includes("skills tools") ||
      lowered.includes("strong bna") ||
      lowered.includes("strong bana") ||
      lowered.includes("fake reply") ||
      lowered.includes("actual kaam") ||
      lowered.includes("sach me kaam")
    ) {
      intents.push("real-task-hardening");
    }

    if (
      lowered.includes("hermes agent") ||
      lowered.includes("hermes-agent") ||
      lowered.includes("hermes alternative") ||
      lowered.includes("openclaw alternative")
    ) {
      intents.push("hermes-reference");
    }

    if (
      lowered.includes("hermes tools") ||
      lowered.includes("hermes ke tools") ||
      lowered.includes("hermes ka tools") ||
      lowered.includes("toolset") ||
      lowered.includes("tools & toolsets") ||
      lowered.includes("copy hermes tools") ||
      lowered.includes("40+ tools") ||
      lowered.includes("40 tools")
    ) {
      intents.push("hermes-tools");
    }

    if (
      lowered.includes("context compression") ||
      lowered.includes("context compressor") ||
      lowered.includes("token budget") ||
      lowered.includes("summary framing") ||
      lowered.includes("smart model routing")
    ) {
      intents.push("context-compression");
    }

    if (
      lowered.includes("memory system") ||
      lowered.includes("memory lifecycle") ||
      lowered.includes("session search") ||
      lowered.includes("fts5") ||
      lowered.includes("prefetch_all") ||
      lowered.includes("sync_all")
    ) {
      intents.push("memory-lifecycle");
    }

    if (
      lowered.includes("skills system") ||
      lowered.includes("skill system") ||
      lowered.includes("progressive disclosure") ||
      lowered.includes("agentskills") ||
      lowered.includes("skill self") ||
      lowered.includes("skill_manage")
    ) {
      intents.push("skill-system");
    }

    if (
      lowered.includes("messaging gateway") ||
      lowered.includes("gateway process") ||
      lowered.includes("session routing") ||
      lowered.includes("voice transcription") ||
      lowered.includes("dm pairing") ||
      lowered.includes("telegram") ||
      lowered.includes("discord") ||
      lowered.includes("whatsapp") ||
      lowered.includes("slack") ||
      lowered.includes("signal")
    ) {
      intents.push("messaging-gateway");
    }

    if (
      lowered.includes("terminal backend") ||
      lowered.includes("terminal backends") ||
      lowered.includes("persistent environment") ||
      lowered.includes("process registry") ||
      lowered.includes("approval gate") ||
      lowered.includes("docker") ||
      lowered.includes("ssh backend") ||
      lowered.includes("daytona") ||
      lowered.includes("modal") ||
      lowered.includes("singularity")
    ) {
      intents.push("terminal-backends");
    }

    if (
      lowered.includes("multi-provider") ||
      lowered.includes("model support") ||
      lowered.includes("api mode") ||
      lowered.includes("credential pool") ||
      lowered.includes("smart failover") ||
      lowered.includes("rate limit tracker") ||
      lowered.includes("openrouter") ||
      lowered.includes("anthropic_messages") ||
      lowered.includes("chat_completions") ||
      lowered.includes("codex_responses")
    ) {
      intents.push("model-provider");
    }

    if (
      lowered.includes("subagent delegation") ||
      lowered.includes("delegate_task") ||
      lowered.includes("isolation guarantee") ||
      lowered.includes("shared iteration budget") ||
      lowered.includes("parallelism")
    ) {
      intents.push("subagent-delegation");
    }

    if (
      lowered.includes("mcp integration") ||
      lowered.includes("model context protocol") ||
      lowered.includes("mcp server") ||
      lowered.includes("mcp tools") ||
      lowered.includes("acp adapter") ||
      lowered.includes("explicit server aliases") ||
      lowered.includes("mcp serves")
    ) {
      intents.push("mcp-integration");
    }

    if (
      lowered.includes("trajectory generation") ||
      lowered.includes("rl training") ||
      lowered.includes("research-grade data") ||
      lowered.includes("trajectory compressor") ||
      lowered.includes("batch runner") ||
      lowered.includes("mini_swe") ||
      lowered.includes("skip context files")
    ) {
      intents.push("trajectory-training");
    }

    if (
      lowered.includes("closed learning loop") ||
      lowered.includes("learning loop") ||
      lowered.includes("memory nudge") ||
      lowered.includes("skill auto") ||
      lowered.includes("next interaction") ||
      lowered.includes("honcho")
    ) {
      intents.push("closed-learning-loop");
    }

    if (
      lowered.includes("what can hermes do") ||
      (
        lowered.includes("use cases") &&
        (
          lowered.includes("trajectory generation") ||
          lowered.includes("rl training") ||
          lowered.includes("closed learning loop") ||
          lowered.includes("design principles") ||
          lowered.includes("architecture")
        )
      ) ||
      (
        lowered.includes("hermes") &&
        (
          lowered.includes("use cases") ||
          lowered.includes("software engineering") ||
          lowered.includes("devops") ||
          lowered.includes("ml research") ||
          lowered.includes("team workflows") ||
          lowered.includes("personal assistant")
        )
      )
    ) {
      intents.push("hermes-use-cases");
    }

    if (
      lowered.includes("design principles") ||
      lowered.includes("key design principles") ||
      lowered.includes("openai-compatible everywhere") ||
      lowered.includes("stateless prompt") ||
      lowered.includes("one external memory") ||
      lowered.includes("idempotent tool") ||
      lowered.includes("platform-aware formatting") ||
      lowered.includes("ephemeral data")
    ) {
      intents.push("design-principles");
    }

    if (
      lowered.includes("cron scheduler") ||
      lowered.includes("built-in cron") ||
      lowered.includes("cronjob") ||
      lowered.includes("schedule") ||
      lowered.includes("scheduled task") ||
      lowered.includes("unattended operation")
    ) {
      intents.push("cron-scheduler");
    }

    if (
      (lowered.includes("openclaw") && (
        lowered.includes("code study") ||
        lowered.includes("codebase study") ||
        lowered.includes("sara code") ||
        lowered.includes("source code") ||
        lowered.includes("study guide") ||
        lowered.includes("implement karna") ||
        lowered.includes("implement karo")
      )) ||
      lowered.includes("omniclaw_study_guide")
    ) {
      intents.push("openclaw-code-study");
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
      lowered.includes("hermes architecture") ||
      lowered.includes("runtime status") ||
      lowered.includes("gateway status") ||
      lowered.includes("tools aur skills") ||
      lowered.includes("tools and skills") ||
      lowered.includes("demo do")
    ) {
      intents.push("layer-status");
    }

    if (
      lowered.includes("system prompt") ||
      lowered.includes("prompt assembly") ||
      lowered.includes("agent loop") ||
      lowered.includes("core agent loop") ||
      lowered.includes("context file") ||
      lowered.includes("prompt injection") ||
      lowered.includes("architecture ko samjho") ||
      lowered.includes("architacture ko samjho")
    ) {
      intents.push("prompt-assembly");
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
      lowered.includes("who are you") ||
      lowered.includes("what is your name") ||
      lowered.includes("your name") ||
      lowered.includes("who am i") ||
      lowered.includes("what is my name") ||
      lowered.includes("my name") ||
      lowered.includes("tum kon ho") ||
      lowered.includes("tum kaun ho") ||
      lowered.includes("tu kon hai") ||
      lowered.includes("tu kaun hai") ||
      lowered.includes("tera name") ||
      lowered.includes("tara name") ||
      lowered.includes("tumhara name") ||
      lowered.includes("tera naam") ||
      lowered.includes("mara name") ||
      lowered.includes("mera name") ||
      lowered.includes("mera naam") ||
      lowered.includes("mara naam") ||
      lowered.includes("mujhe jante") ||
      lowered.includes("mujha janta") ||
      lowered.includes("mere baare") ||
      lowered.includes("mara bara")
    ) {
      intents.push("profile-question");
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
      lowered.includes("puri laptop") ||
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
      lowered.includes("search file") ||
      lowered.includes("find file") ||
      lowered.includes("search laptop") ||
      lowered.includes("search computer") ||
      lowered.includes("laptop ki files") ||
      lowered.includes("puri laptop ki files") ||
      lowered.includes("pura laptop") ||
      lowered.includes("puri laptop") ||
      /\b(?:check|cheack|dekh|dakh|dhund|dhoond|find|search)\b[\s\S]{0,80}\b(?:file|folder)\b[\s\S]{0,80}\b(?:laptop|computer|pc)\b/i.test(lowered) ||
      /\b(?:laptop|computer|pc)\b[\s\S]{0,80}\b(?:file|folder)\b[\s\S]{0,80}\b(?:check|cheack|dekh|dakh|dhund|dhoond|find|search)\b/i.test(lowered) ||
      /\bkoi\b[\s\S]{0,60}\b(?:file|folder)\b[\s\S]{0,80}\b(?:laptop|computer|pc)\b/i.test(lowered)
    ) {
      intents.push("computer-search");
    }

    if (
      lowered.includes("browser status") ||
      lowered.includes("browser snapshot") ||
      lowered.includes("browser observe") ||
      lowered.includes("inspect browser") ||
      lowered.includes("page snapshot") ||
      lowered.includes("screenshot browser")
    ) {
      intents.push("browser-observe");
    }

    if (
      lowered.includes("open browser") ||
      lowered.includes("browser open") ||
      lowered.includes("browser ma open") ||
      lowered.includes("browser me open") ||
      lowered.includes("website kholo") ||
      lowered.includes("site kholo") ||
      lowered.includes("url kholo") ||
      lowered.includes("navigate browser") ||
      /\bopen\s+https?:\/\//i.test(lowered) ||
      /\b(?:open|preview|run|chalao|chala|kholo)\b[\s\S]{0,80}\.html\b/i.test(lowered) ||
      /\b(?:open|preview|run|chalao|chala|kholo)\b[\s\S]{0,80}\b(?:generated app|last app|html app|website)\b/i.test(lowered)
    ) {
      intents.push("browser-navigate");
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
      lowered.includes("delete computer") ||
      lowered.includes("delete laptop") ||
      lowered.includes("delete file") ||
      lowered.includes("remove file") ||
      lowered.includes("file delete") ||
      lowered.includes("folder delete")
    ) {
      intents.push("computer-delete");
    }

    if (
      lowered.includes("ram") ||
      lowered.includes("memory") ||
      lowered.includes("storage") ||
      lowered.includes("disk") ||
      lowered.includes("drive") ||
      lowered.includes("system status") ||
      lowered.includes("laptop status") ||
      lowered.includes("computer status") ||
      lowered.includes("server status") ||
      lowered.includes("machine status")
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
      lowered.includes("create a task") ||
      lowered.includes("add task") ||
      lowered.includes("add a task") ||
      lowered.includes("new task")
    ) {
      intents.push("task-create");
    }

    const asksTodoApp = /\b(?:todo|to-do)\b[\s\S]{0,80}\b(?:app|web app|website|features)\b/i.test(lowered);
    if (lowered.includes("tasks") || (lowered.includes("todo list") && !asksTodoApp)) {
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

    const mentionsPackageJson = /\bpackage\.json\b/i.test(lowered);
    const asksProductBuild =
      /\b(?:build|create|make|develop|generate|implement)\b[\s\S]{0,120}\b(?:website|web app|app|clone|application|platform|calculator|todo|prototype|frontend|dashboard)\b/i.test(lowered) ||
      /\b(?:prototype|frontend|dashboard)\b[\s\S]{0,80}\b(?:build|create|make|develop|generate|implement)\b/i.test(lowered);
    const asksOmniBuild =
      (
        /\b(?:repo|repository|project|portable|installer|windows app|release zip|exe)\b/i.test(lowered) ||
        /\b(?:build|rebuild|package)\b[\s\S]{0,80}\bomniclaw\b/i.test(lowered) ||
        /\bomniclaw\b[\s\S]{0,80}\b(?:build|rebuild|package|exe|installer|portable|release)\b/i.test(lowered)
      ) ||
      /^(?:build|rebuild|package|portable build|exe|release zip)\s*(?:karo|kar|bana|bna)?$/i.test(lowered.trim());
    if (!mentionsPackageJson && !asksProductBuild && asksOmniBuild && (
      /\b(build|rebuild|package|portable build|exe|release zip)\b/i.test(lowered) ||
      /\b(build|banao|bnao|package|exe)\s*(karo|kar|bana|bna)\b/i.test(lowered)
    )) {
      intents.push("project-build");
    }

    const looksLikeFileCreation =
      /\b(?:create|write|save)\s+(?:a\s+)?(?:workspace\s+|project\s+)?file\b/i.test(lowered) ||
      /\bsave\s+.*\.\w+\b/i.test(lowered) ||
      /\b(?:file|folder)\b[\s\S]{0,80}\b(?:bna|bana|banao|bnana|banana|create|write|save)\b/i.test(lowered) ||
      /\b(?:bna|bana|banao|bnana|banana|create|write|save)\b[\s\S]{0,80}\b(?:file|folder)\b/i.test(lowered);
    const looksLikeFileOperation =
      looksLikeFileCreation ||
      /\b(?:read|open|show|delete|remove)\s+(?:a\s+)?(?:workspace\s+|project\s+)?file\b/i.test(lowered) ||
      /\b[A-Za-z0-9._\/\\-]+\.(?:txt|html|js|css|json|md|py|ts|csv)\b/i.test(message);
    const looksLikeShellAction =
      lowered.includes("run command") ||
      lowered.includes("run shell") ||
      lowered.includes("run terminal") ||
      lowered.includes("terminal command") ||
      lowered.includes("powershell command") ||
      lowered.includes("command chala") ||
      lowered.includes("cmd chala");
    const artifactVerificationOnly =
      /\b(?:verify_html_artifact|html artifact|artifact)\b/i.test(lowered) ||
      /\b(?:prototype|frontend|clone|web prototype)\b/i.test(lowered);
    const browserOnlyCheck =
      intents.includes("browser-observe") ||
      intents.includes("browser-navigate") ||
      /\bbrowser\b[\s\S]{0,80}\b(?:status|doctor|health|ready|available|snapshot|inspect|observe|open|navigate)\b/i.test(lowered);
    if (!browserOnlyCheck && !looksLikeFileOperation && !looksLikeShellAction && !asksProductBuild && !artifactVerificationOnly && (/\b(test|verify|check)\b(?!\s*\.)\s*(karo|kar|run)?\b/i.test(lowered) || lowered.includes("smoke test"))) {
      intents.push("project-test");
    }

    if (lowered.includes("release") || lowered.includes("zip banao") || lowered.includes("zip build")) {
      intents.push("project-release");
    }

    if (/\btime\b/i.test(lowered)) {
      intents.push("time");
    }

    if (
      lowered.includes("read file") ||
      lowered.includes("open file") ||
      lowered.includes("show file") ||
      lowered.startsWith("read ")
    ) {
      if (/\b(?:laptop|computer|pc|desktop|downloads|documents)\b/i.test(lowered) || /[a-z]:[\\/]/i.test(message)) {
        intents.push("computer-file-read");
      } else {
        intents.push("file-read");
      }
    }

    if (
      lowered.includes("list files") ||
      lowered.includes("show files") ||
      lowered.includes("list folder") ||
      lowered.includes("list directory") ||
      /\blist\b[\s\S]{0,40}\bfiles\b/.test(lowered) ||
      /\blist\b[\s\S]{0,60}\b(?:folder|directory)\b/.test(lowered)
    ) {
      if (/\b(?:laptop|computer|pc|desktop|downloads|documents|home folder)\b/i.test(lowered) || /[a-z]:[\\/]/i.test(message)) {
        intents.push("computer-directory-list");
      } else {
        intents.push("file-list");
      }
    }

    const workspacePathHint =
      /\bdata[\\/]+generated\b/i.test(message) ||
      /\b(?:workspace|repo|repository|project folder|under\s+data|inside\s+data)\b/i.test(lowered);
    const explicitComputerScope = !workspacePathHint && (
      /\b(?:laptop|computer|pc|downloads|documents|home folder)\b/i.test(lowered) ||
      /\bdesktop\s+(?:folder|directory|file|path)\b/i.test(lowered) ||
      /[a-z]:[\\/]/i.test(message)
    );

    if (
      looksLikeFileCreation ||
      lowered.includes("write file") ||
      lowered.includes("create file") ||
      /create\s+a\s+file/i.test(lowered) ||
      /create\s+(?:a\s+)?(?:computer|laptop|pc|desktop)\s+file/i.test(lowered) ||
      /(?:computer|laptop|pc|desktop)\s+file\s+(?:banao|bnao|create|write|save)/i.test(lowered) ||
      /\b(?:file|folder)\b[\s\S]{0,80}\b(?:bna|bana|banao|bnana|banana|create|write|save)\b/i.test(lowered) ||
      /\b(?:bna|bana|banao|bnana|banana|create|write|save)\b[\s\S]{0,80}\b(?:file|folder)\b/i.test(lowered) ||
      /save\s+(it\s+)?(as|to)\s+\S+\.\w+/i.test(lowered) ||
      lowered.includes("save file") ||
      lowered.includes("append file") ||
      /\bsave\s+.*\.(txt|html|js|css|json|md|py|ts|csv)\b/i.test(lowered)
    ) {
      if (explicitComputerScope) {
        intents.push("computer-file-write");
      } else {
        intents.push("file-write");
      }
    }

    if (
      lowered.includes("research") ||
      lowered.includes("reasearch") ||
      lowered.includes("reaserach") ||
      lowered.includes("search web") ||
      lowered.includes("look up") ||
      lowered.includes("find on web")
    ) {
      intents.push("research");
    }

    if (
      /build[\s\S]{0,180}(?:website|app|system|clone|application|platform|prototype|frontend|dashboard)/i.test(lowered) ||
      /(?:prototype|frontend|dashboard)[\s\S]{0,120}(?:build|create|make|develop|generate|implement)/i.test(lowered) ||
      /create.*(?:full.*stack|complete|entire|web.*app|mobile.*app)/i.test(lowered) ||
      /create.*(?:html page|website|web page)/i.test(lowered) ||
      /develop.*(?:application|platform|service|system)/i.test(lowered) ||
      /make.*(?:similar to|like|clone of|jaisa|jasi)/i.test(lowered) ||
      lowered.includes("netflix") ||
      lowered.includes("youtube") ||
      lowered.includes("twitter") ||
      lowered.includes("instagram") ||
      lowered.includes("facebook") ||
      lowered.includes("whatsapp")
    ) {
      intents.push("complex-build");
    }

    if (
      (lowered.includes("research") && (
        /\bthen\s+(?:build|create|make|develop|generate|implement)\b/i.test(lowered) ||
        /\band\s+(?:build|create|make|develop|generate|implement)\b/i.test(lowered) ||
        /\b(?:build|create|make|develop|generate|implement)\b/i.test(lowered) ||
        /\b(?:phir|uske baad)\s+(?:build|create|make|develop|generate|implement|bna|banao)\b/i.test(lowered)
      )) ||
      lowered.includes("research and build") ||
      lowered.includes("research then build")
    ) {
      intents.push("research-then-build");
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

    if (
      lowered.includes("fetch model") ||
      lowered.includes("fetch models") ||
      lowered.includes("list model") ||
      lowered.includes("list models") ||
      lowered.includes("available model") ||
      lowered.includes("model choose") ||
      lowered.includes("model chose") ||
      lowered.includes("model select")
    ) {
      intents.push("provider-model-list");
    }

    if (lowered.includes("plugin echo")) {
      intents.push("plugin-echo");
    }

    if (
      looksLikeShellAction
    ) {
      intents.push("shell-plan");
    }

    if (intents.length === 0) {
      intents.push("general");
    }

    return intents;
  }
}
