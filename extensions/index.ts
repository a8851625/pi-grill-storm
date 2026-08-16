/**
 * grill-storm —— "拷问风暴"插件
 *
 * 让一个 subagent 以 grill-me 技能拷问主 agent 的计划/设计，主 agent 自动
 * 逐题作出选择（接受 / 修订后接受 / 拒绝）并作答，最终交付
 * "全部问题清单 + 每题选择 + 回答" 的报告，可作为后续会话上下文复用。
 *
 * 工作流：
 *   1. `/grilling [主题或文件...]` 收集当前会话 / 指定文档作为拷问材料；
 *   2. 通过 pi-subagents 扩展 RPC 异步 spawn `griller` 子代理
 *      （带 grill-me 技能，outputSchema 强制输出结构化问题清单 JSON）；
 *   3. 监听 `subagent:async-complete` 取回问题，动态启用 `grill_answer`
 *      工具，并注入自定义消息自动触发主 agent 逐题选择 + 作答；
 *   4. `agent_settled` 时检查缺口（最多补催两次），然后汇总生成
 *      `.pi/grill/report.md` 与 `.pi/grill/latest.json`；
 *   5. `/grill-load` 可将报告重新注入会话，作为后续上下文使用。
 *
 * 依赖：pi-subagents 扩展（settings.json packages 中已安装）。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const PLUGIN = "grill-storm";
const MANAGED_MARKER = "<!-- managed-by:grill-storm -->";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const RPC_TIMEOUT_MS = 30_000;
const RESULTS_DIR_NAME = "async-subagent-results";

const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 20;
const MAX_FOLLOW_UPS = 2;
const MAX_CONTEXT_CHARS = 60_000;

/** 子代理必须返回的问题清单结构（JSON Schema）。 */
const QUESTION_SCHEMA = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "question", "why"],
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          why: { type: "string", description: "为什么这个问题能击穿方案（拷问意图）" },
          severity: {
            type: "string",
            enum: ["critical", "major", "minor"],
            description: "严重程度：critical 击穿性 / major 重大缺口 / minor 打磨项",
          },
        },
      },
    },
  },
} as const;

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

interface GrilledQuestion {
  id: string;
  question: string;
  why: string;
  severity: "critical" | "major" | "minor" | "unknown";
}

type Decision = "accepted" | "revised" | "rejected";

interface AnswerRecord {
  questionId: string;
  decision: Decision;
  answer: string;
}

interface GrillState {
  topic: string;
  runId: string;
  asyncDir?: string;
  contextPath?: string;
  questionsRawPath?: string; // 子代理写入的原始输出文件
  questions: GrilledQuestion[];
  answers: Map<string, AnswerRecord>;
  phase: "context" | "spawned" | "ready" | "answering" | "done" | "failed";
  followUpsSent: number;
  prevActiveTools: string[];
  pollTimer?: NodeJS.Timeout;
  createdAt: number;
  updatedAt: number;
  reportPath?: string;
  jsonPath?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function grillDir(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "grill");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** 从任意文本中尽力提取问题清单 JSON。 */
function extractQuestionsFromText(text: string): GrilledQuestion[] | null {
  if (!text) return null;
  const candidates: unknown[] = [];

  // 1) ```json ... ``` 围栏
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) candidates.push(m[1]);

  // 2) 整个文本本身就是 JSON 对象
  candidates.push(text);

  // 3) 文本中的 `{ "questions": [...] }` 片段
  const objRe = /\{\s*"questions"\s*:\s*\[[\s\S]*?\]\s*\}/g;
  while ((m = objRe.exec(text))) candidates.push(m[0]);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (!parsed) continue;
    const rawQuestions = (parsed as { questions?: unknown }).questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) continue;
    const questions: GrilledQuestion[] = [];
    for (const raw of rawQuestions.slice(0, MAX_QUESTIONS)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const id = typeof r.id === "string" && r.id ? r.id : `Q-${questions.length + 1}`;
      if (typeof r.question !== "string" || !r.question.trim()) continue;
      questions.push({
        id,
        question: r.question.trim(),
        why: typeof r.why === "string" ? r.why.trim() : "",
        severity: r.severity === "critical" || r.severity === "major" || r.severity === "minor"
          ? r.severity
          : "unknown",
      });
    }
    // 保证 id 唯一
    const seen = new Set<string>();
    for (const q of questions) {
      let id = q.id;
      let n = 2;
      while (seen.has(id)) id = `${q.id}#${n++}`;
      seen.add(id);
      q.id = id;
    }
    if (questions.length >= MIN_QUESTIONS) return questions;
  }
  return null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 渲染问题清单（供注入消息与渲染器使用）。 */
