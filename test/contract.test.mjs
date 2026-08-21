import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as grill from "../extensions/index.ts";

const scope = "ClickHouse sink optimization";
const quotedEvidence = '"ClickHouse sink optimization uses batch inserts and async_insert."';

function question(overrides = {}) {
  return {
    id: "Q-1",
    question: "Which batching policy should the ClickHouse sink use?",
    why: quotedEvidence,
    scopeLink: `${scope}: batch inserts and checkpoint ordering determine sink throughput and retry safety.`,
    decisionAxis: "ClickHouse sink batch flush policy",
    severity: "critical",
    options: [
      { id: "A", axisValue: "fixed-size", label: "Fixed-size batches", consequence: "Predictable memory use but may add latency at low traffic." },
      { id: "B", axisValue: "adaptive-time-size", label: "Time-and-size adaptive batches", consequence: "Higher throughput but requires explicit latency bounds." },
    ],
    allowOther: true,
    otherRationale: quotedEvidence,
    ...overrides,
  };
}

function answer(overrides = {}) {
  return {
    questionId: "Q-1",
    selectedOptionId: "A",
    reason: "Fixed batches keep checkpoint memory bounded while the current sink has no latency SLO.",
    ...overrides,
  };
}

function waitForTurn() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function testAskContract() {
  const parsed = grill.extractAskFromText(JSON.stringify({ questions: [question()], done: false }));
  assert.ok(parsed?.question, "a valid 2-choice question should parse");
  assert.deepEqual(parsed.question.options.map((option) => option.id), ["A", "B"]);
  assert.equal(parsed.question.allowOther, true);

  const fiveChoices = ["A", "B", "C", "D", "E"].map((id) => ({ id, axisValue: `policy-${id}`, label: `Choice ${id}`, consequence: `Trade-off ${id}` }));
  assert.equal(
    grill.extractAskFromText(JSON.stringify({ questions: [question({ options: fiveChoices })], done: false }))?.question?.options.length,
    5,
    "five normal options should parse",
  );
  assert.equal(
    grill.extractAskFromText(JSON.stringify({ questions: [question({ options: [question().options[0]] })], done: false })),
    null,
    "one normal option must be rejected",
  );
  assert.equal(
    grill.extractAskFromText(JSON.stringify({
      questions: [question({
        options: ["A", "B", "C", "D", "E", "F"].map((id) => ({ id, axisValue: id, label: id, consequence: `trade-off-${id}` })),
      })],
      done: false,
    })),
    null,
    "more than five normal options must be rejected",
  );
  assert.equal(
    grill.extractAskFromText(JSON.stringify({
      questions: [question({
        options: [
          { id: "A", axisValue: "one", label: "One", consequence: "Trade-off one" },
          { id: "C", axisValue: "three", label: "Three", consequence: "Trade-off three" },
        ],
      })],
      done: false,
    })),
    null,
    "option IDs must be consecutive",
  );
  assert.equal(
    grill.extractAskFromText(JSON.stringify({
      questions: [question({
        options: [
          { id: "A", axisValue: "same", label: "Same", consequence: "Same consequence" },
          { id: "B", axisValue: "different", label: " same ", consequence: "Different consequence" },
        ],
      })],
      done: false,
    })),
    null,
    "obviously duplicate normal choices must be rejected",
  );
  assert.equal(
    grill.extractAskFromText(JSON.stringify({
      questions: [question({
        options: [
          { id: "A", axisValue: "async-insert", label: "Enable async_insert", consequence: "Server buffers writes." },
          { id: "B", axisValue: "async-insert-with-flush", label: "Enable async_insert with flush", consequence: "Server buffers writes with a flush timer." },
        ],
      })],
      done: false,
    })),
    null,
    "axis values that contain another option must be rejected as non-exclusive",
  );
  assert.equal(
    grill.extractAskFromText(JSON.stringify({
      questions: [question({
        options: [
          { id: "A", axisValue: "on", label: "Enable async_insert", consequence: "Server buffers writes." },
          { id: "B", axisValue: "ten-seconds", label: "Enable async_insert with a 10 second flush", consequence: "Server buffers writes with a timed flush." },
        ],
      })],
      done: false,
    })),
    null,
    "labels that turn one choice into an additive version of another must be rejected",
  );
  const missingSeverity = question();
  delete missingSeverity.severity;
  assert.equal(
    grill.extractAskFromText(JSON.stringify({ questions: [missingSeverity], done: false })),
    null,
    "severity is required so a critical gap cannot evade the gate",
  );
  assert.equal(
    grill.extractAskFromText(JSON.stringify({ questions: [question({ allowOther: true, otherRationale: undefined })], done: false })),
    null,
    "OTHER must explain the evidence-backed coverage gap",
  );
  assert.equal(
    grill.extractAskFromText(JSON.stringify({ questions: [], done: false })),
    null,
    "an empty question list must explicitly finish the review",
  );
}

