const fs = require('fs');
let code = fs.readFileSync('src/core/agent.js', 'utf8');

const targetRegex = /let providerDiagnostics = null;\s*if \(!response\) \{\s*const providerStartedAt = new Date\(\)\.toISOString\(\);\s*const providerInfo = this\.provider\.getInfo\?\.\(\) \|\| \{\};\s*this\.gateway\.updateRun\(run\.id, \{[\s\S]*?\}\) \|\| providerResponse;\s*\}/m;

const match = code.match(targetRegex);
if (!match) {
  console.log("Could not find the target block in src/core/agent.js");
  process.exit(1);
}

const replacement = `let providerDiagnostics = null;
      if (!response) {
        const fallbackChain = routedAgent.fallbackChain || [];
        const candidates = [this.provider];
        for (const candidateId of fallbackChain) {
          const p = getProvider(this.config, this.secrets, candidateId);
          if (p) candidates.push(p);
        }

        const providerTimeoutMs = Math.max(
          5000,
          Math.min(45000, Number(this.config.getConfig().provider?.timeoutMs || 45000)),
        );

        let providerResponse = null;
        let outcome = null;
        let finalProviderInfo = null;

        for (let i = 0; i < candidates.length; i++) {
          const candidateProvider = candidates[i];
          const providerStartedAt = new Date().toISOString();
          const providerInfo = candidateProvider.getInfo?.() || {};
          finalProviderInfo = providerInfo;

          this.gateway.updateRun(run.id, {
            providerStatus: "running",
            provider: providerInfo,
            providerStartedAt,
          });
          this.gateway.addEvent("provider.started", {
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
            providerId: providerInfo.id || "unknown",
            model: providerInfo.model || "",
            ready: providerInfo.ready !== false,
          });

          providerResponse = await Promise.race([
            candidateProvider.respond(providerPayload),
            new Promise((resolve) => setTimeout(
              () => resolve(\`Provider request timed out after \${providerTimeoutMs}ms. OmniClaw local tools completed, but the model bridge did not return in time.\`),
              providerTimeoutMs,
            )),
          ]);

          outcome = classifyProviderOutcome(providerResponse);
          providerDiagnostics = {
            ok: outcome.ok,
            status: outcome.ok ? "completed" : "failed",
            reason: outcome.reason,
            message: outcome.message,
            providerId: providerInfo.id || "unknown",
            model: providerInfo.model || "",
            ready: providerInfo.ready !== false,
            startedAt: providerStartedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - Date.parse(providerStartedAt),
          };

          if (outcome.ok) {
            break;
          } else {
            this.gateway.addEvent("provider.failed", {
              runId: run.id,
              sessionId: session.id,
              agentId: routedAgent.id,
              providerId: providerDiagnostics.providerId,
              model: providerDiagnostics.model,
              reason: providerDiagnostics.reason,
              durationMs: providerDiagnostics.durationMs,
            });
            console.error(\`Provider \${providerInfo.id} failed: \${outcome.reason}\`);
          }
        }

        this.gateway.updateRun(run.id, {
          providerStatus: providerDiagnostics.status,
          providerDiagnostics,
        });

        if (outcome.ok) {
          this.gateway.addEvent("provider.completed", {
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
            providerId: providerDiagnostics.providerId,
            model: providerDiagnostics.model,
            reason: providerDiagnostics.reason,
            durationMs: providerDiagnostics.durationMs,
          });
        }

        response = this.buildProviderFailureFallback({
          providerResponse,
          intents,
          message,
          agent: routedAgent,
          tools: availableTools,
          skills: matchedSkills,
          toolOutputs,
        }) || this.buildToolEvidenceCorrection({
          providerResponse,
          message,
          toolOutputs,
        }) || this.buildProviderDriftCorrection({
          providerResponse,
          message,
          toolOutputs,
        }) || this.buildUngroundedToolClaimFallback({
          providerResponse,
          intents,
          toolOutputs,
        }) || providerResponse;
      }`;

code = code.replace(targetRegex, replacement);
fs.writeFileSync('src/core/agent.js', code);
console.log("Patched src/core/agent.js");
