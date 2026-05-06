# TOOLS

OmniClaw runtime tools include:
- time_now
- runtime_summary, provider_status, v2_status, v2_repair_plan, capability_demo
- list_files, read_file, write_file, append_file
- OpenClaw-compatible aliases: read, write, edit, apply_patch
- exec, process, code_execution
- remember_note, list_notes, list_long_term_memory, promote_memory, dream_memory_sweep
- memory_search, memory_get
- create_task, list_tasks, run_task
- web_research, read_url, web_search, x_search, web_fetch
- computer_access_status
- list_computer_directory, read_computer_file, write_computer_file, create_computer_directory
- delete_computer_path, which moves deleted items to data/trash unless permanent delete is explicitly enabled
- browser, browser_status, browser_screenshot, browser_text, and open_browser_url for browser automation / URL fetch
- run_terminal_command and plan_shell_command through governed shell execution and audit logs
- sandbox_status, sandbox_run, and sandbox_apply for temp-workspace dry runs before applying changes
- openclaw_vendor_status, openclaw_skill_scan, openclaw_skill_import, and openclaw_skill_pack_import for using the vendored OpenClaw reference safely
- message, sessions_list, sessions_history, sessions_send, sessions_spawn, sessions_yield, session_status
- subagents and agents_list
- nodes, cron, gateway
- image, image_generate, music_generate, video_generate, tts compatibility tools
- apply_provider_profile, set_provider_key, get_provider_key_status, test_provider_profile
- delegate_task for multi-agent routing
- create_skill for local skill authoring
- plugin tools from enabled plugins

Loaded local skills include memory, research/planning, review, OpenClaw tool-loop, filesystem, browser/web, sessions/agents, gateway ops, media, and safety governance unless an agent blocks them.

Use tools deliberately. Prefer safe reads before writes. Computer access is powerful: explain destructive actions, keep deletes recoverable through data/trash, and do not touch Windows, Program Files, ProgramData, or drive roots.