function testSelectionContract() {
  const q = question();
  assert.deepEqual(grill.validateAnswerSelection(q, answer()), { valid: true, reason: "" });
  assert.deepEqual(
    grill.validateAnswerSelection(q, answer({ selectedOptionId: "OTHER", otherAnswer: "Use server-side async_insert with a bounded flush timer." })),
    { valid: true, reason: "" },
  );
  assert.equal(grill.validateAnswerSelection(q, answer({ selectedOptionId: "OTHER" })).valid, false);
  assert.equal(grill.validateAnswerSelection(question({ allowOther: false }), answer({ selectedOptionId: "OTHER", otherAnswer: "Alternative" })).valid, false);
  assert.equal(grill.validateAnswerSelection(q, answer({ selectedOptionId: "E" })).valid, false);
  assert.equal(grill.validateAnswerSelection(q, answer({ otherAnswer: "Not allowed with A" })).valid, false);

  assert.equal(grill.computeGate([{ id: "Q-1", severity: "critical", selectedOptionId: "A", reason: "Evidence", selectionValid: true, closed: true }]).gate, "ok");
  assert.equal(grill.computeGate([{ id: "Q-1", severity: "critical", selectedOptionId: "OTHER", reason: "Evidence", selectionValid: false, closed: false }]).gate, "blocked");
  assert.equal(grill.computeGate([{ id: "Q-1", severity: "critical", reason: "", skipped: true, closed: false }]).gate, "blocked");
}

