import { analyzeShellCommand } from "./shell-policy.js";

export class ShellPlanner {
  constructor(configStore = null) {
    this.configStore = configStore;
  }

  getPolicy() {
    const config = this.configStore?.getConfig?.() || {};
    return config.tools?.shellExecution || {};
  }

  buildRequest(command, reason) {
    const policy = analyzeShellCommand(command, this.getPolicy());
    const requiresApproval = policy.requiresApproval !== false;
    return {
      approved: !requiresApproval,
      command,
      reason,
      risk: policy.risk,
      allowlisted: policy.allowlisted,
      allowlistMode: policy.allowlistMode,
      trustLevel: policy.trustLevel,
      requiresApproval,
      matchedAllowlist: policy.matchedAllowlist,
      blockedPattern: policy.blockedPattern,
      riskReasons: policy.reasons,
      status: requiresApproval ? "approval-required" : "auto-approved",
      message:
        policy.risk === "blocked"
          ? "OmniClaw blocked this shell action by policy. Review the risk details before changing policy."
          : requiresApproval
            ? "OmniClaw prepared a shell action. Execution requires explicit approval."
            : "OmniClaw auto-approved this shell action under the current trust level.",
    };
  }
}
