# grill-storm 🔥

让 subagent（griller）以 **grill-me 技能一问一答**地拷问主 agent 的计划/设计：拷问者逐轮基于上一轮回答的未闭合点追问，主 agent 逐题**选择**（接受 / 修订后接受 / 拒绝）并**作答**，拷问者判断无新漏洞可打后输出终局审判（每题闭合判定 + 总结），最终交付「问题清单 + 选择 + 回答 + 闭合判定」的报告，可作为后续会话上下文复用。

一个 pi package，在线安装后自动提供：

- **扩展**（`extensions/`）：一问一答会话编排（逐轮 spawn 提问 → 注入单问 → 收集作答 → 终局审判 → 报告）
- **技能**（`skills/grill-me`）：relentlessly 拷问指南（引用闸门 + 追问性两条硬规则，候选方向为校准提示）
- **子代理**（`agents/griller.md`）：拷问者，由 pi-subagents 自动发现（v0.3.1 起仅一个子代理，已移除 reviewer）

## ⚠ 安全提示

- 经 git 源安装 = 克隆可变 HEAD，无 checksum/签名：**作者 force-push 即可改变你本机执行的代码**。安装即代表你信任该仓库。**锁定用 commit SHA，不要用 tag**（tag 可被移动）：`pi install git:github.com/a8851625/pi-grill-storm@<40位commit SHA>`。仓库 tag 冻结策略：v0.x.y 发布后不 force-move，修订须升新 tag。
- 拷问材料文本按「被评审的引用」处理，注入消息带标识与"非指令"标注；勿把材料中的指令当指令执行。
- npm 通道：**未发布（pending）**——需仓库所有者登录 npm 账号后 `npm publish`；发布前以 git + SHA 为受支持安装通道。

## 在线安装

```bash
# 锁定 commit SHA（推荐，tag 可移动不可当锁）
pi install git:github.com/a8851625/pi-grill-storm@<commit-SHA>

# 锁定发布 tag（人类可读别名，移动即失效）
pi install git:github.com/a8851625/pi-grill-storm@v0.3.1

# 不锁版本（跟随 main）
pi install git:github.com/a8851625/pi-grill-storm
pi install https://github.com/a8851625/pi-grill-storm
```

安装写入 `~/.pi/agent/settings.json` 的 `packages`，克隆到 `~/.pi/agent/git/github.com/a8851625/pi-grill-storm`，重启（或 `/reload`）后生效。移除：

```bash
pi remove git:github.com/a8851625/pi-grill-storm
```

> 依赖：设置中已启用 pi-subagents 包（`packages` 含 `npm:pi-subagents`）。升级：`pi install git:github.com/a8851625/pi-grill-storm@<新SHA>`（改 ref 即可移动）。

## 使用

```
/grilling [主题或文件...]   # 启动一次一问一答拷问（/grill 为别名）
/grill-load [文件]          # 把上次报告注入会话作为后续上下文（gate=blocked 时提示先闭合 critical）
/grill-cleanup [-n] [--artifacts]  # 清理 v0.1 遗留拷贝；--artifacts 清 .pi/grill 过期产物（mtime>7 天）
/grill-log [usage]          # 当前状态；/grill-log usage 查看历史用量（usage.jsonl）
```

### 强度档位

```
/grilling -i high PLAN.md        # 或 --intensity=max；缺省 medium
```

| 档位 | 基准轮数（材料深度浮动 ×0.6/×1.0/×1.3） | 独特规则 |
|---|---|---|
| `low` 轻 | 6（4~8） | 引用闸门为建议；允许快速 done；审判仅 critical 从严 |
| `medium` 标准 | 12（7~16） | 引用闸门 + 追问性（默认） |
| `high` 猛烈 | 18（11~23） | + 承诺跟踪（未兑现必核查） |
| `max` 凶残 | 30（18~30） | + 双打（追击 + 攻击已闭合回答的反例）；审判要求机制可复推演；**30 封顶不向上浮动** |

- 轮数是**上限**不是目标：拷问者无新漏洞可打（done）即提前进入终局审判。
- 材料深度浮动：<5KB 浅 ×0.6 ｜ 5-20KB 中 ×1.0 ｜ >20KB 深 ×1.3。
- `GRILL_MAX_ROUNDS` 环境变量可强制覆盖（测试用）。
- 注意轮次成本：medium 全跑完约 40-60 分钟，max 可达 2 小时+；材料越浅越可能提前 done。

### 触发纪律

以下三类场景**必须** `/grilling`：

1. 产出 PRD / 方案 / 设计文档后（第 1 版 draft 完成即拷问）；
2. 需求进入实现前（gate 阶段）——报告 `gate=blocked`（critical 未闭合）时不得直接进实现；
3. 重大方向/取舍决策前。

用量自动记录到 `.pi/grill/usage.jsonl`，`/grill-log usage` 可查。

## 工作流（v0.3.1 一问一答）

