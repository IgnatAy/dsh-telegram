# DSH Telegram

[简体中文](README.zh.md)

A Telegram bot plugin for DeepSeek Harness. Chat with agents, switch workspaces and sessions, send images, and answer agent questions from Telegram. Uses long polling and shares sessions with the Web UI.

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

Send `/use` in a private chat, then `/use 1 1` to select a session or `/use 1 0` to create one. Send `/help` for all commands.

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

Previews use native Telegram rich drafts and require a Bot API service supporting that interface. Native Stop and `/stop` share the same cancellation path, including pending questions. Stop targets the current task regardless of draft ID, including events from earlier drafts.

Legacy setup/run scripts, installer-marker migration, automatic workspace adoption of historical sessions, and plain-draft/edit-message preview adapters have been removed. Registered workspace sessions remain available; historical files are neither migrated nor deleted. Legacy manually installed configuration must be maintained manually; current managed blocks still support repeated installation and removal.

Assistant replies and previews pass native `rich_message.markdown` directly to Telegram, including task lists, LaTeX, tables, footnotes, collapsible blocks, highlights, spoilers, and official Rich HTML extensions. See [output rules](docs/telegram-output-rules.md) for syntax and media/button requirements. Rejected or oversized rich replies are logged without downgrade or truncation; the former 24,000-character fallback is removed. Commands and questions retain their separate ordinary-message UI.

Final replies include a collapsed process record containing committed DSH reasoning, intermediate messages, tool arguments, and textual tool results. The latest answer stays outside the disclosure. The record counts toward rich-message limits; non-text tool results are represented by type labels.
