export class MockProvider {
  constructor(configStore, options = {}) {
    this.configStore = configStore;
    this.options = options;
  }

  getInfo() {
    return {
      id: "mock/local-rule-engine",
      mode: "offline",
      ready: false,
      apiKeyConfigured: false,
      apiKeySource: "offline",
      message: this.options.message || "Offline mock brain is disabled. Configure BYOK/API provider for real replies.",
      fallbackFrom: this.options.fallbackFrom || "",
    };
  }

  async respond(context) {
    const provider = this.configStore.getConfig().provider || {};
    const mode = provider.mode || "mock";
    return [
      "Real provider is not configured, so OmniClaw did not generate a fake local answer.",
      `Current provider mode: ${mode}.`,
      "Open Brain setup, choose a BYOK/OpenAI-compatible provider, add API key, fetch models, test, then save.",
    ].join(" ");
  }

  async respondLegacy(context) {
    const skillNames = context.skills.map((skill) => skill.name);
    const recentCount = context.recentConversations.length;
    const intents = context.intents.join(", ");
    const researchCount = context.research.length;
    const artifactCount = context.artifacts.length;
    const longTermCount = context.longTermMemory?.length || 0;
    const contextReport = context.contextBundle?.report;

    if (context.intents.includes("greeting")) {
      return [
        "Haan, main ready hoon.",
        "OmniClaw abhi offline task engine par chal raha hai, isliye basic hands/eyes kaam kar sakte hain: build, test, files, tasks, memory, aur safe commands.",
        "Real brain ke liye BYOK/API key connect karo, phir LLM planning aur final replies zyada smart ho jayengi.",
      ].join(" ");
    }

    if (context.intents.includes("api-setup")) {
      return [
        "API key OmniClaw ka brain connect karti hai.",
        "OmniClaw khud hands aur eyes rahega: files dekhna, commands chalana, builds/tests karna, logs aur system state inspect karna.",
        "Setup ke liye BYOK panel me provider choose karo, API key paste karo, Save provider dabao, phir Test readiness.",
        "Key missing ho to OmniClaw offline mode me safe local tasks chala sakta hai, lekin reasoning real LLM jaisi nahi hogi.",
      ].join(" ");
    }

    if (context.intents.includes("capabilities")) {
      const toolNames = (context.tools || []).map((tool) => tool.id).slice(0, 12);
      const skillList = (context.skills || []).map((skill) => `${skill.name} (${skill.id})`);
      return [
        "Main OmniClaw platform ke andar chal raha active agent hoon, sirf generic chat AI nahi.",
        "OmniClaw khud ek agent nahi; woh gateway/runtime hai jo agents ko identity, memory, tools, skills, sessions, aur channels deta hai.",
        `Mere paas ${context.tools?.length || 0} runtime tools hain: ${toolNames.join(", ") || "none loaded"}.`,
        `Loaded skills: ${skillList.join(", ") || "abhi koi matching skill nahi, lekin skill registry available hai"}.`,
        "Main files read/write, tasks, memory, research, build/test commands, provider setup, shell approval, agents/delegation, aur local workspace operations kar sakta hoon.",
      ].join(" ");
    }

    let reply = `OmniClaw processed your request with the ${context.profile.id} profile. `;
    reply += `Detected intent(s): ${intents || "general"}. `;

    if (skillNames.length > 0) {
      reply += `Matched skill(s): ${skillNames.join(", ")}. `;
    }

    if (context.toolOutputs.length > 0) {
      reply += this.renderToolOutputs(context.toolOutputs);
    } else {
      reply += `No tool execution was needed. `;
    }

    if (context.intents.includes("planning")) {
      reply += `This request benefits from a product-first plan: keep the runtime lean, add provider adapters, then grow into safe automation and integrations. `;
    }

    if (context.intents.includes("shell-plan")) {
      reply += `Shell actions are being handled as approval-oriented plans instead of blind execution. `;
    }

    if (context.intents.includes("research")) {
      reply += `Lightweight web research was requested, so OmniClaw tried to gather quick public-source results. `;
    }

    if (context.intents.includes("file-write")) {
      reply += `File writes are restricted to protected writable roots to keep the workspace safer. `;
    }

    if (context.intents.includes("skill-create")) {
      reply += `OmniClaw can now add local skills through its own customization layer. `;
    }

    if (context.intents.includes("config-update")) {
      reply += `Runtime customization is now available through controlled config updates. `;
    }

    if (context.toolOutputs.length > 0) {
      reply += `Memory now has ${recentCount} recent item(s), ${longTermCount} long-term item(s), ${researchCount} research item(s), and ${artifactCount} artifact(s). `;
      if (contextReport) {
        reply += `Context used ${contextReport.usedChars}/${contextReport.maxChars} chars. `;
      }
    }
    reply += `Offline task engine handled this. Connect an API key when you want the LLM brain to reason over these observations.`;
    return reply;
  }

