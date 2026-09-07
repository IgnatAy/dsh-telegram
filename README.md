# DSH Telegram

[简体中文](README.zh.md)

A Telegram bot plugin for DeepSeek Harness. Chat with agents, switch workspaces and sessions, send images, and answer agent questions from Telegram. Uses long polling and shares sessions with the Web UI.

Developed against **DeepSeek Harness v0.1.2-alpha.1**.

## Setup

Requires Linux / WSL2 with Bash, Node.js 22.19+ (22.x) or 24+, and `dsh` on PATH. Configure your model credentials and the DSH `web` profile first, and create a workspace in the Web UI.

Run from this repository:

```bash
bash setup-wsl.sh
export DSH_TELEGRAM_TOKEN='<your BotFather token>'
export DSH_TELEGRAM_ALLOWED_USER_IDS='<your numeric Telegram user ID>'
bash run-wsl.sh
```

Stop the existing `web` profile process before starting. The installer copies the included `lib/` build into the `web` profile; no dependency installation is needed. In a private chat with your bot, send `/use`, then `/use 1 1` to select a listed session or `/use 1 0` to create one. Send `/help` for all commands.

| Environment variable | Purpose |
| --- | --- |
| `DSH_TELEGRAM_TOKEN` | Bot token from BotFather (required). |
| `DSH_TELEGRAM_ALLOWED_USER_IDS` | Allowed numeric user IDs, separated by commas (required). |
| `DSH_HOME` | DSH data directory; defaults to `~/.dsh`. |

Only private chats are supported. Users outside the allowlist are denied. Keep tokens out of Git.

After source changes, run `pnpm install --frozen-lockfile` and `bash setup-wsl.sh --rebuild`, then restart. To uninstall:

```bash
bash scripts/install-copy.sh uninstall web
```
