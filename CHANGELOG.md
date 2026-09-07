# Changelog

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
