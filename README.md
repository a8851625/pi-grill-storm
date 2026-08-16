# grill-storm 🔥

让 subagent 以 **grill-me 技能**拷问主 agent 的计划/设计，主 agent 自动逐题**选择**（接受 / 修订后接受 / 拒绝）并**作答**，最终交付「全部问题清单 + 每题选择 + 回答」的报告，可作为后续会话上下文复用。

一个 pi package，在线安装后自动提供：

- **扩展**（`extensions/`）：拷问会话编排（spawn 子代理 → 注入问题 → 收集作答 → 生成报告）
- **技能**（`skills/grill-me`）：增强版 grill-me 拷问规范（8 个攻击面）
- **子代理**（`agents/griller.md`）：拷问者，由 pi-subagents 自动发现

## 在线安装

```bash
# 方式一：git 源（推荐，无需 npm 发布）
pi install git:github.com/a8851625/pi-grill-storm

# 方式二：完整 URL 也可以
pi install https://github.com/a8851625/pi-grill-storm

# 方式三：锁定版本 ref（tag 或 commit）
pi install git:github.com/a8851625/pi-grill-storm@v0.2.0

# 指定版本后更新到新 ref
pi install git:github.com/a8851625/pi-grill-storm@v0.3.0
```

安装写入 `~/.pi/agent/settings.json` 的 `packages`，克隆到 `~/.pi/agent/git/github.com/a8851625/pi-grill-storm`，重启（或 `/reload`）后生效。移除：

```bash
pi remove git:github.com/a8851625/pi-grill-storm
```

> 依赖：设置中已启用 pi-subagents 包（`packages` 含 `npm:pi-subagents`）。

## 使用

```
/grilling [主题或文件...]   # 启动一次拷问（/grill 为别名）
/grill-load [文件]          # 把上次报告注入会话作为后续上下文
/grill-log                  # 查看当前拷问状态
```

## 工作流

```
/grilling  [用户触发]
  ├─ ① 收集拷问材料（指定文件或最近会话 → .pi/grill/context-*.md）
  ├─ ② RPC 异步 spawn「griller」子代理（pi-subagents，outputSchema 强制结构化问题清单）
  ├─ ③ 监听 subagent:async-complete（或轮询产物兜底）取回问题
  ├─ ④ 动态启用 grill_answer 工具，注入 [grill-me 拷问回合] 消息
  │     → 主 agent 自动逐题调用 grill_answer 记录 选择+回答
  ├─ ⑤ agent_settled 检查缺口（最多补催 2 次）
  └─ ⑥ 交付 .pi/grill/report.md + latest.json（问题+意图+选择+回答+总览）
```

## 主 agent 的选择语义

- `accepted` —— 接受拷问，正面作答
- `revised`  —— 先修正/限定方案再作答（answer 中说明修正）
- `rejected` —— 拒绝该问题（answer 中说明理由）
- 未调用工具的问题 → 报告记为 `skipped`（最多补催两次）

## 产物位置

`<cwd>/.pi/grill/`：

- `context-<ts>.md` — 拷问材料
- `questions-<runId>.json` — 子代理原始输出
- `report.md` — 交付报告（后续上下文主要载体）
- `latest.json` — 结构化交付物（meta + questions + decisions + answers）

## 自定义

包内文件是只读资源，`pi update --extensions` 会重置 git 克隆。想定制技能或拷问者行为，请 fork 本仓库后安装自己的 fork：

```bash
pi install git:github.com/<you>/pi-grill-storm
```

或复制技能到用户目录覆盖（同名技能用户目录优先级更高）：`~/.pi/agent/skills/grill-me/SKILL.md`。

## 开发

仓库结构即 pi package 布局：

```
extensions/index.ts        # 插件本体
skills/grill-me/SKILL.md   # 拷问技能
agents/griller.md          # 拷问者子代理（pi-subagents 发现）
```

`package.json` 的 `pi` manifest 声明三类资源；`pi.subagents.agents` 由 pi-subagents 读取。

本地验证（未安装时直接指向仓库）：

```bash
pi install /absolute/path/to/pi-grill-storm   # 本地路径安装
```

测试：`/tmp/grill-unit-test.mjs`（纯函数单测）、`/tmp/grill-load-test.mjs`（扩展注册 mock 测试）、`/tmp/grill-e2e-test.mjs`（真实模型全链路，已验证 14/14 题作答）。