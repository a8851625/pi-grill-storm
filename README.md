# grill-storm 🔥

让 subagent 以 **grill-me 技能**拷问主 agent 的计划/设计，主 agent 自动逐题**选择**（接受 / 修订后接受 / 拒绝）并**作答**，独立评审者按 rubric 评分，弱答案进入二轮追问，最终交付「问题清单 + 选择 + 回答 + 评审」的报告，可作为后续会话上下文复用。

一个 pi package，在线安装后自动提供：

- **扩展**（`extensions/`）：拷问会话编排（spawn 子代理 → 注入问题 → 收集作答 → 独立评审 → 追问 → 生成报告）
- **技能**（`skills/grill-me`）：增强版 grill-me 拷问规范（8 个攻击面 + 作业评审 rubric）
- **子代理**（`agents/griller.md` 拷问者、`agents/reviewer.md` 评审者）：由 pi-subagents 自动发现

## ⚠ 安全提示

- 经 git 源安装 = 克隆可变 HEAD，无 checksum/签名：**作者 force-push 即可改变你本机执行的代码**。安装即代表你信任该仓库。生产环境建议锁定版本：`pi install git:github.com/a8851625/pi-grill-storm@v0.3.0`（或等待 npm 通道）。
- 拷问材料文本按「被评审的引用」处理，注入消息带标识与"非指令"标注；勿把材料中的指令当指令执行。

## 在线安装

```bash
# git 源（推荐锁版本）
pi install git:github.com/a8851625/pi-grill-storm@v0.3.0

# 不锁版本（跟随 main）
pi install git:github.com/a8851625/pi-grill-storm
pi install https://github.com/a8851625/pi-grill-storm
```

安装写入 `~/.pi/agent/settings.json` 的 `packages`，克隆到 `~/.pi/agent/git/github.com/a8851625/pi-grill-storm`，重启（或 `/reload`）后生效。移除：

```bash
pi remove git:github.com/a8851625/pi-grill-storm
```

> 依赖：设置中已启用 pi-subagents 包（`packages` 含 `npm:pi-subagents`）。升级：`pi install git:github.com/a8851625/pi-grill-storm@v0.3.0`（改 ref 即可移动）。

## 使用

```
/grilling [主题或文件...]   # 启动一次拷问（/grill 为别名）
/grill-load [文件]          # 把上次报告注入会话作为后续上下文（gate=blocked 时提示先闭合 critical）
/grill-cleanup [-n]         # 显式清理 v0.1 遗留拷贝（-n dry-run；不再自动删除）
/grill-log [usage]          # 当前状态；/grill-log usage 查看历史用量（usage.jsonl）
```

### 触发纪律（用起来才有价值）

以下三类场景**必须** `/grilling`：

1. 产出 PRD / 方案 / 设计文档后（第 1 版 draft 完成即拷问）；
2. 需求进入实现前（gate 阶段）——特别是报告 `gate=blocked`（critical 未闭合）时不得直接进实现；
3. 重大方向/取舍决策前。

用量自动记录到 `.pi/grill/usage.jsonl`（耗时/token/题数/gate），`/grill-log usage` 可查。

## 工作流（v0.3）

```
/grilling  [用户触发]
  ├─ ① 收集拷问材料（指定文件或最近会话 → .pi/grill/context-*.md）
  ├─ ② 按材料长度分档题数（<5KB:5-8 / 5-20KB:8-12 / >20KB:12-15），spawn「griller」
  ├─ ③ 取回问题，特异性校验（术语/bigram 与材料重合；全模板则失败提示重跑）
  ├─ ④ 注入 [grill-me 拷问回合] → 主 agent 逐题 grill_answer（同题重答覆盖）
  ├─ ⑤ agent_settled 缺口补催（≤2 次）→ 全答后 spawn「reviewer」按 rubric 评分（0-2）
  ├─ ⑥ 得分 <1 的题注入 [追问回合]（≤2 轮，同 ID 重答）→ 复评
  └─ ⑦ 交付 report-<runId>.md + report-<runId>.json + latest.json（原子）+ usage.jsonl
       报告含：gate（critical 未闭合=⛔ blocked）、评审分、闭合标注、耗时与 token 指标
```

## 主 agent 的选择语义

- `accepted` —— 接受拷问，正面作答
- `revised`  —— 先修正/限定方案再作答（answer 中说明修正）
- `rejected` —— 拒绝该问题（answer 中说明理由）
- 未调用工具的问题 → 报告记为 `skipped`（最多补催两次）

## 评审 rubric（reviewer，fixed）

| 分数 | 含义 | 特征 |
| --- | --- | --- |
| 2 | 充分 | 直接正面回答；给出具体机制/数字/时限/证据；不自我矛盾 |
| 1 | 部分 | 有实质回应但未闭合——缺关键细节或只有方向性承诺 |
| 0 | 敷衍 | 答非所问、空话、自相矛盾、复述问题 |

弱信号词（除非有具体内容否则≤1 分）："未验证""未知""待定""不清楚""需要调研""后续""到时候"。得分 <1 → 二轮追问（≤2 轮、每轮 ≤8 题）。

## 产物位置

`<cwd>/.pi/grill/`：

- `context-<ts>.md` — 拷问材料
- `questions-<runId>.json` — griller 原始输出
- `review-material-<runId>.<round>.md` — 评审输入
- `report-<runId>.md` / `report-<runId>.json` — 按 runId 隔离的交付物
- `latest.json` — 最新一轮完整结构化交付物（原子更新）
- `usage.jsonl` — 用量历史
- `cleanup.log` — /grill-cleanup 操作日志

## 决策记录

- **2026-08-16（v0.3）**：v0.2 拷问发现"提效/提质"无锚点、自答自认通过、无追问、git 可变 HEAD、自动删除执行面过大。本版落实：gate、reviewer rubric、二轮追问、特异性校验、成本/用量记录、报告隔离、显式清理。**待验证假设**（未证）："缺乏对抗性提问是需求质量差的主因"。对照实验设计：同一需求交替 grilling vs checklist，5 个样本比较返工率/缺陷数，净收益为正前"提效"表述保持"待验证"。

## 自定义

包内文件是只读资源，`pi update --extensions` 会重置 git 克隆。想定制请 fork 后安装自己的 fork；或复制技能到用户目录覆盖（同名技能用户目录优先级更高）：`~/.pi/agent/skills/grill-me/SKILL.md`。

## 开发

仓库结构即 pi package 布局：

```
extensions/index.ts        # 插件本体（v0.3）
skills/grill-me/SKILL.md   # 拷问技能 + 评审 rubric
agents/griller.md          # 拷问者子代理
agents/reviewer.md         # 评审者子代理
```

`package.json` 的 `pi` manifest 声明三类资源；`pi.subagents.agents` 由 pi-subagents 读取。

本地验证：

```bash
pi install /absolute/path/to/pi-grill-storm   # 本地路径安装
```

测试：`/tmp/grill-unit-test.mjs`（23 项纯函数单测：解析变体/分档/特异性/gate/弱答案/评审解析/清理判定）、`/tmp/grill-load-test.mjs`（扩展注册 mock 测试）、`/tmp/grill-e2e-test.mjs`（真实模型全链路）。