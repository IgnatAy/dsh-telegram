# DSH Telegram

[简体中文](README.zh.md)

A Telegram bot plugin for DeepSeek Harness. Chat with agents, switch workspaces and sessions, send images, and answer agent questions from Telegram. Uses long polling and shares sessions with the Web UI.

Permission requests, including sandbox escalation, appear in the bound Telegram chat with the tool, call ID and reason, plus Allow once / Reject buttons. Only the explicit allow button grants permission; free text never grants it. `/cancel`, `/skip`, native Stop and session switching cancel the request. Delivery failures return unavailable without granting access.

Developed against **DeepSeek Harness v0.1.5-rc.2**.

## Install and start

Requires Linux / WSL2, Bash, and Node.js 22.19+ (22.x) or 24+ with npm/npx. **No global dsh installation, dsh on PATH, or DSH source directory is required.** Online installation also needs curl and tar.

Install or update from this repository in one command:

```bash
bash install.sh
```

Or install without cloning (available after these changes reach GitHub main):

```bash
curl -fsSL https://raw.githubusercontent.com/IgnatAy/dsh-telegram/main/install.sh | bash -s -- install
```

The installer copies the included build to `~/.dsh/profiles/web/node_modules/dsh-telegram` and registers it in the profile's `cordis.patch.yml`. It creates a missing web profile and preserves existing model settings, workspaces, and sessions. Installation does not start DSH or require pnpm.

Set the bot environment in the terminal that starts DSH:

```bash
export DSH_TELEGRAM_TOKEN='<your BotFather token>'
export DSH_TELEGRAM_ALLOWED_USER_IDS='<your numeric Telegram user ID>'
```

Start DSH as usual; Telegram and the Web UI run together. No wrapper or extra `--patch` is needed:

```bash
npx @deepseek-ai/dsh web
```

These variables must be present on every launch; set them again in new terminals or supply them through your existing environment configuration. Configure DSH model credentials and create a workspace in the Web UI first. Stop the running process before updating or uninstalling, then restart. Do not run two processes with the same bot token.

Send `/menu` in a private chat to open the control panel. It shows the current workspace, session, model, reasoning effort, task/question/collection state, and workspace/session totals. Buttons provide paginated catalogs, switching, session creation, and confirmed permanent deletion. Each action sends an updated panel and invalidates the previous keyboard; Refresh loads current state. Send `/help` for all commands.

Removed commands: `/use`, `/model`, `/stop`, `/reasoning`, `/status`. Retained: `/start`, `/new`, `/archive`, `/clear`, `/collect`, `/send`, `/discard`, `/followup`, `/resend`, `/help`. New/archive/clear are also available in the menu. Archiving preserves history and the selected workspace, releases the current chat selection, and marks the session as archived in the session list. Wait for a running task to finish or use native Stop before changing settings.

## Uninstall

From this repository:

```bash
bash install.sh uninstall
```

Or online:

```bash
curl -fsSL https://raw.githubusercontent.com/IgnatAy/dsh-telegram/main/install.sh | bash -s -- uninstall
```

Only plugin files and installer-managed configuration are removed. DSH, model settings, workspaces, and history remain. Remove manually added Telegram configuration yourself.

## Configuration and development

| Environment variable | Purpose |
| --- | --- |
| `DSH_TELEGRAM_TOKEN` | BotFather token (required). |
| `DSH_TELEGRAM_ALLOWED_USER_IDS` | Allowed numeric user IDs, comma-separated (required). |
| `DSH_HOME` | DSH data directory, default `~/.dsh`; use the same value when installing, uninstalling, and starting. |
| `DSH_TELEGRAM_PROFILE` | Installation target, default `web`; start other profiles with `npx @deepseek-ai/dsh --profile NAME`. |

Only private chats are supported; users outside the allowlist are denied. Keep tokens out of Git. Explicit targets are supported: `bash install.sh install web` / `bash install.sh uninstall web`.

After source changes, run `pnpm install --frozen-lockfile`, `pnpm build`, and `bash install.sh`, then restart DSH.

Previews use native Telegram rich drafts and require a Bot API service supporting that interface. Native Stop cancels the current task, including pending questions. Stop targets the current task regardless of draft ID, including events from earlier drafts.

Legacy setup/run scripts, installer-marker migration, automatic workspace adoption of historical sessions, and plain-draft/edit-message preview adapters have been removed. Registered workspace sessions remain available; historical files are neither migrated nor deleted. Legacy manually installed configuration must be maintained manually; current managed blocks still support repeated installation and removal.

Assistant replies and previews pass native `rich_message.markdown` directly to Telegram, including task lists, LaTeX, tables, footnotes, collapsible blocks, highlights, spoilers, and official Rich HTML extensions. See [output rules](docs/telegram-output-rules.md) for syntax and media/button requirements. Rejected or oversized rich replies are logged without downgrade or truncation; the former 24,000-character fallback is removed. Menus, fixed notices, and questions also use native rich messages, with keyboards and ForceReply supplied through `reply_markup`. The control panel uses section headings, a status table, lists and dividers, and displays model names without provider or route IDs. Menu buttons update rich content and the keyboard together on the original message, including navigation, refreshes and action results. Sending `/menu` explicitly opens a new panel. The legacy `maxMessageLength` option remains accepted for compatibility but no longer splits messages.

Final replies follow DSH's two-level process disclosure: the outer summary counts tool calls and intermediate messages (omitting zero counts; subagents are counted separately). Intermediate messages appear directly inside; reasoning and paired tool inputs/results have nested disclosures. Summaries follow DSH's reasoning first-line and tool argument rules. Bodies retain native Rich Markdown, and the final answer stays outside. See [process projection rules](docs/dsh-process.md).

### Unsent result cache

Each bot/chat retains only its latest complete output on disk. New output replaces the previous cache; confirmed delivery immediately deletes it. Starting a task does not clear an older pending result. Use `/resend` after an outage or restart, without selecting a session. It appears in Telegram’s command list, not `/menu`. There is no automatic transport retry, history archive, or streaming-fragment cache. An ambiguous timeout may already have delivered the message, so manual resend can duplicate it.

The default root is `$DSH_HOME/telegram-results` (or `~/.dsh/telegram-results`), configurable with `resultCacheDirectory`. Files contain reply text and are isolated by bot/chat; successful delivery leaves only empty directories. DSH session logs are unaffected.
