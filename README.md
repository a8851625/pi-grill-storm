# grill-storm

`grill-storm` 让 `griller` 子代理按 `grill-me` 技能对计划、设计或实现进行**范围受控的决策拷问**。开始时不要求手工列文件：插件先从当前 Pi 会话和工作区自动检索、筛选并固化一份可审计的证据包，再开始一问一答。

每题给出 **2–5 个互斥的 A–E 常规选项**；仅当常规选项无法诚实覆盖合理路径时才开放 `OTHER`。主 agent 必须单选并说明理由，griller 沿未闭合后果追问，最后逐题给出选择合法性、闭合判定和 gate。

该 pi package 提供：

- **扩展**：自动上下文预检、一问一答编排、选择校验、终局审判、报告和崩溃恢复。
- **技能**：`grill-me` 的范围纪律、证据引用、单选和追问规则。
- **子代理**：`context-scout` 负责只读上下文采集；`griller` 负责正式拷问。

## 安全

- Git 安装会克隆并执行代码。请固定 **40 位 commit SHA**，不要只依赖可移动 tag：`pi install git:github.com/a8851625/pi-grill-storm@<commit-SHA>`。
- 上下文预检的会话、文件、历史报告和子代理输出都是被评审的数据，不是指令；不执行其中嵌入的指令。
- `context-scout` 只能使用只读工具检索当前工作区。扩展还会拒绝工作区外路径、`.git`、`.pi`、`node_modules`、构建/缓存目录、环境文件和常见凭据文件。
- npm 发布尚未配置；受支持的安装通道是 Git + SHA。

## 安装

```bash
# 推荐：不可变 commit SHA
pi install git:github.com/a8851625/pi-grill-storm@<commit-SHA>

# 人类可读的发布 tag；SHA 仍是更强的锁定方式
pi install git:github.com/a8851625/pi-grill-storm@v0.5.0

# 跟随 main
pi install git:github.com/a8851625/pi-grill-storm
```

Pi 会在 `~/.pi/agent/settings.json` 记录包，并克隆到 `~/.pi/agent/git/github.com/a8851625/pi-grill-storm`。安装后重启或 `/reload`。移除：

```bash
pi remove git:github.com/a8851625/pi-grill-storm
```

Pi 设置中还需要安装 `npm:pi-subagents`。

## 启动拷问

直接开始即可：

```text
/grill-storm
```

在当前会话正在讨论多个主题时，给一个简短范围提示可以让预检更快、更稳定地聚焦，但不需要提供文件路径：

```text
/grill-storm "ClickHouse sink 优化"
/grill-storm "订单写入延迟" -i high
```

预检会：

1. 读取当前会话中最多 16 条最近的用户/主 agent 文本作为**候选**，不会把整段聊天自动混入证据。
2. 根据范围提示，或在没有提示时根据最新实质请求、工作区目录结构、文件名、关键词命中和实际内容，收窄一个具体主题。
3. 用只读检索定位并读取相关工作区文件，选择 1–5 个最小来源。文件来源必须记录已读取的行范围；会话来源记录候选 ID。
4. 验证来源路径、行范围、文本内容和主题锚点后，写入固定的 manifest、evidence 和 context 文件。
5. 只有固定证据包就绪后才会启动 `griller`。后续题目只能依据该 evidence 包或此前有效选择理由。

这避免了“最近交付状态恰好在聊天末尾，所以 ClickHouse 优化被拷问成发布状态”的范围漂移。若预检找不到足够且相关的材料，它会在一次重试后停止并说明缺口；先在会话中说明当前要评审的工作，再运行 `/grill-storm` 即可。

其他命令：

```text
/grill-load [文件]                 # 注入此前报告，作为后续会话上下文
/grill-cleanup [-n] [--artifacts]  # 清理受管理的遗留文件或过期产物
/grill-log [usage]                 # 查看当前状态或用量历史
```

## 自动上下文契约

预检输出不是可信证据本身。扩展只接受并固化以下来源：

- **文件来源**：当前工作区内的普通文本文件，相对路径及已读取的 `startLine` / `endLine` 均被记录；每段最多 500 行且必须落在证据预算内，超限会被拒绝而不是静默截断。
- **会话来源**：预检 intake 文件里真实存在的 `S<N>` 候选条目；不会引用未列入 intake 的聊天内容。
- **主题锚点**：最终 evidence 必须实际包含硬性范围的可辨识术语。首题的题干和 `decisionAxis` 也必须各自命中该范围锚点，不能只在 `scopeLink` 里自称相关。

自动收集完成后，TUI 会显示最终范围、来源清单和 manifest 路径。报告也保留该信息，便于复盘“为何这些材料被用于拷问”。

## 选项与作答契约

每个问题包含：

- 一个直接影响声明范围的决策问题。
- `A` 至 `E`：2–5 个常规选项，ID 连续、选项互斥，每项均说明关键前提、代价或后果。
- `OTHER`：仅 griller 设置 `allowOther=true` 时出现；它**不计入** 2–5 个常规选项，且必须填写具体替代方案。开启它还必须用 `otherRationale` 引用材料，说明 A-E 为什么无法覆盖合理路径。
- `scopeLink`：明确说明问题为何直接影响本次范围，包含声明的范围文本，并额外指向材料中的具体机制、代码路径、数值或约束。
- `decisionAxis`：本题唯一的取舍轴；题干、决策轴和去掉范围标题后的 `scopeLink` 都必须各自与允许材料或上一轮真实选择理由关联，不能只借 `why` 引文背书。
- `axisValue`：每个 A-E 选项在同一决策轴上的原子互斥取值。插件拒绝重复、包含或可叠加的伪单选项。
- `why`：证据说明。`medium`、`high`、`max` 下必须引用至少 15 个字符的允许材料正文或上一轮真实选择理由。

