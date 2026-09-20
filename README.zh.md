# DSH Telegram

[English](README.md)

DeepSeek Harness 的 Telegram 机器人插件，主要用于 Linux / WSL2。在 Telegram 私聊中与 Agent 对话、发送图片和文件，并与 Web UI 共享工作区和会话。

基于 **DeepSeek Harness v0.1.5-rc.2** 开发。

## 安装

需要 Bash、Node.js 22.19+（22.x）或 24+（含 npm/npx）；在线安装还需要 curl 和 tar。无需全局安装 DSH 或下载其源码。

在线安装：

```bash
curl -fsSL https://raw.githubusercontent.com/IgnatAy/dsh-telegram/main/install.sh | bash -s -- install
```

也可以在本仓库目录运行：

```bash
bash install.sh
```

## 配置与使用

通过 Telegram 的 @BotFather 创建机器人，然后在启动 DSH 的终端设置：

```bash
export DSH_TELEGRAM_TOKEN='<BotFather 提供的 token>'
export DSH_TELEGRAM_ALLOWED_USER_IDS='<你的 Telegram 数字用户 ID>'
npx @deepseek-ai/dsh web
```

允许多个用户时，用逗号分隔数字 ID。仅支持私聊，只有允许的用户可以访问。请勿将 token 提交到 Git。

在 Web UI 配置模型凭据并创建工作区后，私聊机器人：

- `/menu`：选择工作区、管理会话和切换模型。
- `/help`：查看可用命令。
- 直接发送文字、图片或文件开始对话。

每次启动都需要提供上述环境变量。同一个 token 不要同时运行多个机器人进程。

默认使用 `web` 运行配置和 `~/.dsh` 数据目录。如自定义 `DSH_TELEGRAM_PROFILE` 或 `DSH_HOME`，安装、卸载和启动时应使用相同配置；其他运行配置使用 `npx @deepseek-ai/dsh --profile 配置名` 启动。

## 更新

停止 DSH，重新执行在线安装命令；使用本地仓库时，先获取最新代码，再运行 `bash install.sh`。完成后重新启动 DSH。

## 卸载

停止 DSH 后运行：

```bash
curl -fsSL https://raw.githubusercontent.com/IgnatAy/dsh-telegram/main/install.sh | bash -s -- uninstall
```

也可以在本仓库目录运行：

```bash
bash install.sh uninstall
```

卸载保留 DSH、模型配置、工作区和历史记录。手动添加的 Telegram 配置需自行移除。
