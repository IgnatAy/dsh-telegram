# dsh 过程折叠到 Telegram 的映射

对照版本：DeepSeek Harness `0.1.5-rc.2`。实现位于 `src/transcript.ts`，由 `TelegramProgress` 维护每轮记录；无需在 WSL 上依赖本机 dsh 源码路径。

外层显示 `x 次工具调用 · y 条消息`，数量为零的项目省略；`subagent` 和 `subagent_*` 单独显示 `z 个 subagent`，没有计数但有思考时显示 `已思考`。调用数按启动次数统计，包含失败/未完成调用；结果事件不重复计数。消息数按含可见回复的 assistant/message 统计，不按文本块或思考块计数，排除最终答案所在步骤。

展开外层后，中间消息直接呈现；思考和每次工具各有第二层 `<details>`。同一 callId 的结果合并到该工具条目，保持调用顺序，支持并行调用乱序返回。每次发送时，外层折叠记录单独作为第一条富消息，正文作为第二条富消息，按顺序发送。没有折叠记录时只发送正文，没有正文时不发送空消息。结束清理保留本次两条消息，`/resend` 也按同样顺序重发。

iOS 的 `Show more` 是长富消息的全文加载入口，与 `<details>` 展开独立：客户端可能先收到部分消息，点击后再请求完整内容。拆分消息可以避免正文被运行记录挤到同一条消息的后半部分，不能保证长正文不出现 `Show more`，也不能修复客户端或服务器的全文加载故障。参考 [Telegram iOS 实现说明](https://github.com/TelegramMessenger/Telegram-iOS/blob/master/docs/instantpage-richtext.md#show-more-for-partial-rich-messages-on-demand-full-page)。

思考标题为 `思考 · 首行摘要`，摘要移除 `**`，正文保留完整 Markdown。工具标题按原生中文名称和参数摘要生成，例如 `Bash · 运行测试`、`读取 · src/main.ts`、`Grep · pattern`、`网页搜索 · query`。工具失败用错误首行替换参数摘要。文件路径相对运行时工作区展示；todo、提问有各自的计数/状态摘要，write/edit 使用可用的差异元数据生成增删统计。

第一层和第二层正文均使用 Telegram 原生 Rich Markdown：表格、链接、公式、列表、代码块继续解析；摘要只按纯文本转义。JSON 输入保留代码格式，shell 和 run_code 显示程序代码。原始正文中缺少闭合的代码围栏和 details 会在记录边界补齐，孤立的关闭 details 标签转义，避免吞掉后续记录和最终答案。

## 核对的原生源码

以下路径相对于 dsh 源码根目录：

- `packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts`：计数和最终答案步骤边界。
- `packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx`、`src/client/locale.ts`：外层文字与分隔符。
- `packages/client/ui-chat/src/client/chat/ReasoningRow.tsx`：思考首行摘要。
- `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts`：工具类别、摘要参数优先级、路径、错误首行。
- `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx`：标题与摘要拼接、错误覆盖。
- `packages/client/ui-tool/src/client/tool/toolviews/{search-row,web-row,todo-row,ask-question-row}.tsx`：专用标题和摘要。
- `packages/client/ui-conversation/src/client/locales.ts`：工具中文文案。
- `packages/client/ui-tool/src/client/tool/models/diff-card-model.ts`、`packages/client/ui-primitives/src/DiffBlock.tsx`：差异统计。

这是 Telegram 的文本投影，不加载 React UI 或第三方插件注册的自定义卡片；自定义工具采用 dsh 的通用工具行规则。升级 dsh 时需要重新核对上述逻辑与 `tests/transcript.spec.ts`。Rich Markdown 在 Telegram 服务端解析，本地测试验证发送内容、计数、层级与格式保留，不能代替真实客户端的显示验证。