function testScopeArguments() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grill-contract-"));
  const source = path.join(temp, "clickhouse.ts");
  fs.writeFileSync(source, "ClickHouse sink optimization uses batch inserts and async_insert.\n", "utf8");
  try {
    const explicit = grill.parseGrillArgs('--topic "ClickHouse sink optimization" --source clickhouse.ts -i high');
    assert.ok(explicit);
    const resolved = grill.resolveGrillInput(temp, explicit);
    assert.ok(!("error" in resolved), "explicit topic and source should resolve");
    assert.equal(resolved.topic, scope);
    assert.deepEqual(resolved.filePaths, [source]);
    assert.equal(resolved.includeRecent, false);

    const topicOnly = grill.parseGrillArgs('"ClickHouse sink optimization"');
    assert.ok(topicOnly);
    const missingSource = grill.resolveGrillInput(temp, topicOnly);
    assert.ok("error" in missingSource, "a topic alone must not silently use recent chat");

    const explicitRecent = grill.parseGrillArgs('"ClickHouse sink optimization" --recent');
    assert.ok(explicitRecent?.includeRecent, "recent context must be opt-in");
    assert.equal(grill.parseGrillArgs('--topic "unterminated --recent'), undefined, "unterminated quoted scope must be rejected");
    assert.equal(grill.parseGrillArgs('--topic "" --recent'), undefined, "empty quoted scope must be rejected rather than consuming the next flag");
    assert.equal(grill.canonicalQuestionId(0), "Q-1");
    assert.equal(grill.canonicalQuestionId(1), "Q-2");
    assert.equal(grill.decideResume({ phase: "spawned", answeredAll: false, hasReport: false, round: 0 }).action, "resume-ask");
    assert.equal(grill.decideResume({ phase: "retrying", retryKind: "ask", answeredAll: false, hasReport: false, round: 0 }).action, "resume-ask");
    assert.equal(grill.decideResume({ phase: "retrying", retryKind: "judge", answeredAll: true, hasReport: false, round: 1 }).action, "judge");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function testEvidenceAndSnapshotGuards() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grill-evidence-"));
  const evidencePath = path.join(temp, "evidence.md");
  const contextPath = path.join(temp, "context.md");
  const sourceBody = "ClickHouse sink optimization uses batch inserts and async_insert. The write path must preserve checkpoint ordering.";
  fs.writeFileSync(evidencePath, sourceBody, "utf8");
  fs.writeFileSync(contextPath, `# Generated context\n必须评审范围: ${scope}\n\n${sourceBody}`, "utf8");
  try {
    const state = { topic: scope, intensity: "medium", evidencePath };
    const templateOnly = question({
      why: `"必须评审范围: ${scope}"`,
      scopeLink: `${scope}: this pretends to be in scope.`,
    });
    assert.match(
      await grill.questionValidationError(state, templateOnly),
      /允许材料正文/,
      "generated scope headers must not qualify as evidence",
    );
    assert.equal(await grill.questionValidationError(state, question()), undefined, "a real source quote should validate");
    assert.match(
      await grill.questionValidationError(state, question({ otherRationale: '"The options might not cover everything in the future."' })),
      /otherRationale/,
      "OTHER must have a material-backed coverage rationale",
    );
    const unrelatedQuestion = question({
      question: "Should we hire three additional engineers?",
      decisionAxis: "engineering headcount",
      scopeLink: `${scope}: batch inserts and checkpoint ordering determine sink throughput and retry safety.`,
    });
    assert.match(
      await grill.questionValidationError(state, unrelatedQuestion),
      /问题正文|decisionAxis/,
      "a valid quote plus self-declared scopeLink must not validate a scope-external question",
    );
    const priorQuestion = { ...question(), round: 1 };
    const priorAnswer = answer();
    const followUp = question({
      id: "Q-2",
      question: "How will the chosen fixed batches preserve checkpoint ordering under retries?",
      why: `"${priorAnswer.reason}"`,
      scopeLink: `${scope}: retry behavior determines whether the selected batching policy is safe.`,
    });
    assert.equal(
      await grill.questionValidationError({ ...state, questions: [priorQuestion], answers: new Map([["Q-1", priorAnswer]]) }, followUp),
      undefined,
      "a follow-up may quote a real prior selection reason without treating the generated context header as evidence",
    );

    const now = Date.now();
    const q1 = { ...question(), round: 1 };
    const validSnapshot = {
      topic: scope,
      sourceLabels: ["file: clickhouse.ts"],
      contextPath,
      evidencePath,
      round: 0,
      phase: "answering",
      questions: [q1],
      answers: new Map(),
      verdicts: new Map(),
      createdAt: now,
    };
    assert.equal(grill.validateAndNormalizeV2Snapshot(validSnapshot), undefined, "well-formed active v2 snapshot should restore");

    const q2WithDuplicateId = { ...question(), id: "Q-1", round: 2 };
    const duplicateSnapshot = {
      ...validSnapshot,
      round: 2,
      phase: "judging",
      questions: [q1, q2WithDuplicateId],
      answers: new Map([["Q-1", answer()]]),
    };
    assert.match(
      grill.validateAndNormalizeV2Snapshot(duplicateSnapshot),
      /第 2 题/,
      "duplicate or out-of-order question IDs must reject recovery",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function testReport() {
  const now = Date.now();
  const q = { ...question(), round: 1 };
  const state = {
    contractVersion: 2,
    topic: scope,
    sourceLabels: ["file: clickhouse.ts"],
    runId: "report-test",
    cwd: process.cwd(),
    sessionId: "session-test",
    round: 1,
    maxRounds: 1,
    intensity: "medium",
    contextPath: "/tmp/clickhouse.ts",
    contextBytes: 123,
    questions: [q],
    answers: new Map([[q.id, answer()]]),
    verdicts: new Map([[q.id, { id: q.id, selectionValid: true, closed: true, judgment: "A is selected with a checkpoint memory bound." }]]),
    askAsyncDirs: [],
    phase: "done",
    followUpsSent: 0,
    askRetries: 0,
    judgeRetries: 0,
    prevActiveTools: [],
    createdAt: now,
    startedAt: now,
    updatedAt: now,
  };
  const report = await grill.buildReport(state, process.cwd());
  const json = report.json;
  assert.equal(json.meta.contractVersion, 2);
  assert.equal(json.meta.gate, "ok");
  assert.equal(json.questions[0].selectedOptionId, "A");
  assert.equal(json.questions[0].options.length, 2);
  assert.match(report.markdown, /\*\*已选\*\*: A\. Fixed-size batches/);
  assert.match(report.markdown, /\*\*决策轴\*\*: ClickHouse sink batch flush policy/);
  assert.match(report.markdown, /\[fixed-size\] Fixed-size batches/);
  assert.match(report.markdown, /\*\*范围关系\*\*/);

  const noVerdictReport = await grill.buildReport({ ...state, verdicts: new Map() }, process.cwd());
  assert.equal(noVerdictReport.json.meta.gate, "blocked", "critical questions must not pass gate without a valid terminal verdict");
  assert.equal(noVerdictReport.json.questions[0].closed, false);
}

async function testExtensionFlow() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grill-flow-"));
  const source = path.join(temp, "clickhouse.ts");
  fs.writeFileSync(source, "ClickHouse sink optimization uses batch inserts and async_insert. The write path must preserve checkpoint ordering.\n", "utf8");

  const lifecycle = new Map();
  const commands = new Map();
  const tools = new Map();
  const eventListeners = new Map();
  const sent = [];
  const notifications = [];
  let activeTools = [];
  let spawnCount = 0;
  let askRunCount = 0;

  function emit(name, payload) {
    if (name === "subagents:rpc:v1:request") {
      spawnCount += 1;
      const isAsk = Boolean(payload.params.output);
      const asyncId = isAsk ? `ask-run-${++askRunCount}` : "judge-run";
      const asyncDir = path.join(temp, asyncId);
      if (isAsk) {
        fs.mkdirSync(path.dirname(payload.params.output), { recursive: true });
        fs.writeFileSync(payload.params.output, JSON.stringify({ questions: [question()], done: false }), "utf8");
      } else {
        fs.mkdirSync(path.join(asyncDir, "structured-output", "result"), { recursive: true });
        fs.writeFileSync(
          path.join(asyncDir, "structured-output", "result", "output.json"),
          JSON.stringify({
            verdicts: ["Q-1", "Q-2"].map((id) => ({ id, selectionValid: true, closed: true, judgment: "A is backed by bounded checkpoint memory." })), 
            summary: "The range-specific batching decision is closed.",
          }),
          "utf8",
        );
      }
      queueMicrotask(() => emit(`subagents:rpc:v1:reply:${payload.requestId}`, {
        success: true,
        data: { details: { asyncId, asyncDir } },
      }));
      return;
    }
    for (const listener of eventListeners.get(name) ?? []) listener(payload);
  }

  const pi = {
    on(name, handler) { lifecycle.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    getActiveTools() { return activeTools; },
    setActiveTools(next) { activeTools = next; },
    appendEntry() {},
    sendMessage(message, options) { sent.push({ message, options }); },
    events: {
      on(name, handler) {
        const listeners = eventListeners.get(name) ?? new Set();
        listeners.add(handler);
        eventListeners.set(name, listeners);
        return () => listeners.delete(handler);
      },
      emit,
    },
  };
  const ctx = {
    cwd: temp,
    ui: { notify(message, level) { notifications.push({ message, level }); } },
    sessionManager: {
      getSessionId: () => "session-flow",
      getEntries: () => [],
      buildContextEntries: () => [{ type: "message", message: { role: "assistant", content: "UNRELATED_DELIVERY_STATUS should not be collected without --recent." } }],
    },
  };

  const previousMaxRounds = process.env.GRILL_MAX_ROUNDS;
  process.env.GRILL_MAX_ROUNDS = "2";
  try {
    grill.default(pi);
    await lifecycle.get("session_start")({}, ctx);
    await commands.get("grilling").handler('--topic "ClickHouse sink optimization" --source clickhouse.ts', ctx);
    await waitForTurn();
    assert.equal(spawnCount, 1);

    const contextFile = fs.readdirSync(path.join(temp, ".pi", "grill")).find((file) => file.startsWith("context-"));
    const context = fs.readFileSync(path.join(temp, ".pi", "grill", contextFile), "utf8");
    assert.match(context, /必须评审范围: ClickHouse sink optimization/);
    assert.doesNotMatch(context, /UNRELATED_DELIVERY_STATUS/);

    // Simulate async-complete and the polling fallback both consuming the same artifact.
    emit("subagent:async-complete", { id: "ask-run-1", success: true });
    emit("subagent:async-complete", { id: "ask-run-1", success: true });
    await waitForTurn();
    const questionMessage = sent.find(({ message }) => message.customType === "grill-question");
    assert.ok(questionMessage, "the valid choice question should be delivered");
    assert.match(questionMessage.message.content, /A\. \[fixed-size\] Fixed-size batches/);
    assert.match(questionMessage.message.content, /OTHER\. 其他/);

    const tool = tools.get("grill_answer");
    const missingOther = await tool.execute("call-other-missing", { questionId: "Q-1", selectedOptionId: "OTHER", reason: "Need a custom policy." }, undefined, undefined, ctx);
    assert.match(missingOther.content[0].text, /必须填写 otherAnswer/);
    const historical = await tool.execute("call-1", { questionId: "Q-0", selectedOptionId: "A", reason: "No" }, undefined, undefined, ctx);
    assert.match(historical.content[0].text, /只能回答当前待答问题/);
    const valid = await tool.execute("call-2", { questionId: "Q-1", selectedOptionId: "A", reason: "It bounds checkpoint memory." }, undefined, undefined, ctx);
    assert.match(valid.content[0].text, /\[A\]/);

    await lifecycle.get("agent_settled")({}, ctx);
    await waitForTurn();
    assert.equal(spawnCount, 2, "answering round one should spawn a second question");
    // The mock intentionally emits Q-1 again; the orchestrator must canonicalize it to Q-2.
    emit("subagent:async-complete", { id: "ask-run-2", success: true });
    emit("subagent:async-complete", { id: "ask-run-2", success: true });
    await waitForTurn();
    const questionMessages = sent.filter(({ message }) => message.customType === "grill-question");
    assert.equal(questionMessages.at(-1).message.details.questionId, "Q-2", "duplicate child IDs must not overwrite the first question");
    const oldQuestion = await tool.execute("call-3", { questionId: "Q-1", selectedOptionId: "A", reason: "Cannot overwrite the prior choice." }, undefined, undefined, ctx);
    assert.match(oldQuestion.content[0].text, /只能回答当前待答问题 Q-2/);
    const validSecond = await tool.execute("call-4", {
      questionId: "Q-2",
      selectedOptionId: "OTHER",
      reason: "Neither fixed nor adaptive client batches preserve the required server-side deduplication behavior.",
      otherAnswer: "Use server-side async_insert with a bounded flush timer and checkpoint-aware idempotency keys.",
    }, undefined, undefined, ctx);
    assert.match(validSecond.content[0].text, /\[OTHER\]/);

    await lifecycle.get("agent_settled")({}, ctx);
    await waitForTurn();
    assert.equal(spawnCount, 3, "answering round two should spawn terminal judgment");
    emit("subagent:async-complete", { id: "judge-run", success: true });
    emit("subagent:async-complete", { id: "judge-run", success: true });
    await waitForTurn();

    const completions = sent.filter(({ message }) => message.customType === "grill-complete");
    assert.equal(completions.length, 1, "duplicate completion signals must produce one delivery");
    const completion = completions[0];
    assert.ok(completion, "completion should be delivered");
    assert.match(completion.message.content, /有效选择 2/);
    assert.match(completion.message.content, /OTHER 1/);
    assert.equal(completion.message.details.gate, "ok");
    const report = fs.readdirSync(path.join(temp, ".pi", "grill")).find((file) => file.startsWith("report-") && file.endsWith(".json"));
    const json = JSON.parse(fs.readFileSync(path.join(temp, ".pi", "grill", report), "utf8"));
    assert.equal(json.meta.contractVersion, 2);
    assert.deepEqual(json.questions.map((item) => item.id), ["Q-1", "Q-2"]);
    assert.deepEqual(json.questions.map((item) => item.selectedOptionId), ["A", "OTHER"]);
    assert.match(json.questions[1].otherAnswer, /server-side async_insert/);
    assert.equal(json.questions[0].options.length, 2);
    const usageLines = fs.readFileSync(path.join(temp, ".pi", "grill", "usage.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    assert.equal(usageLines.length, 1, "duplicate completion signals must append one usage record");
  } finally {
    if (previousMaxRounds === undefined) delete process.env.GRILL_MAX_ROUNDS;
    else process.env.GRILL_MAX_ROUNDS = previousMaxRounds;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

await testReport();
testAskContract();
testSelectionContract();
testScopeArguments();
await testEvidenceAndSnapshotGuards();
await testExtensionFlow();
console.log("PASS: range-controlled choice contract");
