# Changelog

## Unreleased

- Preserve committed DSH reasoning, intermediate replies, tool arguments and textual results in a collapsed final process record. Keep the final answer outside it and retain late results and reasoning-only turns.

- Pass assistant replies and drafts directly as native Rich Markdown, enabling the official task-list, LaTeX, footnote, media, and Rich HTML syntax without a lossy local renderer. Remove rich-to-ordinary fallback and the 24,000-character downgrade; document native limits and integration requirements.

- Render native Rich HTML blocks in final replies and streaming previews: headings, tables, lists, quotations, and dividers. Remove blank-line padding around blocks; replace fixed-width fallback tables with field/value lists and update the injected mobile-formatting guidance.

- Route Telegram native Stop and `/stop` through one current-task cancellation handler, including paused previews and pending user questions, without draft-ID gating.
- Remove legacy preview adapters, per-message cleanup fallback, historical session membership repair, legacy installer-marker migration, and WSL setup/run wrappers. Use `pnpm build` and `bash install.sh` for local updates.

- Include output-format constraints in the existing Telegram channel system context, so Telegram sessions receive them automatically without editing AGENTS.md.

- Bound Telegram API requests, including response-body reads, so a stalled request cannot permanently block subsequent replies. Draft requests time out after 5 seconds; other calls after 15 seconds, with additional time for long polling. Long rate-limit delays are reported instead of silently holding the delivery queue.
- Add consecutive-turn and stalled-response regressions for reply delivery.
- Stream DSH assistant events into native Telegram rich drafts, with thinking, tool preparation, tool execution, elapsed time, and a collapsed recent tool history in rich answers.
- Coalesce preview updates, renew long-running drafts, and fall back to plain drafts or one edited progress message when the server rejects newer methods.
- Connect native Stop controls to the current Agent; reject stale draft controls and stop preview updates during user questions, cancellation, session changes, and shutdown.
- Preserve structured Telegram rate-limit errors, respect retry delays, and avoid automatically resending messages after ambiguous transport failures.
- Draft thinking remains a compact status. Final replies now retain committed reasoning and tool text in the collapsed process record; live terminal streaming is not included.

## 0.2.2

- Target DeepSeek Harness 0.1.5-rc.2 and update the locked development dependencies.
- Read registered sessions through rc2 point observations, release observation leases, and isolate unreadable sessions without changing catalog numbering.
- Replace the retired persistence locator in `/clear`; acquire write ownership and delete all JSONL generations, including compressed logs, while retaining the lock inode.
- Restore staged logs if workspace detachment fails; handle empty sessions that never reached disk.
- Refresh the included build. Change only the DSH version statement in both READMEs.
- Validation: 139 tests, TypeScript checks, build, and copied-plugin import pass on Node.js 24.21.0 / macOS, including real rc2 JSONL backend tests. WSL2 profile startup and live Telegram/LLM requests were not exercised.

## 0.2.1

- Render Markdown headings as bold and standard/escaped inline links as clickable HTML links.
- Recognize backslash-escaped backtick fences and non-breaking-space indentation; decode Markdown escapes inside these compatibility blocks while preserving ordinary code verbatim.
- Support indented backtick, tilde, straight-apostrophe and curly-apostrophe code fences, including CRLF input.
- Render Markdown tables (including escaped leading pipes) as CJK-aligned preformatted tables with wrapped cells; remove inline Markdown markers inside cells.
- Parse before splitting messages; preserve complete HTML tags and link targets in every chunk, with visible-text plain fallbacks.
- Add formatting regressions and refresh the included JavaScript and declarations.
- Validation: 131 automated tests pass in both working and release directories; TypeScript compilation and release import probe pass. Live Telegram delivery was not exercised.

## 0.2.0

- Target DeepSeek Harness 0.1.2-rc.1; raise DSH peer requirements and lock development dependencies to this release.
- Update Cordis to 4.0.2, Schemastery to 3.18.2, and the Cordis loader to 1.0.3.
- Use the official Session Controller types and normalize its reasoning effort IDs for Agent model selection.
- Build against local locked dependencies by default; validate an explicit DSH_ROOT before replacing peer links.
- Repair the dedicated Telegram profile by installing Agent Presets and the subagent model settings required by the standard preset.
- Preserve user configuration during repeat installs and upgrades; reject the reserved node_modules profile name.
- Refresh compiled JavaScript, declarations, installation tests, and bilingual upgrade instructions.

Upgrade DSH first, stop the old profile process, then rerun setup-wsl.sh from this release and restart with run-wsl.sh.

Validation on Node.js 24.19.0 / macOS: 115 automated tests per variant, TypeScript checks, built-plugin import probes, and real rc.1 dedicated/Web profile startup, workspace selection, session creation, and deletion with a mocked Telegram transport. Live Telegram and DeepSeek API requests were not exercised.
