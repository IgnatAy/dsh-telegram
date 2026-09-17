/** Native syntax must reach Telegram unchanged; these tests don't emulate its renderer. */
export const richExamples = [
  ['task list', '- [ ] 校验输入\n- [x] 完成计算'],
  ['LaTeX', String.raw`行内 $\alpha + \frac{1}{2}$。

$$\int_0^1 x^2\,dx = \frac{1}{3}$$

\$100 是金额。`],
  ['math fence', '```math\n\\sum_{i=1}^{n} i\n```'],
  ['inline styles', '**重点** *斜体* ~~旧值~~ ==高亮== ||答案|| <u>下划线</u> H<sub>2</sub> x<sup>2</sup>'],
  ['tables and lists', '# 计划\n\n- 父项\n  1. 子项\n\n---\n\n| 参数 | 值 |\n|:---|---:|\n| **精度** | $10^{-3}$ |'],
  ['references', '说明[^source]\n\n[^source]: 数据来源\n\n<a name="result"></a>\n[跳转](#result)'],
  ['details and quotes', '<details><summary>推导</summary>\n\n$x^2$\n\n</details>\n\n<blockquote expandable>附注</blockquote>\n\n<aside>引述<cite>作者</cite></aside>'],
  ['media', '![图](https://example.com/chart.png "说明")\n\n<video src="https://example.com/demo.mp4"></video>\n\n<audio src="https://example.com/sound.ogg"></audio>\n\n<tg-document src="https://example.com/report.pdf"></tg-document>'],
  ['galleries', '<tg-collage>\n\n![](https://example.com/a.png)\n\n![](https://example.com/b.png)\n\n</tg-collage>\n\n<tg-slideshow><img src="https://example.com/c.png"/></tg-slideshow>'],
  ['map and date', '<tg-map lat="31.2" long="121.5" zoom="10"/>\n\n<tg-time unix="1800000000" format="wDT">日期</tg-time>'],
  ['buttons', '<tg-button-row><tg-button type="url" url="https://example.com">参考</tg-button><tg-button type="copy_text" text="abc">复制</tg-button></tg-button-row>'],
  ['HTML table', '<table bordered striped compact><caption>结果</caption><tr><th colspan="2">参数</th></tr><tr><td align="right">1</td><td>2</td></tr></table>'],
  ['literal code', '```html\n<details>源码</details>\n- [x] 不是任务项\n$not_math$\n```'],
  ['long answer', '长回复😀'.repeat(6000)],
] as const