  renderToolOutputs(toolOutputs = []) {
    const lines = ["Executed tool results:"];

    for (const item of toolOutputs) {
      const output = item.output || {};
      if (item.tool === "plan_shell_command") {
        const execution = output.execution;
        if (execution) {
          const stdout = String(execution.stdout || "").trim();
          const stderr = String(execution.stderr || "").trim();
          lines.push(
            `- ${execution.command}: ${execution.status}${execution.exitCode == null ? "" : ` (exit ${execution.exitCode})`}.`,
          );
          if (stdout) {
            lines.push(`  stdout: ${this.truncate(stdout, 900)}`);
          }
          if (stderr) {
            lines.push(`  stderr: ${this.truncate(stderr, 900)}`);
          }
          continue;
        }

        lines.push(`- ${output.command || "shell command"}: ${output.status || "planned"}. ${output.message || ""}`.trim());
        if (output.approvalId) {
          lines.push(`  approval required: ${output.approvalId}`);
        }
        continue;
      }

      if (item.tool === "write_file" || item.tool === "append_file") {
        lines.push(`- ${item.tool}: wrote ${output.bytesWritten || 0} bytes to ${output.path || "unknown path"}.`);
        continue;
      }

      if (item.tool === "create_task") {
        lines.push(`- create_task: created ${output.task?.id || "task"} - ${output.task?.title || ""}`.trim());
        continue;
      }

      if (item.tool === "self_build_plan") {
        lines.push("- self_build_plan: Codex + OpenClaw architecture mapped into OmniClaw.");
        lines.push(`  brain: ${output.architecture?.brain || "unknown"}`);
        lines.push(`  hands: ${(output.architecture?.hands || []).slice(0, 5).join(", ")}`);
        lines.push(`  eyes: ${(output.architecture?.eyes || []).slice(0, 5).join(", ")}`);
        lines.push(
          `  next: ${(output.implementationPlan || [])
            .filter((step) => step.status === "next" || step.status === "in_progress")
            .map((step) => step.step)
            .join(" -> ")}`,
        );
        continue;
      }

      if (item.tool === "layer_status") {
        const summary = output.summary || {};
        lines.push("- layer_status: OpenClaw-style layer report generated from live OmniClaw runtime.");
        lines.push(
          `  summary: ${summary.readyLayers || 0} ready layer(s), ${summary.partialLayers || 0} partial layer(s), ${summary.missingLayers || 0} missing layer(s); ${summary.tools || 0} tool(s), ${summary.skills || 0} skill(s), ${summary.sessions || 0} session(s).`,
        );
        for (const layer of (output.layers || []).slice(0, 5)) {
          lines.push(
            `  L${layer.id} ${layer.name}: ${layer.status} (${layer.readyCount} ready, ${layer.partialCount} partial, ${layer.missingCount} missing).`,
          );
        }
        if (output.nextUpgrades?.length) {
          lines.push(`  next upgrade: ${output.nextUpgrades[0]}`);
        }
        continue;
      }

      if (item.tool === "run_task") {
        lines.push(`- run_task: ${output.status || "unknown"} - ${output.summary || output.message || ""}`.trim());
        continue;
      }

      if (item.tool === "computer_access_status") {
        lines.push("- computer_access_status: laptop operator tools are configured.");
        lines.push(`  roots: ${(output.allowedRoots || []).join(", ") || "none"}`);
        lines.push(`  files: write=${output.allowWrite ? "on" : "off"}, delete=${output.allowDelete ? "on" : "off"}, mode=${output.deleteMode || "unknown"}`);
        lines.push(`  terminal: ${output.terminal?.enabled ? "on" : "off"}, trust=${output.terminal?.trustLevel || "unknown"}, cwd=${output.terminal?.cwd || "."}`);
        lines.push(`  browser: open_url=${output.browser?.openUrl ? "on" : "off"}, read_url=${output.browser?.readUrl ? "on" : "off"}`);
        continue;
      }

      if (item.tool === "list_computer_directory") {
        lines.push(`- list_computer_directory: ${output.entries?.length || 0} item(s) in ${output.path || "path"}.`);
        continue;
      }

      if (item.tool === "read_computer_file") {
        lines.push(`- read_computer_file: read ${output.bytesRead || 0}/${output.totalBytes || 0} bytes from ${output.path || "path"}.`);
        continue;
      }

      if (item.tool === "write_computer_file") {
        lines.push(`- write_computer_file: wrote ${output.bytesWritten || 0} bytes to ${output.path || "path"}.`);
        continue;
      }

      if (item.tool === "delete_computer_path") {
        lines.push(`- delete_computer_path: ${output.deleted ? "deleted" : "not deleted"} ${output.path || "path"}${output.movedTo ? ` -> ${output.movedTo}` : ""}.`);
        continue;
      }

      if (item.tool === "open_browser_url") {
        lines.push(`- open_browser_url: opened ${output.url || "url"} in ${output.app || "browser"}.`);
        continue;
      }

      if (item.tool === "run_terminal_command") {
        const stdout = String(output.stdout || "").trim();
        const stderr = String(output.stderr || "").trim();
        lines.push(`- run_terminal_command: ${output.command || "command"} -> ${output.status || "unknown"}${output.exitCode == null ? "" : ` (exit ${output.exitCode})`}.`);
        if (stdout) {
          lines.push(`  stdout: ${this.truncate(stdout, 900)}`);
        }
        if (stderr) {
          lines.push(`  stderr: ${this.truncate(stderr, 900)}`);
        }
        continue;
      }

      if (output.error || output.blocked) {
        lines.push(`- ${item.tool}: ${output.message || output.reason || "failed"}`);
        continue;
      }

      lines.push(`- ${item.tool}: ${this.truncate(JSON.stringify(output), 700)}`);
    }

    return `${lines.join(" ")} `;
  }

  truncate(value, max = 900) {
    const text = String(value || "");
    return text.length > max ? `${text.slice(0, max - 18).trimEnd()}...[truncated]` : text;
  }

  async complete(messages) {
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
    
    let text = "Mock completion response.";
    
    if (lastUser.includes("Summarize")) {
      text = "This is a mock summary of the conversation. User wants to build OmniClaw.";
    } else if (lastUser.includes("Generate a multi-step plan")) {
      text = JSON.stringify({
        summary: "Mock multi-step plan.",
        steps: [
          { type: "tool", tool: "time_now", input: {}, reason: "Mock planning step" }
        ]
      });
    } else if (lastUser.includes("score them for long-term storage")) {
      text = JSON.stringify([
        { id: "note:1", score: 0.9, reason: "High importance mock score", title: "Important Note", tags: ["mock"] }
      ]);
    }

    return { text };
  }

  async respondStream(context) {
    const self = this;
    const reply = await this.respond(context);
    return new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const chunkSize = 8;
        for (let i = 0; i < reply.length; i += chunkSize) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "token", content: reply.slice(i, i + chunkSize) })}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      },
    });
  }
}
