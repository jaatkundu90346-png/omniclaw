# OmniClaw Build Plan

## Goal

Build a local-first, Windows-friendly, OpenClaw-inspired assistant with a lightweight full-stack architecture and a clean path to expansion.

## Product direction

OmniClaw should feel like:

- your own assistant runtime
- simple to run locally
- easy to inspect and hack
- modular enough to grow into a bigger platform

## Architecture

### 1. Frontend

- Vanilla HTML/CSS/JS for low overhead
- Single dashboard for chat, memory, skills, tools, and agent state

### 2. Local API server

- Native Node HTTP server
- JSON endpoints only
- no database dependency for milestone 1

### 3. Agent core

- planner
- memory manager
- skill matcher
- tool executor
- provider adapter
- response composer

### 4. Persistence

- JSON files in `data/`
- easy to inspect and back up

### 5. Skills

- file-based skills
- metadata plus instruction body
- future-ready for marketplace import

### 6. Tools

- safe built-in tools first
- strict allowlist
- future permission model per tool

## Milestones

### Milestone 1

- local server
- local web app
- chat loop
- memory persistence
- starter skills
- starter tools
- simple planning trace

### Milestone 2

- model provider adapters
- config profiles
- permissions
- import/export skills
- task list execution

### Milestone 3

- browser automation
- channel connectors
- sandboxed execution
- background jobs

## Suggested next upgrades

1. Add OpenAI-compatible provider support
2. Add safe shell/file tools with explicit approvals
3. Add browser automation via Playwright
4. Add skill installer format
5. Add multi-agent sessions
6. Add Windows tray app