function renderQuestions(questions: GrilledQuestion[]): string {
  return questions
    .map((q, i) => `${i + 1}. [${q.severity}] ${q.question}\n   拷问意图: ${q.why || "—"}`)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* 旧版（v0.1 手动拷贝安装）遗留清理                                   */
/* ------------------------------------------------------------------ */

/**
 * v0.2 起资源由 pi package 直接提供（extensions/ skills/ agents/），
 * 不再拷贝到 ~/.pi/agent。若发现带 managed 标记的旧版拷贝则删除，
 * 避免用户目录中的旧副本遮蔽包内版本。用户手动改过的（无标记）保留。
 */
function cleanupLegacyManagedFiles(): string[] {
  const piAgentDir = process.env.PI_CODING_AGENT_DIR
    ? (process.env.PI_CODING_AGENT_DIR === "~"
        ? os.homedir()
        : process.env.PI_CODING_AGENT_DIR.startsWith("~/")
          ? path.join(os.homedir(), process.env.PI_CODING_AGENT_DIR.slice(2))
          : process.env.PI_CODING_AGENT_DIR)
    : path.join(os.homedir(), CONFIG_DIR_NAME, "agent");

  const targets: string[] = [
    path.join(piAgentDir, "agents", "griller.md"),
    path.join(piAgentDir, "skills", "grill-me", "SKILL.md"),
  ];

  const removed: string[] = [];
  for (const dst of targets) {
    try {
      const content = fs.readFileSync(dst, "utf8");
      if (content.slice(0, 200).includes(MANAGED_MARKER)) {
        fs.rmSync(dst, { force: true });
        removed.push(dst);
      }
    } catch {
      // 不存在或不可读则跳过
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* pi-subagents 扩展 RPC                                               */
/* ------------------------------------------------------------------ */

interface RpcReply {
  version: number;
  requestId: string;
  method?: string;
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

function rpcRequest(
  pi: ExtensionAPI,
  method: string,
  params: unknown,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<{ data: unknown }> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`pi-subagents RPC ${method} 超时（${timeoutMs}ms）。请确认已安装并启用 pi-subagents。`));
    }, timeoutMs);

    function onReply(payload: unknown) {
      clearTimeout(timer);
      unsubscribe?.();
      const reply = payload as RpcReply;
      if (!reply || reply.success) {
        resolve({ data: reply?.data });
        return;
      }
      reject(new Error(`pi-subagents RPC ${method} 失败: ${reply?.error?.message ?? "未知错误"}`));
    }

    unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, onReply);
    pi.events.emit(RPC_REQUEST_EVENT, {
      version: 1,
      requestId,
      method,
      params,
      source: { extension: PLUGIN },
    });
  });
}

/* ------------------------------------------------------------------ */
/* 上下文收集                                                          */
/* ------------------------------------------------------------------ */

async function collectContext(
  cwd: string,
  args: string,
  entryTexts: Array<{ role: string; text: string }>,
): Promise<{ topic: string; contextPath: string }> {
  const dir = grillDir(cwd);
  await fs.promises.mkdir(dir, { recursive: true });

  const parts = args.trim().split(/\s+/).filter(Boolean);
  const filePaths: string[] = [];
  const topicWords: string[] = [];

  for (const part of parts) {
    const candidate = path.resolve(cwd, part);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      filePaths.push(candidate);
    } else {
      topicWords.push(part);
    }
  }

  const topic = topicWords.join(" ") || (filePaths.length ? filePaths.map((p) => path.basename(p)).join(", ") : "当前会话中的方案");

  const chunks: string[] = [];
  if (filePaths.length > 0) {
    for (const file of filePaths.slice(0, 5)) {
      try {
        const content = await fs.promises.readFile(file, "utf8");
        chunks.push(`===== 材料文件: ${file} =====\n${truncate(content, 45_000)}`);
      } catch (error) {
        chunks.push(`===== 材料文件: ${file}（读取失败: ${String(error)}）=====`);
      }
    }
  }
  if (entryTexts.length > 0) {
    const recent = entryTexts.slice(-12)
      .map((e) => `[${e.role}] ${truncate(e.text, 6_000)}`)
      .join("\n\n");
    chunks.push(`===== 最近会话（主 agent 正在推进的方案材料）=====\n${truncate(recent, 30_000)}`);
  }
  const body = chunks.join("\n\n");
  const contextPath = path.join(dir, `context-${timestamp()}.md`);
  await fs.promises.writeFile(
    contextPath,
    `# Grill 拷问材料\n主题: ${topic}\n时间: ${new Date().toISOString()}\n目录: ${cwd}\n\n${body}\n`,
    "utf8",
  );
  return { topic, contextPath };
}

