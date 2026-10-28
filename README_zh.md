# pi-btw

<div align="center">

<img src="https://cdn.jsdelivr.net/gh/L2ncE/pi-btw@main/assets/logo.png" alt="pi-btw" width="280"/>

</div>

Claude Code 风格的 `/btw` side question 扩展，为 [pi](https://pi.dev) 打造。[English](README.md)

主 agent 正在跑的时候，随手问一个小问题：

```
/btw 刚才那个配置文件叫什么来着？
/btw 这个报错是什么意思？
```

- 答案出现在**顶部悬浮 overlay**，主界面继续跑，互不打断
- 不进主会话历史，不占主上下文窗口
- side question 共享主会话的真实消息上下文，后续 side question 也能看到之前的 side Q&A（保留最近 20 组）
- 只读工具集（`read` / `grep` / `find` / `ls`），能自己去看代码，但改不了任何东西
- overlay 内直接追问，同一个 side thread 连续对话
- side agent 的 token 用量与费用计入主会话统计，但问答内容仍不会进入主上下文

![pi-btw 实际效果](https://cdn.jsdelivr.net/gh/L2ncE/pi-btw@main/assets/screenshot.png)

## overlay 按键

| 键 | 作用 |
|---|---|
| `Enter` | 提交输入框里的追问 |
| `Esc` | 回答进行中 → 中止；空闲 → 关闭 overlay |
| `c` | 复制当前答案（原始 markdown）到剪贴板 |
| `←` / `→` | 翻看本次会话的历史 side Q&A |
| `↑` / `↓` | 滚动长答案 |
| `Alt+/` | 在 overlay 与主输入框之间切换焦点（overlay 保持显示；`Ctrl+Alt+W` 为备用键） |

历史 side Q&A 以暗色问题列表显示在当前答案上方，只存在内存里，`/new`、重启即清空，也永远不会进入主会话。

## 用量与费用

`/btw` 会向主会话 journal 写入仅用于计费的 `usage` 记录（`kind: "btw"`），
计入默认 footer 与 `/session` 的 token 和费用统计，保存后恢复会话也不会丢失。
每条新用量只计一次，包括工具调用期间的模型回复、compaction，以及错误或中止时
实际报告的用量；作为背景复制的主会话历史不会重复计费。

记录只包含用量与模型信息，不保存 side question、答案或工具输出。
即使 side agent 固定了其他模型，也使用其实际报告的费用。

遵循 pi 的持久化规则：内存主会话不写文件；全新会话如果只使用 `/btw`，
会等到第一条主会话消息后才创建文件，在此之前用量统计只存在内存里。

## 配置

默认情况下，side agent 使用主会话的模型和 thinking level。要固定使用别的模型，创建 `~/.pi/agent/btw.json`：

```json
{
	"model": "openai/gpt-5.2",
	"thinking": "low"
}
```

- `model` — `provider/modelId`；裸 model id 在跨 provider 无歧义时也可以
- `thinking` — 可选：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；省略时跟随主会话的 thinking level
- 每次提问前都会重新读取该文件，改完即时生效，无需重启
- 配置非法时会直接报错并放弃本次提问，绝不静默回退
- 删除文件（或清空 `model` 字段）即恢复跟随主会话

overlay 标题会显示 side agent 当前使用的模型。

## 安装

需要 **pi 1.4.0 或更新版本**，以支持原生用量统计。

```bash
pi install npm:@lanlance/pi-btw
```

或从 git：

```bash
pi install git:https://github.com/L2ncE/pi-btw
```

本地试用（不安装）：

```bash
pi -e /path/to/pi-btw
```

## 设计

- 每次 pi 会话懒创建一个 in-memory `AgentSession` 子会话（`SessionManager.inMemory()`，不落盘）；主会话 messages（`buildSessionContext` + `convertToLlm`）先写入子会话 journal 再创建，由 `createAgentSession` 的官方恢复路径装载，compaction 重建后也不会丢
- 新增的子会话用量通过主会话 manager 的原生 `appendUsage()` 写入，计入 pi 默认统计且不进入模型上下文；由于 extension context 只暴露只读接口，此处使用带兼容性检查的窄范围 SDK 访问
- 会话关闭或切换时先中止并排空子会话，再释放资源，避免将延迟返回的用量记入新会话
- 子会话工具白名单 `["read", "grep", "find", "ls"]`，无 bash / edit / write
- 模型与 thinking level 默认跟随主会话；通过 `~/.pi/agent/btw.json` 固定后不再回同步主会话模型，且子会话使用内存版 settings，模型切换不会写用户的全局 pi settings
- system prompt 由子会话重新组装：取主会话原始 `customPrompt` 与 `appendSystemPrompt`（经 `getSystemPromptOptions()`）叠加 btw 角色提示；AGENTS.md / skills 首次 `/btw` 时从磁盘加载，工具段正确列出 4 个只读工具
- system prompt 明确声明：只读的临时 side agent，主 agent 未被打断，只回答，不承诺任何修改

License: Apache-2.0
