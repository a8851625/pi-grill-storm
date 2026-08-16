# grill-storm 🔥

让 subagent 以 **grill-me 技能**拷问主 agent 的计划/设计，主 agent 自动逐题**选择**（接受 / 修订后接受 / 拒绝）并**作答**，最终交付「全部问题清单 + 每题选择 + 回答」的报告，可作为后续会话上下文复用。

## 工作流

```
/grilling                       ← 用户触发（一次性）
    │
    ├─① 收集拷问材料（指定文件或当前会话内容 → .pi/grill/context-*.md）
    ├─② 通过 pi-subagents RPC 异步 spawn「griller」子代理
    │     （自带增强版 grill-me 技能，outputSchema 强制结构化问题清单 JSON）
    ├─③ 监听 subagent:async-complete（或轮询产物兜底）取回问题
    ├─④ 动态启用 grill_answer 工具，注入 [grill-me 拷问回合] 消息
    │     → 主 agent 自动逐题调用 grill_answer 记录 选择+回答
    ├─⑤ agent_settled 检查缺口（最多补催 2 次）
    └─⑥ 生成交付物：
          .pi/grill/report.md      ← 人类可读报告（问题+意图+选择+回答+总览表）
          .pi/grill/latest.json    ← 机器可读（meta + questions + decisions + answers）

/grill-load                       ← 把上次报告重新注入会话，作为后续上下文
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `/grilling [主题或文件...]` | 启动拷问。可指定一个或多个文件路径，或主题词；无参数则取最近会话内容 |
| `/grill [主题或文件...]` | `/grilling` 的别名（grill-me 技能原文写作 "Run a /grilling session"，两者等价） |
| `/grill-load [文件]` | 将 `.pi/grill/report.md`（或指定文件）注入当前会话，作为后续上下文（不触发回答） |
| `/grill-log` | 查看当前会话的拷问状态（runId、进度、报告路径） |

## 主 agent 的选择语义

对每个问题调用 `grill_answer(questionId, decision, answer)`：

- `accepted` —— 接受拷问，正面作答
- `revised`  —— 先修正/限定方案再作答（answer 中说明修正）
- `rejected` —— 拒绝该问题（answer 中说明理由）
- 未调用工具的问题 → 报告记为 `skipped`（未作答），并最多补催两次

## 产物位置

`<cwd>/.pi/grill/`：

- `context-<ts>.md` — 拷问材料（子代理读取的上下文）
- `questions-<runId>.json` — 子代理原始输出
- `report.md` — 交付报告（后续上下文的主要载体）
- `latest.json` — 结构化交付物，可被脚本/其他工作流消费

## 安装

插件已安装在 `~/.pi/agent/extensions/grill-storm/`（全局自动发现），首次运行 `/grilling` 时自动安装两个资产：

- `~/.pi/agent/agents/griller.md` — 拷问者子代理定义
- `~/.pi/agent/skills/grill-me/SKILL.md` — 增强版 grill-me 技能（与原版同名，内容完整化）

文件带 `<!-- managed-by:grill-storm -->` 标记，插件会随版本更新自动覆盖；**如果你手动编辑过这些文件（保留原样即尊重你的自定义）**。

### 依赖

- pi-subagents 扩展（`settings.json` 的 `packages` 中已有 `npm:pi-subagents`）
- `~/.pi/agent/extensions/grill-storm/node_modules` 为软链自 pi 安装目录的依赖（`@earendil-works/*`、`typebox`），供本地解析；运行时 pi 自带这些包的别名解析，不依赖软链

## 卸载

```bash
rm -rf ~/.pi/agent/extensions/grill-storm
rm -f ~/.pi/agent/agents/griller.md
rm -rf ~/.pi/agent/skills/grill-me   # 若你同时想移除 grill-me 技能
```

## 测试

- 单元测试 `/tmp/grill-unit-test.mjs`：纯函数（问题提取、报告生成）
- 加载测试 `/tmp/grill-load-test.mjs`：mock ExtensionAPI 验证注册
- 端到端测试 `/tmp/grill-e2e-test.mjs`：真实 pi RPC 会话 + 真实模型全链路（spawn → 拷问 → 回答 → report.md）；已验证：14 题全部作答（8 接受 / 6 修订后接受），报告与 JSON 交付正常