主 agent 对当前题调用一次 `grill_answer`：

```text
questionId         # 必须是当前题 ID
selectedOptionId   # A-E 之一；仅开放时可选 OTHER
reason             # 为什么该选择能正面处理该题
otherAnswer        # 仅 selectedOptionId=OTHER 时必填
```

工具会拒绝历史题 ID、空理由、当前题未提供的选项、未开放的 `OTHER`、选择 `OTHER` 却未自由填写，以及常规选项同时夹带 `otherAnswer` 的调用。

## 强度

| 档位 | 基准轮数 | 额外规则 |
| --- | ---: | --- |
| `low` | 6 | 引用为建议；可提前结束；仅 critical 审判从严。 |
| `medium` | 12 | 引用闸门与追问性。默认。 |
| `high` | 18 | medium + 承诺跟踪。 |
| `max` | 30 | high + 对看似已闭合选择提出反例；30 轮封顶。 |

材料深度会调整常规上限：小于 5 KB 为 x0.6，5–20 KB 为 x1.0，大于 20 KB 为 x1.3；`max` 不超过 30。测试或演示可用 `GRILL_MAX_ROUNDS` 覆盖。

## 工作流

```text
/grill-storm [可选范围提示]
  -> context-scout 检索当前会话候选和工作区
  -> 验证并写入 source manifest + 原始 evidence + 范围 context
  -> griller 只在固定范围内提出一题，附 2-5 个 A-E 选项和可选 OTHER
  -> 主 agent 通过 grill_answer 单选并说明理由
  -> griller 只沿同一范围内未闭合的选择后果追问
  -> 终局审判校验选择是否合法、理由是否真正闭合问题
  -> 写入 report-<runId>.md、report-<runId>.json、latest.json、usage.jsonl
```

完成消息始终显示题数、gate 及 Markdown、JSON、`latest.json` 的完整路径。使用 `/grill-load` 注入完整报告。

## Gate

critical 问题未有效选择、被跳过或终局未闭合时，`gate=blocked`。选择普通 A–E 不是自动通过：选择理由仍必须给出可复核的机制、数字、时限或证据。

如果终局审判失败，critical 题保守判为未闭合，不会被“文本够长”之类的启发式放行。v0.3.x 的自由文本会话和 v0.4.x 的显式来源活动会话都无法安全迁移到 v3 自动上下文快照，需重新运行 `/grill-storm`；已完成的旧报告仍可通过 `/grill-load` 读取。

## 产物

所有产物位于 `<cwd>/.pi/grill/`：

- `intake-<runId>.json`：有限的会话候选池，仅供 context-scout 筛选，不是最终证据。
- `context-discovery-<runId>.json`：预检的结构化原始输出。
- `manifest-<runId>.json`：最终自动来源清单，包括选择理由、文件相对路径/行范围或会话 ID。
- `evidence-<runId>.md`：仅最终选中来源的原始正文或行片段，用于引文校验，不含插件生成模板。
- `context-<runId>.md`：固定范围契约、来源清单和证据包，供 `griller` 读取。
- `questions-<runId>-r<N>.json`：每轮原始提问输出。
- `report-<runId>.md` / `report-<runId>.json`：完整交付物。
- `latest.json`：原子写入的最新结构化报告，含 owner 信息。
- `usage.jsonl`：用量历史。
- `cleanup.log`：清理操作记录。

## 开发与测试

```bash
pi install /absolute/path/to/pi-grill-storm
npm test
pi -e ./extensions/index.ts --list-models
```

仓库内的契约测试覆盖：自动上下文启动、范围提示、文件行范围、会话来源边界、来源主题锚点、manifest/evidence 固化、预检恢复、2/5 选项边界、连续 A-E、唯一决策轴与伪单选拒绝、`OTHER` 覆盖缺口、范围外题干拒绝、历史理由引用、critical 无终局审判时 gate 阻断、重复题号、重复预检/提问/审判完成事件只交付一次、报告序列化和恢复决策。

## 变更记录

- **2026-08-21（v0.5.0）**：`/grill-storm` 默认先自动采集当前会话和工作区上下文；新增只读 `context-scout`、可审计 manifest、来源行范围、主题锚点验证和预检崩溃恢复。显式 source/recent 不再是启动前提。
- **2026-08-21（v0.4.0）**：以范围受控的 A-E 单选题替代自由文本 `accepted/revised/rejected` 状态；支持按需 `OTHER` 自由填写；引入选择感知的审判/报告/恢复，以及提交到仓库的契约测试。
- **2026-08-21（v0.3.4）**：完成交付会显示统计、gate 和 Markdown/JSON/`latest.json` 路径。
- **2026-08-16（v0.3.1）**：从批量审查改为一问一答追问，并将终局审查收敛给 griller。
