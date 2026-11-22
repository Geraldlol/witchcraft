---
name: Bug report or setup help
about: Report a problem or get help setting up WITCHCRAFT.
---

## What happened?

Describe what you expected and what happened instead. If setup stopped, name the step or command.

## How to reproduce

List the steps that lead to the problem.

## Your setup

- WITCHCRAFT release or commit:
- WoW Forever client build:
- OS and display environment (Windows 10/11, or Linux X11/XWayland + Wine/Proton version):
- Node.js version (`node --version`):
- Assistant and version (Claude Code, Codex CLI, GitHub Copilot CLI, Google Antigravity CLI, or combination):

Leave anything you cannot determine as unknown.

## Diagnostics (optional)

From `tools/witchcraft-daemon`, run `node bin/witchcraft.js doctor --json` and paste the redacted report. Add `--only` with your assistant if you use a single tab.

Include the relevant daemon error, `/witch status` output, or a screenshot if it helps. Share only the short section needed to explain the problem; remove account names, private paths, prompts, tokens, and other personal information.