```
/grilling  [用户触发]
  ├─ ① 收集拷问材料（指定文件或最近会话 → .pi/grill/context-*.md），生成会话级 runId（UUIDv4）
  ├─ ② 轮询循环（≤8 轮）：
  │     spawn griller（材料 + 完整问答历史）→ 提出**唯一一问**（引用闸门 + 追问性）
  │     → 注入 [grill-me 拷问回合] → 主 agent 调用 grill_answer 作答
  │     → agent_settled 缺口补催（≤2 次）→ 下一轮
  │     拷问者判定无新漏洞可打（done=true）→ 进入终局审判
  ├─ ③ 终局审判：griller 对每题输出 closed（是否闭合）+ judgment + 整体 summary
  └─ ④ 交付 report-<runId>.md/.json + latest.json（原子写，owner{runId,sessionId}）
       + usage.jsonl（sessionId 行级归属）｜报告含 gate（critical 未闭合=⛔ blocked）、闭合判定、轮次与 token 指标
```

## 拷问的硬规则（grill-me 技能）

- **引用闸门**：每一问的 why 必须引用材料原文或上一答原句（引号，≥15 字）——引不出来就是模板套话，删掉。
- **追问性**：第 n 问必须利用第 n-1 答的未闭合点；已闭合的点认账并转移；无新漏洞可打时终止（done）。
- **终局判定**：closed=true=正面作答且可复核（机制/数字/时限/证据）；false=敷衍（弱信号词："未验证/未知/待定/不清楚/需要调研/后续/到时候"）或明显未闭合；judgment 引用回答原文。
- 8 个候选方向（含糊/假设/风险/替代方案/目标指标/成本收益/执行/反向）只是校准提示，**不为覆盖而问**——唯一标准是能否拆掉当前表述。

## 主 agent 的选择语义

- `accepted` —— 接受拷问，正面作答
- `revised`  —— 先修正/限定方案再作答（answer 中说明修正）
- `rejected` —— 拒绝该问题（answer 中说明理由）
- 未调用工具的问题 → 报告记为 `skipped`（单轮最多补催两次）

## 产物位置

`<cwd>/.pi/grill/`：

- `context-<ts>.md` — 拷问材料
- `questions-<runId>-r<N>.json` — 每轮提问原始输出（按 runId+轮次隔离）
- `report-<runId>.md` / `report-<runId>.json` — 交付物（按 runId 隔离）
- `latest.json` — 最新一轮完整结构化交付物（原子写，owner{runId,sessionId}，并发最后完成者胜）
- `usage.jsonl` — 用量历史（每行含 sessionId/rounds/gate）
- `cleanup.log` — /grill-cleanup 操作日志

## 决策记录

- **2026-08-16（v0.3.1）**：v0.3 拷问+主 agent 讨论后重构——① 一问一答替代"一次 N 题"（batch 是发卷子不是审讯，无对话则无击穿）；② 移除 reviewer（评分职能归拷问者终局审判，子代理减半）；③ 维度软化（8 攻击面从强制清单降为校准提示，防模板化填格子）；④ 拷问承诺项落地：latest.json owner+原子写、runId=会话级 UUIDv4 稳定标识、崩溃恢复闭环（decideResume：nudge/continue/judge/repair）、/grill-cleanup --artifacts（mtime>7 天+活跃 runId 白名单+受保护文件）、critical 未闭合→gate=blocked+显式 notify、异步回调路径集成回归测试、git 锁用 commit SHA（tag 冻结）。
- **2026-08-16（v0.3）**：落实拷问报告：gate、reviewer rubric、二轮追问、特异性校验、成本/用量记录、报告隔离、显式清理。**待验证假设**（未证）："缺乏对抗性提问是需求质量差的主因"。对照实验设计：同一需求交替 grilling vs checklist，5 个样本比较返工率/缺陷数。

## 自定义

包内文件是只读资源，`pi update --extensions` 会重置 git 克隆。想定制请 fork 后安装自己的 fork；或复制技能到用户目录覆盖（同名技能用户目录优先级更高）：`~/.pi/agent/skills/grill-me/SKILL.md`。

## 开发

仓库结构即 pi package 布局：

```
extensions/index.ts        # 插件本体（v0.3.1 一问一答）
skills/grill-me/SKILL.md   # 拷问指南（引用闸门+追问性+终局 rubric）
agents/griller.md          # 拷问者子代理（唯一）
```

`package.json` 的 `pi` manifest 声明三类资源；`pi.subagents.agents` 由 pi-subagents 读取。

本地验证：

```bash
pi install /absolute/path/to/pi-grill-storm   # 本地路径安装
```

测试：

- `/tmp/grill-unit-test.mjs` —— 32 项纯函数单测（一轮一问解析/终局审判解析/引用闸门/gate(M7)/清理判定(M4)/恢复判定(M3)/并发原子写(M5)/报告结构）
- `/tmp/grill-integration-test.mjs` —— 8 项集成回归（M6：完整流程在 mock API 中驱动，async-complete 事件**无 ctx.cwd** 复刻真实回调，断言轮次推进/报告/owner/sessionId）
- `/tmp/grill-load-test.mjs` —— 扩展注册 mock 测试
- `/tmp/grill-e2e-test.mjs` —— 真实模型全链路（一问一答多轮）