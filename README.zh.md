# DSH Telegram

[English](README.md)

DeepSeek Harness 的 Telegram Bot 插件。支持与 Agent 对话、切换工作区和会话、发送图片及回答 Agent 提问。通过长轮询运行，与 Web UI 共享会话。

需要越过工作区限制等权限审批时，当前会话会在 Telegram 显示工具、调用编号和申请原因，并提供“仅允许本次”和“拒绝”按钮。只有点击允许按钮才会授权；普通文字不会授予权限。`/cancel`、`/skip`、停止任务或切换会话会取消申请；发送失败会返回不可用，不会默认放行。

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

私聊 Bot，发送 `/menu` 打开控制面板。面板显示当前工作区、会话、模型、推理强度、运行状态、等待回答和收集状态，以及现有工作区与会话总数。点击按钮分页浏览全部工作区、会话与模型，切换选择、创建会话或确认永久删除当前会话。每次操作会发送更新后的面板，旧面板按钮自动失效；点击“刷新状态”获取最新状态。发送 `/help` 查看全部命令。

已移除 `/use`、`/model`、`/stop`、`/reasoning`、`/status`。保留 `/start`、`/new`、`/archive`、`/clear`、`/collect`、`/send`、`/discard`、`/followup`、`/resend`、`/help`；`/new`、`/archive` 和 `/clear` 的功能也集成在菜单内。归档会保留聊天记录和当前工作区、退出当前会话，并在会话列表中标记“已归档”。运行中请等待任务完成，或使用 Telegram 原生停止按钮后再切换设置。

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

预览使用 Telegram 原生富文本草稿接口，需要支持该接口的 Bot API 服务。点击原生停止按钮会：取消当前任务和等待中的提问，并停止预览。按钮不按草稿编号筛选，较早草稿的停止事件也会作用于当前任务。

已移除旧版安装脚本、旧安装标记自动迁移、旧会话自动归入工作区，以及普通草稿/编辑消息预览兼容层。现有工作区中已登记的会话照常使用，历史文件不会被迁移或删除。旧版手动安装配置需自行整理；当前安装器管理的配置仍支持重复安装和卸载。

回复和生成中的预览直接使用 Telegram 原生 `rich_message.markdown`，支持任务清单、LaTeX、表格、脚注、折叠块、高亮、剧透和官方 Rich HTML 扩展。完整语法及媒体、按钮条件见 [输出规则](docs/telegram-output-rules.md)。富消息失败或超限仅记录错误，不回退、不截断最终回复；已移除旧 24,000 字符降级阈值。菜单、固定通知和提问也统一使用原生富消息，交互按钮和强制回复输入框通过 `reply_markup` 附带发送。控制面板使用分区标题、状态表格、列表和分割线；模型只显示名称。点击菜单按钮时，会同时编辑原消息的内容和按钮，翻页、返回、刷新及操作结果不再新增菜单消息；重新发送 `/menu` 可打开新面板。旧 `maxMessageLength` 配置仅为兼容保留，不再拆分富消息。

最终回复采用 dsh 的两层折叠：外层标题为「x 次工具调用 · y 条消息」（零项省略，subagent 单独计数），中间消息在第一层直接显示，思考和每次工具的输入/结果在第二层折叠。思考摘要取首行，工具摘要按工具类型及参数生成；失败时显示错误首行。折叠正文保留原生 Markdown 解析，最终答案显示在外层之外。详见 [dsh 折叠规则](docs/dsh-process.md)。

### 未送达结果缓存

每个机器人、每个聊天只保留最新一份完整输出；生成新输出时覆盖旧缓存，确认发送成功后立即删除。开始新任务不会清除旧缓存。断网或重启后直接输入 `/resend` 补发，无需先选择会话；此命令加入 Telegram 命令列表，不加入 `/menu`。不自动重试网络发送，不保存历史或流式片段。发送超时可能实际上已经送达，手动补发可能重复。

默认缓存位于 `$DSH_HOME/telegram-results`（未设置时为 `~/.dsh/telegram-results`），可通过插件配置 `resultCacheDirectory` 修改。缓存按机器人及聊天隔离，文件包含回复正文；成功后只留下空目录。DSH 自身的会话日志不受影响。
