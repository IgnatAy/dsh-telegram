# DSH Telegram

[English](README.md)

DeepSeek Harness 的 Telegram Bot 插件。支持与 Agent 对话、切换工作区和会话、发送图片及回答 Agent 提问。通过长轮询运行，与 Web UI 共享会话。

当前插件按照 **DeepSeek Harness v0.1.5-rc.2** 版本开发。

## 安装与启动

需要 Linux / WSL2、Bash、Node.js 22.19+（22.x）或 24+（含 npm/npx）。**不需要全局安装 dsh，也不需要把 dsh 加入 PATH 或提供源码路径。** 在线安装另需 curl 和 tar。

在本仓库目录，一行安装或更新：

```bash
bash install.sh
```

不下载仓库的在线安装（本次修改推送到 GitHub main 后可用）：

```bash
curl -fsSL https://raw.githubusercontent.com/IgnatAy/dsh-telegram/main/install.sh | bash -s -- install
```

安装使用仓库附带的构建文件，写入 `~/.dsh/profiles/web/node_modules/dsh-telegram`，并在该 profile（运行配置）的 `cordis.patch.yml` 注册插件。不存在的 web profile 会自动创建；已有模型配置、工作区和会话会保留。安装不启动 dsh，不需要 pnpm。

在启动 dsh 的终端设置 Bot 配置：

```bash
export DSH_TELEGRAM_TOKEN='<BotFather 提供的 Bot token>'
export DSH_TELEGRAM_ALLOWED_USER_IDS='<你的 Telegram 数字用户 ID>'
```

之后照常启动，Telegram Bot 与 Web UI 在同一个进程内运行，无需额外启动脚本或 `--patch`：

```bash
npx @deepseek-ai/dsh web
```

每次启动的环境都需要包含以上变量；新开终端时请重新设置，或通过你现有的环境配置方式提供。请先配置 DSH 的模型凭据，并在 Web UI 创建工作区。更新或卸载前停止现有进程，完成后重新启动；不要同时运行两个使用相同 Bot token 的进程。

私聊 Bot，发送 `/use` 查看列表，再用 `/use 1 1` 选择会话，或 `/use 1 0` 创建会话。发送 `/help` 查看全部命令。

## 卸载

在本仓库目录一行卸载：

```bash
bash install.sh uninstall
```

也可以在线卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/IgnatAy/dsh-telegram/main/install.sh | bash -s -- uninstall
```

仅删除插件文件和安装器管理的配置块，保留 DSH、模型配置、工作区和历史记录。手动添加的 Telegram 配置需自行移除。

## 其他配置与开发

| 环境变量 | 用途 |
| --- | --- |
| `DSH_TELEGRAM_TOKEN` | BotFather 提供的 token，必填。 |
| `DSH_TELEGRAM_ALLOWED_USER_IDS` | 允许访问的数字用户 ID，多个用逗号分隔，必填。 |
| `DSH_HOME` | DSH 数据目录，默认 `~/.dsh`；安装、卸载和启动时必须一致。 |
| `DSH_TELEGRAM_PROFILE` | 安装目标，默认 `web`；启动其他配置时使用 `npx @deepseek-ai/dsh --profile 配置名`。 |

仅支持私聊，白名单外的用户无法访问。请勿将 token 提交到 Git。也可显式指定目标：`bash install.sh install web` / `bash install.sh uninstall web`。

修改源码后依次执行 `pnpm install --frozen-lockfile`、`pnpm build`、`bash install.sh`，然后重启 dsh。

预览使用 Telegram 原生富文本草稿接口，需要支持该接口的 Bot API 服务。点击原生停止按钮与发送 `/stop` 相同：取消当前任务和等待中的提问，并停止预览。按钮不按草稿编号筛选，较早草稿的停止事件也会作用于当前任务。

已移除旧版安装脚本、旧安装标记自动迁移、旧会话自动归入工作区，以及普通草稿/编辑消息预览兼容层。现有工作区中已登记的会话照常使用，历史文件不会被迁移或删除。旧版手动安装配置需自行整理；当前安装器管理的配置仍支持重复安装和卸载。

回复和生成中的预览使用原生富消息标题、表格、列表、引用与分隔线；段落间距由 Telegram 排版。普通消息回退时，表格转换为逐行“字段：值”，避免手机上的字符网格错位。超过现有 24,000 字符阈值的回复继续走普通消息分段。插件自动注入手机排版提示词，建议表格使用 2–3 列短内容。
