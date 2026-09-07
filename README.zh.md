# DSH Telegram

[English](README.md)

DeepSeek Harness 的 Telegram Bot 插件。支持与 Agent 对话、切换工作区和会话、发送图片及回答 Agent 提问。通过长轮询运行，与 Web UI 共享会话。

当前插件按照 **DeepSeek Harness v0.1.2-alpha.1** 版本开发。

## 配置方法

需要 Linux / WSL2、Bash、Node.js 22.19+（22.x）或 24+，并确保 `dsh` 已在 PATH 中。请先配置模型凭据和 DSH 的 `web` profile，并在 Web UI 中创建工作区。

在本仓库目录执行：

```bash
bash setup-wsl.sh
export DSH_TELEGRAM_TOKEN='<BotFather 提供的 Bot token>'
export DSH_TELEGRAM_ALLOWED_USER_IDS='<你的 Telegram 数字用户 ID>'
bash run-wsl.sh
```

启动前请停止已有的 `web` profile 进程。安装脚本将仓库自带的 `lib/` 构建文件复制到 `web` profile，无需安装依赖。私聊 Bot，先发送 `/use` 查看列表，再用 `/use 1 1` 选择对应会话，或用 `/use 1 0` 创建新会话。发送 `/help` 查看全部命令。

| 环境变量 | 用途 |
| --- | --- |
| `DSH_TELEGRAM_TOKEN` | BotFather 提供的 Bot token，必填。 |
| `DSH_TELEGRAM_ALLOWED_USER_IDS` | 允许访问的数字用户 ID，多个用逗号分隔，必填。 |
| `DSH_HOME` | DSH 数据目录，默认 `~/.dsh`。 |

仅支持私聊，白名单外的用户无法访问。请勿将 token 提交到 Git。

修改源码后，执行 `pnpm install --frozen-lockfile` 和 `bash setup-wsl.sh --rebuild`，然后重启。卸载：

```bash
bash scripts/install-copy.sh uninstall web
```
