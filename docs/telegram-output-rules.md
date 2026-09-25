# Telegram 通道自动注入的输出约束

插件通过 `telegram:channel` 系统上下文自动注入以下规则，无需修改 AGENTS.md。仅约束 Telegram 回复，不限制生成的文件内容。

实现：`src/bridge.ts` 的 `TELEGRAM_CHANNEL_PROMPT`。回复和草稿均直接发送 `rich_message.markdown`，不再经过自写 Markdown→HTML 转换器；官方 Rich Markdown 和内嵌 Rich HTML 的解析由 Telegram 完成。不支持富消息、格式错误或超限时记录错误，不回退普通消息。菜单、固定状态通知和提问也统一使用 `sendRichMessage`，按钮与强制回复框通过 `reply_markup` 发送，不再降级为普通消息。

核对依据：[Telegram 官方富消息格式说明](https://core.telegram.org/bots/api#rich-message-formatting-options)（2026-09-17）。以下是注入规则的同步副本：

- 回复直接作为 Telegram Rich Markdown 发送，由 Telegram 原生解析；不要预先按 Telegram MarkdownV2 转义整段回复。支持官方 Rich HTML 扩展，不支持任意网页、CSS 或 JavaScript。
- 使用 # 到 ###### 标题、段落、--- 分隔线、嵌套有序/无序列表。长回复用少量清晰小标题，段落间一个空行，不用空格或框线字符手工排版。
- 行内支持 **粗体**、*斜体*、~~删除线~~、==高亮==、||剧透||、`代码`；下划线用 <u> 或 <ins>，上下标用 <sup> 与 <sub>。需要展示语法本身时放进代码块并指定语言。
- 任务清单使用 - [ ] 待办事项 和 - [x] 已完成事项。它表达清单状态，不等于创建 Telegram 可协作编辑的独立 Checklist，也不自动执行任务。
- LaTeX 公式使用 $...$（行内）、$$...$$（独立公式）或 math 围栏代码块；保留公式中的反斜杠，不做二次转义。也可使用 <tg-math> 和 <tg-math-block>。金额中的美元符号在有歧义时用反斜杠转义。
- 表格使用标准 Markdown 表格及 :---、:---:、---: 对齐标记。手机上优先 2–3 列短字段，长解释放在表外；单元格只含行内格式。需要合并单元格或样式时可用 <table bordered striped compact>、<caption>、<tr>、<th>、<td> 及 colspan、rowspan、align、valign。
- 引用使用行首 >；可用 <blockquote expandable> 创建可展开引用，用 <aside> 搭配 <cite> 创建引述。不要依赖未在官方文档定义的 [!NOTE] 等提示块；提示标题直接加粗。
- 脚注使用 [^note] 与单独的 [^note]: 说明；也可用 <tg-reference name="note">。锚点用 <a name="section"></a>，文内跳转用 [跳转](#section)。
- 链接支持 https://、mailto:、tel: 和 tg://user?id=。完整网址、邮箱、用户名、话题、命令等交给 Telegram 自动识别；不要编造用户 ID。
- 折叠内容使用 <details><summary>简短摘要</summary> 加正文并闭合 </details>；加 open 可默认展开。details、tg-collage、tg-slideshow 内可继续写 Markdown，其他 HTML 块内部只能使用 HTML 排版。脚注、长推导和补充资料可放在折叠块中。
- 官方 HTML 还支持 <p>、<br>、<h1> 至 <h6>、<pre><code class="language-python">、<footer>、<hr/>、<ul>、<ol>、<li> 与 <input type="checkbox" checked>。标签必须正确闭合，HTML 属性和普通文字里的 &、<、> 按 HTML 规则转义。
- 图片、视频、音频、语音、动画和文件可用独立一段的 ![说明](https://可访问的真实媒体地址 "标题")，Telegram 按地址及 MIME 类型识别媒体；只提供文字链接时用 [说明](地址)。不要把本地路径当成公开 URL；不要编造媒体地址。
- 显式媒体标签支持 <img>、<video>、<audio>、<tg-document>，用 <figure><figcaption> 和 <cite> 加标题和来源，tg-spoiler 可隐藏媒体。拼图用 <tg-collage>，轮播用 <tg-slideshow>。媒体必须是独立块。
- 复用已上传媒体的 tg://photo?id=、tg://video?id=、tg://audio?id=、tg://document?id= 需要真实媒体映射；当前文本通道没有 multipart 上传及 media 映射工具，不要杜撰这些 ID。草稿不能新上传文件或显式通过 URL 上传文件；媒体可能要等最终消息才显示。
- 地图使用 <tg-map lat="纬度" long="经度" zoom="缩放级别"/>，只填有依据的坐标。自定义表情用 <tg-emoji emoji-id="真实ID">替代文字</tg-emoji>，日期时间用 <tg-time unix="真实Unix秒数" format="wDT">替代文字</tg-time>，也支持官方 tg://emoji 与 tg://time 语法。
- 原生按钮用 <tg-button>，按钮行用 <tg-button-row align="left|center|right">。可使用 type="url" 搭配 url、type="copy_text" 搭配 text，或 type="disabled"；样式为 primary、success、danger、link。不要用按钮代替普通正文链接。
- callback_data、web_app、login_url、switch_inline_query、switch_inline_query_current_chat、switch_inline_query_chosen_chat 按钮语法会原样传给 Telegram，但需要真实应用、域名或后端处理。当前插件只处理自己的菜单和提问按钮；不要生成自定义业务回调或承诺点击能执行工具。需要用户回答时使用已有 ask_user_question 工具。
- <tg-thinking> 仅用于生成中的草稿，由插件负责插入状态；不要在最终答案中输出这个标签。插件会将 dsh 已提供的思考摘要、工具调用摘要和中间输出放入外层折叠记录，不包含完整思考、工具输入和结果详情；无需在正文重复过程记录。
- 富消息上限为 32768 个 UTF-8 字符、500 个块（含嵌套列表项及表格行）、16 层嵌套、50 个媒体、20 列表格。每条回复正文尽量少于 30000 字符，为插件运行记录留空间；超长内容应组织为精简回复和用户要求的文件。插件不截断最终答案、不转普通文本、不拆坏公式或脚注；超限或不支持的服务会明确记入发送失败日志。

最终结果的折叠记录来自本轮已确认的 `assistant/message`、`tool/call` 和 `tool/result` 事件。外层标题按 dsh 统计调用和中间消息，展开后直接显示中间正文、思考摘要和工具摘要，不再生成内层折叠，也不发送完整思考、工具输入、结果及差异详情。思考摘要采用首行去掉 `**`；工具摘要采用 dsh 工具类型和参数规则，结果合并回同一调用。中间正文保留 Rich Markdown；完整过程仍可在 DSH 历史中查看，不自动上传附件。插件仅转义摘要并隔离正文中未配对的 details 标签及未闭合围栏，不把整段正文转换成纯文本。草稿仍显示简短状态与最近工具摘要。记录同样计入 Telegram 富消息长度限制，超限记入发送失败日志，不静默截断。详见 [dsh 折叠规则](dsh-process.md)。

## 结果重发

完整输出先写入每个聊天唯一的磁盘缓存，再发送；成功或失败均保留，便于客户端显示异常时重发。新完整输出覆盖旧缓存，开始新任务不清除旧缓存。`/resend` 可反复重发最后一份完整结果，加入命令列表但不加入 `/menu`。流式预览不缓存，DSH 历史日志不受影响。

草稿按最新快照更换 draft_id，避免开头状态变化触发重复打字动画。工具摘要直接显示，不提供草稿折叠框；模型正文含 details/summary 标签或超过 16000 个 UTF-16 代码单元时，草稿改为等待提示，完整内容由本段确认后的消息发送，不截断富文本结构。没有正文的工具记录只显示摘要，不生成空展开框。