async function collectSessionTexts(ctx: { sessionManager: { buildContextEntries: () => Array<{ type?: string; message?: { role?: string; content?: unknown } }> } }): Promise<Array<{ role: string; text: string }>> {
  const entries = ctx.sessionManager.buildContextEntries() ?? [];
  const texts: Array<{ role: string; text: string }> = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (part && typeof part === "object" && (part as { type?: string; text?: string }).type === "text"
              ? ((part as { text?: string }).text ?? "")
              : ""))
            .filter(Boolean)
            .join("\n")
        : "";
    if (text.trim()) texts.push({ role: role === "user" ? "用户" : "主agent", text });
  }
  return texts;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function startGrill(
  pi: ExtensionAPI,
  sessionId: string,
  cwd: string,
  args: string,
  entryTexts: Array<{ role: string; text: string }>,
): Promise<GrillState> {
  const { topic, contextPath } = await collectContext(cwd, args, entryTexts);

  const state: GrillState = {
    topic,
    runId: randomUUID().slice(0, 8),
    contextPath,
    questions: [],
    answers: new Map(),
    phase: "spawned",
    followUpsSent: 0,
    prevActiveTools: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const questionsDir = grillDir(cwd);
  await fs.promises.mkdir(questionsDir, { recursive: true });
  const questionsRawPath = path.join(questionsDir, `questions-${state.runId}.json`);
  state.questionsRawPath = questionsRawPath;

  const task = [
    `[grill-storm] 以 grill-me 技能拷问以下方案。`,
    `主题: ${topic}`,
    `上下文文件（用 read 读取）: ${contextPath}`,
    ``,
    `要求:`,
    `1. 先 read 上下文文件，理解方案全貌；`,
    `2. 严格执行 grill-me 拷问会话规范，扫描攻击面（含糊表述、未验证假设、被忽略风险、缺失替代方案、目标与指标、成本收益、执行漏洞、反向视角）；`,
    `3. 输出 8-15 个尖锐、具体、可直接作答的问题，按严重程度排序，每题附 why（拷问意图）；`,
    `4. 最后必须调用 structured_output 返回 schema 规定的 JSON。`,
  ].join("\n");

  try {
    const reply = await rpcRequest(pi, "spawn", {
      agent: "griller",
      task,
      output: questionsRawPath,
      outputMode: "file-only",
      outputSchema: QUESTION_SCHEMA,
      // 只读任务，跳过验收门槛
      acceptance: { level: "none", reason: "grill 问题生成（只读）" },
    });
    const data = (reply.data ?? {}) as { text?: string; details?: Record<string, unknown> };
    const details = data.details ?? {};
    const asyncId = typeof details.asyncId === "string" ? details.asyncId : undefined;
    if (!asyncId) {
      // 从返回文本兜底解析
      const m = /run`?[\s:]*([0-9a-f-]{8,36})/i.exec(data.text ?? "");
      if (m) state.runId = m[1];
      throw new Error("未能从 pi-subagents 响应中解析 asyncId，请查看上方子代理输出。");
    }
    state.runId = asyncId;
    state.asyncDir = typeof details.asyncDir === "string" ? details.asyncDir : undefined;
    state.phase = "spawned";
    state.updatedAt = Date.now();
    persistSnapshot(pi, "grill-storm", state);
    schedulePolling(pi, sessionId, state);
    return state;
  } catch (error) {
    state.phase = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    persistSnapshot(pi, "grill-storm", state);
    throw error;
  }
}

/** 子代理产物是否已落盘（不依赖 result.json / async-complete 事件）。 */
function childArtifactsReady(state: GrillState): boolean {
  if (state.questionsRawPath && fs.existsSync(state.questionsRawPath)) return true;
  if (state.asyncDir) {
    const soRoot = path.join(state.asyncDir, "structured-output");
    if (fs.existsSync(soRoot)) {
      try {
        for (const sub of fs.readdirSync(soRoot)) {
          if (fs.existsSync(path.join(soRoot, sub, "output.json"))) return true;
        }
      } catch {
        // 忽略，继续下一个候选
      }
    }
    const resultsDir = path.join(state.asyncDir, "..", RESULTS_DIR_NAME);
    if (fs.existsSync(path.join(resultsDir, `${state.runId}.json`))) return true;
  }
  return false;
}

/** 兜底轮询：async-complete 事件可能丢失时直接探测子代理产物。 */
function schedulePolling(pi: ExtensionAPI, sessionId: string, state: GrillState) {
  if (!state.asyncDir) return;
  let tries = 0;
  state.pollTimer = setInterval(() => {
    tries += 1;
    if (state.phase === "ready" || state.phase === "answering" || state.phase === "done" || state.phase === "failed") {
      clearInterval(state.pollTimer!);
      return;
    }
    if (tries > 120) {
      // 10 分钟仍未就绪
      clearInterval(state.pollTimer!);
      state.phase = "failed";
      state.error = "拷问子代理长时间未返回结果（事件与轮询均超时）。";
      persistSnapshot(pi, "grill-storm", state);
      return;
    }
    if (childArtifactsReady(state)) {
      clearInterval(state.pollTimer!);
      void onQuestionsReady(pi, sessionId, state);
    }
  }, 5_000);
}

/** 问题就绪：解析、规范化并交给主 agent 作答。 */
async function onQuestionsReady(pi: ExtensionAPI, sessionId: string, state: GrillState) {
  if (state.phase === "ready" || state.phase === "answering" || state.phase === "done") return;
  console.log(`[${PLUGIN}] onQuestionsReady: 读取子代理输出…`);

  const raw = await readChildOutput(state);
  const questions = extractQuestionsFromText(raw);
  if (!questions || questions.length === 0) {
    state.phase = "failed";
    state.error = `无法从子代理输出解析问题清单。原始输出已保存在: ${state.questionsRawPath}`;
    persistSnapshot(pi, "grill-storm", state);
    return;
  }
  state.questions = questions;
  state.phase = "ready";
  state.updatedAt = Date.now();
  persistSnapshot(pi, "grill-storm", state);
  console.log(`[${PLUGIN}] 解析到 ${questions.length} 个问题`);

  // 动态启用 grill_answer 工具
  const active = pi.getActiveTools();
  if (!active.includes("grill_answer")) {
    state.prevActiveTools = active;
    try {
      pi.setActiveTools([...active, "grill_answer"]);
      console.log(`[${PLUGIN}] grill_answer 已启用（原工具数 ${active.length}）`);
    } catch (error) {
      console.error(`[${PLUGIN}] setActiveTools 失败:`, error);
    }
  }

  const instruction = [
    `[grill-me 拷问回合]`,
    `subagent 拷问者（griller，grill-me 技能）已对你的方案提出 ${questions.length} 个问题。现在轮到你自证。`,
    `请对**每一个**问题调用一次 \`grill_answer\` 工具：`,
    `- questionId: 问题 ID；`,
    `- decision: accepted（接受拷问并正面作答）｜revised（先修正/限定方案再作答，answer 中说明修正）｜rejected（拒绝该问题，answer 中说明理由）；`,
    `- answer: 你的回应——具体、诚实、简短有力，直接回答，不要绕圈子。`,
    `全部作答完毕后，用一段话总结：这次拷问暴露了哪些短板，你将如何改进。`,
    ``,
    `问题清单：`,
    renderQuestions(questions),
  ].join("\n");

  pi.sendMessage(
    {
      customType: "grill-questions",
      content: instruction,
      display: true,
      details: { count: questions.length, runId: state.runId },
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
  console.log(`[${PLUGIN}] 注入拷问消息（${questions.length} 题），等待主 agent 作答…`);
  state.phase = "answering";
  state.updatedAt = Date.now();
  persistSnapshot(pi, "grill-storm", state);
}

/** 读取子代理输出：优先 structured-output，其次 output 文件，再其次 result.json / asyncDir 日志。 */
async function readChildOutput(state: GrillState): Promise<string> {
  // 结构化的完整 JSON：<asyncDir>/structured-output/<sub>/output.json
  if (state.asyncDir) {
    const soRoot = path.join(state.asyncDir, "structured-output");
    if (fs.existsSync(soRoot)) {
      try {
        const subs = fs.readdirSync(soRoot);
        for (const sub of subs) {
          const out = path.join(soRoot, sub, "output.json");
          if (fs.existsSync(out)) {
            return await fs.promises.readFile(out, "utf8");
          }
        }
      } catch {
        // 继续下一个候选
      }
    }
  }
  const tries: Array<string | undefined> = [];
  if (state.questionsRawPath) tries.push(state.questionsRawPath);
  // result.json（RESULTS_DIR）保存在 asyncDir 同级目录，从 asyncDir 推导
  const resultsDir = path.join(state.asyncDir!, "..", RESULTS_DIR_NAME);
  tries.push(path.join(resultsDir, `${state.runId}.json`));
  tries.push(path.join(state.asyncDir!, "output-0.log"));
  for (const file of tries) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const content = await fs.promises.readFile(file, "utf8");
      if (file.endsWith(".json") && file.includes(RESULTS_DIR_NAME)) {
        // result.json：优先取 structuredOutput，其次最终 output 文本
        const parsed = tryParseJson(content) as {
          results?: Array<{ structuredOutput?: unknown; output?: string; error?: string }>;
          summary?: string;
        } | null;
        if (parsed?.results?.[0]?.structuredOutput) {
          return JSON.stringify(parsed.results[0].structuredOutput);
        }
        if (parsed?.results?.[0]?.output) return parsed.results[0].output;
        if (typeof parsed?.summary === "string") return parsed.summary;
      } else {
        return content;
      }
    } catch {
      // 继续下一个候选
    }
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* 报告交付                                                            */
/* ------------------------------------------------------------------ */

const DECISION_LABEL: Record<Decision, string> = {
  accepted: "接受",
  revised: "修订后接受",
  rejected: "拒绝",
};

async function buildReport(state: GrillState, cwd: string): Promise<{ markdown: string; json: unknown }> {
  const rows = state.questions.map((q) => {
    const a = state.answers.get(q.id);
    return {
      ...q,
      decision: a?.decision ?? "skipped",
      answer: a?.answer ?? "",
    };
  });
  const counts = {
    accepted: rows.filter((r) => r.decision === "accepted").length,
    revised: rows.filter((r) => r.decision === "revised").length,
    rejected: rows.filter((r) => r.decision === "rejected").length,
    skipped: rows.filter((r) => r.decision === "skipped").length,
  };

  const lines: string[] = [];
  lines.push(`# 🍳 Grill Report — ${state.topic}`);
  lines.push("");
  lines.push(`- 时间: ${new Date(state.updatedAt).toISOString()}`);
  lines.push(`- 子代理: griller（grill-me 技能）｜runId: ${state.runId}`);
  lines.push(`- 材料: ${state.contextPath ?? "—"}`);
  lines.push(`- 问题总数: ${rows.length}｜接受 ${counts.accepted}｜修订后接受 ${counts.revised}｜拒绝 ${counts.rejected}｜未作答 ${counts.skipped}`);
  lines.push("");
  lines.push(`## 问题清单与选择`);
  lines.push("");
  rows.forEach((r, i) => {
    lines.push(`### ${i + 1}. [${r.decision}] ${r.id}（${r.severity}）`);
    lines.push(`**问题**: ${r.question}`);
    lines.push(`**拷问意图**: ${r.why || "—"}`);
    if (r.decision === "skipped") {
      lines.push(`**选择**: 未作答（主 agent 未回应）`);
    } else {
      lines.push(`**选择**: ${DECISION_LABEL[r.decision as Decision]}`);
      lines.push(`**回答**:`);
      lines.push(r.answer.trim().split("\n").map((l) => `> ${l}`).join("\n"));
    }
    lines.push("");
  });
  lines.push(`## 选择总览`);
  lines.push("");
  lines.push(`| ID | 严重度 | 选择 | 回答摘要 |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const r of rows) {
    const summary = r.answer ? r.answer.trim().replace(/\s+/g, " ").slice(0, 60) : "—";
    lines.push(`| ${r.id} | ${r.severity} | ${r.decision} | ${summary} |`);
  }
  lines.push("");

  return {
    markdown: lines.join("\n"),
    json: {
      meta: {
        topic: state.topic,
        plugin: PLUGIN,
        runId: state.runId,
        createdAt: new Date(state.createdAt).toISOString(),
        updatedAt: new Date(state.updatedAt).toISOString(),
        counts,
        contextPath: state.contextPath,
      },
      questions: rows,
    },
  };
}

async function finalizeReport(pi: ExtensionAPI, sessionId: string, state: GrillState, cwd: string) {
  const { markdown, json } = await buildReport(state, cwd);
  const dir = grillDir(cwd);
  await fs.promises.mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, "report.md");
  const jsonPath = path.join(dir, "latest.json");
  await fs.promises.writeFile(reportPath, markdown, "utf8");
  await fs.promises.writeFile(jsonPath, JSON.stringify(json, null, 2), "utf8");
  state.reportPath = reportPath;
  state.jsonPath = jsonPath;
  state.phase = "done";
  state.updatedAt = Date.now();

  // 还原工具集
  if (state.prevActiveTools.length > 0) {
    try {
      pi.setActiveTools(state.prevActiveTools);
    } catch {
      // 忽略还原失败
    }
  }
  state.prevActiveTools = [];
  persistSnapshot(pi, "grill-storm", state);
}

/** agent 完全 settle 后检查作答进度，缺口补催，完成后出报告。 */
async function onAgentSettled(pi: ExtensionAPI, sessionId: string, state: GrillState, cwd: string) {
  if (state.phase !== "answering") return;
  const missing = state.questions.filter((q) => !state.answers.has(q.id)).map((q) => q.id);
  console.log(`[${PLUGIN}] agent_settled: 已答 ${state.answers.size}/${state.questions.length}，缺 ${missing.length} 题`);
  if (missing.length === 0) {
    await finalizeReport(pi, sessionId, state, cwd);
    return;
  }
  if (state.followUpsSent < MAX_FOLLOW_UPS) {
    state.followUpsSent += 1;
    const ids = missing.slice(0, 8).join(", ");
    const extra = missing.length > 8 ? `（共 ${missing.length} 题未作答）` : "";
    console.log(`[${PLUGIN}] 补催 ${state.followUpsSent}/${MAX_FOLLOW_UPS}`);
    pi.sendMessage(
      {
        customType: "grill-followup",
        content: `[grill-me 补催 ${state.followUpsSent}/${MAX_FOLLOW_UPS}] 还有 ${missing.length} 个问题未选择/作答：${ids}${extra}。请立即用 grill_answer 工具逐题补齐，然后给出总结。`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } else {
    await finalizeReport(pi, sessionId, state, cwd);
  }
}

/* ------------------------------------------------------------------ */
/* 持久化快照（appendEntry，支持分支与恢复）                           */
/* ------------------------------------------------------------------ */

function persistSnapshot(pi: ExtensionAPI, customType: string, state: GrillState) {
  try {
    pi.appendEntry(customType, {
      topic: state.topic,
      runId: state.runId,
      contextPath: state.contextPath,
      reportPath: state.reportPath,
      jsonPath: state.jsonPath,
      phase: state.phase,
      error: state.error,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      questions: state.questions,
      answers: Object.fromEntries(state.answers.entries()) as Record<string, AnswerRecord>,
    });
  } catch (error) {
    console.error(`[${PLUGIN}] appendEntry 失败:`, error);
  }
}

/* ------------------------------------------------------------------ */
/* 扩展注册                                                            */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  const sessions = new Map<string, GrillState>();
  let assetsReady = false;

  // 每个 session 独立状态
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    if (!sessions.has(sessionId)) sessions.set(sessionId, { ...emptyState() });

    if (!assetsReady) {
      assetsReady = true;
      const removed = cleanupLegacyManagedFiles();
      if (removed.length > 0) {
        console.log(`[${PLUGIN}] 已清理旧版（v0.1 拷贝安装）遗留文件: ${removed.join(", ")}`);
      }
    }

    // 从会话记录恢复上次 grill 快照
    const state = sessions.get(sessionId)!;
    let restored = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "grill-storm") continue;
      const data = entry.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== "object") continue;
      state.topic = typeof data.topic === "string" ? data.topic : state.topic;
      state.runId = typeof data.runId === "string" ? data.runId : state.runId;
      state.contextPath = typeof data.contextPath === "string" ? data.contextPath : undefined;
      state.reportPath = typeof data.reportPath === "string" ? data.reportPath : undefined;
      state.jsonPath = typeof data.jsonPath === "string" ? data.jsonPath : undefined;
      state.error = typeof data.error === "string" ? data.error : undefined;
      if (Array.isArray(data.questions)) state.questions = data.questions as GrilledQuestion[];
      if (data.answers && typeof data.answers === "object") {
        state.answers = new Map(Object.entries(data.answers as Record<string, AnswerRecord>));
      }
      if (typeof data.phase === "string") {
        state.phase = (data.phase === "answering" ? "done" : data.phase) as GrillState["phase"];
      }
      restored = true;
    }
    if (!restored) {
      sessions.set(sessionId, { ...emptyState() });
    }
  });

  function emptyState(): GrillState {
    return {
      topic: "",
      runId: "",
      questions: [],
      answers: new Map(),
      phase: "context",
      followUpsSent: 0,
      prevActiveTools: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // 子代理完成事件（pi-subagents 通过 pi.events 广播）
  pi.events.on(ASYNC_COMPLETE_EVENT, (payload) => {
    const data = payload as { id?: string; state?: string; success?: boolean };
    if (!data?.id) return;
    for (const [sessionId, state] of sessions) {
      if (state.runId === data.id && (state.phase === "spawned" || state.phase === "context")) {
        console.log(`[${PLUGIN}] async-complete: ${data.id} (state=${data.state}, success=${data.success})`);
        void onQuestionsReady(pi, sessionId, state);
      }
    }
  });

  // 主 agent 完全 settle 后检查作答进度
  pi.on("agent_settled", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    const state = sessions.get(sessionId);
    if (state) await onAgentSettled(pi, sessionId, state, ctx.cwd);
  });

  /* ---------------- 工具：grill_answer ---------------- */

  pi.registerTool({
    name: "grill_answer",
    label: "Grill Answer",
    description:
      "在 grill-me 拷问回合中，为某一个拷问问题记录你的选择（接受/修订后接受/拒绝）与回答。仅当收到 [grill-me 拷问回合] 消息时使用，每个问题调用一次。",
    promptSnippet: "记录对某个拷问问题的选择与回答",
    promptGuidelines: [
      "收到 [grill-me 拷问回合] 消息后，必须用 grill_answer 对清单中每个问题调用一次，不要跳过。",
    ],
    parameters: Type.Object({
      questionId: Type.String({ description: "问题 ID（问题清单中的 id，如 Q-1）" }),
      decision: StringEnum(["accepted", "revised", "rejected"] as const, {
        description: "accepted=接受拷问并正面作答；revised=先修正/限定方案再作答；rejected=拒绝该问题并说明理由",
      }),
      answer: Type.String({ description: "你的回应：具体、诚实、简短有力" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId() ?? "default";
      const state = sessions.get(sessionId);
      if (!state || state.phase !== "answering" || state.questions.length === 0) {
        return {
          content: [{ type: "text", text: "当前没有进行中的 grill-me 拷问回合，忽略本次调用。" }],
          details: {},
        };
      }
      const question = state.questions.find((q) => q.id === params.questionId);
      if (!question) {
        return {
          content: [{ type: "text", text: `未知问题 ID: ${params.questionId}。可用 ID: ${state.questions.map((q) => q.id).join(", ")}` }],
          details: {},
        };
      }
      state.answers.set(params.questionId, {
        questionId: params.questionId,
        decision: params.decision,
        answer: params.answer,
      });
      state.updatedAt = Date.now();
      persistSnapshot(pi, "grill-storm", state);
      const missing = state.questions.length - state.answers.size;
      return {
        content: [{ type: "text", text: `已记录 ${params.questionId} [${params.decision}]。进度 ${state.answers.size}/${state.questions.length}${missing > 0 ? `，还剩 ${missing} 题` : "，全部完成"}` }],
        details: { answered: state.answers.size, total: state.questions.length, missing },
      };
    },
  });

  /* ---------------- 命令：/grilling（/grill） ---------------- */

  const grillHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    const existing = sessions.get(sessionId);
    if (existing && (existing.phase === "spawned" || existing.phase === "ready" || existing.phase === "answering")) {
      ctx.ui.notify(`[${PLUGIN}] 已有进行中的拷问会话（runId=${existing.runId}），请先等它结束。`, "warning");
      return;
    }
    if (!existing) sessions.set(sessionId, { ...emptyState() });

    try {
      cleanupLegacyManagedFiles();
      const entryTexts = await collectSessionTexts(ctx);
      const state = await startGrill(pi, sessionId, ctx.cwd, args, entryTexts);
      sessions.set(sessionId, state);
      ctx.ui.notify(
        `[${PLUGIN}] 拷问会话已启动（runId=${state.runId}）：子代理 griller 正在以 grill-me 生成问题，材料: ${state.contextPath}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`[${PLUGIN}] 启动失败: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.registerCommand("grilling", {
    description: "启动 grill-me 拷问：subagent 拷问当前方案，主 agent 自动选择并回答，生成报告",
    handler: grillHandler,
  });
  pi.registerCommand("grill", {
    description: "启动 grill-me 拷问（/grilling 的别名）",
    handler: grillHandler,
  });

  /* ---------------- 命令：/grill-load ---------------- */

  pi.registerCommand("grill-load", {
    description: "把上次拷问报告注入当前会话，作为后续上下文使用（可指定文件路径）",
    getArgumentCompletions: (prefix: string) => {
      const dir = grillDir(process.cwd());
      const candidates = ["report.md", "latest.json"].filter((f) => fs.existsSync(path.join(dir, f)));
      return candidates.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId() ?? "default";
      const state = sessions.get(sessionId);
      const dir = grillDir(ctx.cwd);
      let file: string;
      if (args.trim()) {
        file = path.resolve(ctx.cwd, args.trim());
      } else {
        file = state?.reportPath && fs.existsSync(state.reportPath)
          ? state.reportPath
          : path.join(dir, "report.md");
      }
      if (!fs.existsSync(file)) {
        ctx.ui.notify(`[${PLUGIN}] 报告不存在: ${file}。请先运行 /grilling。`, "error");
        return;
      }
      const content = await fs.promises.readFile(file, "utf8");
      pi.sendMessage(
        {
          customType: "grill-context",
          content: `[grill-me 历史拷问报告] 以下是此前拷问的记录（问题清单 + 选择 + 回答），作为本次工作的背景约束与待办参考：\n\n${truncate(content, 40_000)}`,
          display: true,
          details: { source: file },
        },
        { deliverAs: "nextTurn" },
      );
      ctx.ui.notify(`[${PLUGIN}] 报告已注入会话上下文（${file}），下一条消息将携带它。`, "info");
    },
  });

  /* ---------------- 命令：/grill-log ---------------- */

  pi.registerCommand("grill-log", {
    description: "查看 grill-storm 当前状态（运行 ID、问题数、作答进度、报告路径）",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId() ?? "default";
      const state = sessions.get(sessionId);
      if (!state || (state.phase === "context" && state.questions.length === 0 && !state.runId)) {
        ctx.ui.notify(`[${PLUGIN}] 本会话还没有拷问记录。运行 /grilling 开始。`, "info");
        return;
      }
      const progress = state.questions.length > 0
        ? `${state.answers.size}/${state.questions.length}`
        : "—";
      ctx.ui.notify(
        `[${PLUGIN}] runId=${state.runId}  phase=${state.phase}  问题=${progress}  followUps=${state.followUpsSent}${state.error ? `  error=${state.error}` : ""}${state.reportPath ? `  report=${state.reportPath}` : ""}`,
        "info",
      );
    },
  });

  /* ---------------- 渲染器 ---------------- */

  pi.registerMessageRenderer("grill-questions", (message, { expanded }, theme) => {
    const details = message.details as { count?: number } | undefined;
    const box = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
    box.addChild(new Text(theme.bold(`🔥 grill-me 拷问回合 — ${details?.count ?? "?"} 个问题，请逐题选择并作答`)));
    if (expanded && typeof message.content === "string") {
      box.addChild(new Text(theme.fg("dim", message.content)));
    }
    return box;
  });

  pi.registerMessageRenderer("grill-followup", (message, _opts, theme) => {
    const box = new Box(1, 1, (text) => theme.bg("toolErrorBg", text));
    box.addChild(new Text(theme.fg("warning", "⚠ 补催：还有问题未作答")));
    if (typeof message.content === "string") {
      box.addChild(new Text(theme.fg("dim", message.content)));
    }
    return box;
  });

  pi.registerMessageRenderer("grill-context", (message, { expanded }, theme) => {
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", "📎 grill-me 历史拷问报告（已注入上下文）")));
    if (expanded && typeof message.content === "string") {
      box.addChild(new Text(theme.fg("dim", message.content.slice(0, 2_000))));
    }
    return box;
  });

  pi.registerEntryRenderer("grill-storm", (entry, { expanded }, theme) => {
    const data = entry.data as { topic?: string; phase?: string; runId?: string; reportPath?: string; questions?: GrilledQuestion[]; answers?: Record<string, AnswerRecord> } | undefined;
    const answered = data?.answers ? Object.keys(data.answers).length : 0;
    const total = data?.questions?.length ?? 0;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", `🍳 grill-storm: ${data?.topic ?? "（无主题）"} [${data?.phase ?? "?"}] ${total > 0 ? `${answered}/${total} 已回答` : ""}`)));
    if (expanded && data?.reportPath) {
      box.addChild(new Text(theme.fg("dim", `report: ${data.reportPath}  runId: ${data.runId ?? ""}`)));
    }
    return box;
  });

  console.log(`[${PLUGIN}] 已加载。使用 /grilling [主题或文件...] 启动拷问，/grill-load 注入上次报告。`);
}

// 仅为测试导出的纯函数（不影响插件加载）
export { extractQuestionsFromText, renderQuestions, buildReport };