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

function discovery(overrides = {}) {
  return {
    topic: scope,
    summary: "The ClickHouse sink implementation and the current plan provide enough evidence to interrogate batching and checkpoint ordering.",
    sources: [
      {
        kind: "file",
        ref: "clickhouse.ts",
        startLine: 1,
        endLine: 2,
        reason: "The sink file names batch inserts, async_insert, and checkpoint ordering directly in the current implementation path.",
      },
    ],
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
    assert.deepEqual(resolved.filePaths, [fs.realpathSync(source)]);
    assert.equal(resolved.includeRecent, false);
    assert.equal(grill.resolveDiscoveryFile(temp, "clickhouse.ts"), fs.realpathSync(source), "a regular workspace file is selectable");
    const environmentFile = path.join(temp, ".env.production");
    fs.writeFileSync(environmentFile, "TOKEN=do-not-collect\n", "utf8");
    assert.equal(grill.resolveDiscoveryFile(temp, ".env.production"), undefined, "environment files must never become automatic evidence");
    const outside = path.join(os.tmpdir(), `grill-outside-${Date.now()}.txt`);
    const escapeLink = path.join(temp, "evidence-link");
    fs.writeFileSync(outside, "outside secret", "utf8");
    fs.symlinkSync(outside, escapeLink);
    assert.equal(grill.resolveDiscoveryFile(temp, "evidence-link"), undefined, "workspace symlinks must not escape the repository");
    fs.rmSync(outside, { force: true });

    const topicOnly = grill.parseGrillArgs('"ClickHouse sink optimization"');
    assert.ok(topicOnly);
    const automatic = grill.resolveGrillInput(temp, topicOnly);
    assert.ok(!("error" in automatic), "a topic alone should start automatic context collection");
    assert.equal(automatic.topic, scope);
    assert.deepEqual(automatic.filePaths, []);

    const noArgs = grill.parseGrillArgs("");
    assert.ok(noArgs);
    const inferred = grill.resolveGrillInput(temp, noArgs);
    assert.ok(!("error" in inferred), "no arguments should allow the context scout to infer the current topic");
    assert.equal(inferred.topic, undefined);

    const explicitRecent = grill.parseGrillArgs('"ClickHouse sink optimization" --recent');
    assert.ok(explicitRecent?.includeRecent, "legacy --recent remains accepted as a compatibility hint");
    assert.equal(grill.parseGrillArgs('--topic "unterminated --recent'), undefined, "unterminated quoted scope must be rejected");
    assert.equal(grill.parseGrillArgs('--topic "" --recent'), undefined, "empty quoted scope must be rejected rather than consuming the next flag");
    assert.equal(grill.canonicalQuestionId(0), "Q-1");
    assert.equal(grill.canonicalQuestionId(1), "Q-2");
    assert.equal(grill.decideResume({ phase: "discovering", answeredAll: false, hasReport: false, round: 0 }).action, "resume-discovery");
    assert.equal(grill.decideResume({ phase: "retrying", retryKind: "discovery", answeredAll: false, hasReport: false, round: 0 }).action, "resume-discovery");
    assert.equal(grill.decideResume({ phase: "spawned", answeredAll: false, hasReport: false, round: 0 }).action, "resume-ask");
    assert.equal(grill.decideResume({ phase: "retrying", retryKind: "ask", answeredAll: false, hasReport: false, round: 0 }).action, "resume-ask");
    assert.equal(grill.decideResume({ phase: "retrying", retryKind: "judge", answeredAll: true, hasReport: false, round: 1 }).action, "judge");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testDiscoveryContract() {
  const valid = grill.extractContextDiscoveryFromText(JSON.stringify(discovery()));
  assert.ok(valid, "a bounded file source with a verified line range should parse");
  assert.equal(valid.sources[0].startLine, 1);
  assert.equal(valid.sources[0].endLine, 2);
  assert.equal(
    grill.extractContextDiscoveryFromText(JSON.stringify(discovery({ sources: [{ kind: "file", ref: "clickhouse.ts", reason: "Missing line range." }] }))),
    null,
    "file sources must identify the inspected evidence range",
  );
  assert.equal(
    grill.extractContextDiscoveryFromText(JSON.stringify(discovery({ sources: [{ kind: "session", ref: "S1", startLine: 1, endLine: 2, reason: "A session cannot claim file lines." }] }))),
    null,
    "session sources must not smuggle file line ranges",
  );
  assert.equal(
    grill.extractContextDiscoveryFromText(JSON.stringify(discovery({ sources: [{ kind: "file", ref: "clickhouse.ts", startLine: 1, endLine: 501, reason: "Range is too broad." }] }))),
    null,
    "file evidence ranges must remain bounded",
  );
}

async function testAutomaticCollectionGuards() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grill-automatic-context-"));
  const runId = "22222222-2222-4222-8222-222222222222";
  const grillDir = path.join(temp, ".pi", "grill");
  const source = path.join(temp, "clickhouse.ts");
  fs.mkdirSync(grillDir, { recursive: true });
  fs.writeFileSync(source, [
    "ClickHouse sink optimization uses batch inserts and async_insert.",
    "Checkpoint ordering defines retry safety for the sink.",
  ].join("\n"), "utf8");
  const intake = path.join(grillDir, `intake-${runId}.json`);
  fs.writeFileSync(intake, JSON.stringify({ candidates: [{ id: "S1", role: "用户", text: "Unrelated delivery status must stay out of evidence." }] }), "utf8");
  const state = { runId, cwd: temp, topicHint: scope, discoverySeedPath: intake, discoverySourceHints: [] };
  try {
    const collected = await grill.collectDiscoveredContext(temp, state, discovery({
      sources: [{
        kind: "file",
        ref: "clickhouse.ts",
        startLine: 1,
        endLine: 2,
        reason: "Batch inserts and checkpoint ordering directly constrain the ClickHouse sink behavior.",
      }],
    }));
    const manifest = JSON.parse(fs.readFileSync(collected.manifestPath, "utf8"));
    assert.equal(manifest.sources[0].ref, "clickhouse.ts");
    assert.equal(manifest.sources[0].startLine, 1);
    assert.equal(manifest.sources[0].endLine, 2);
    assert.doesNotMatch(fs.readFileSync(collected.evidencePath, "utf8"), /Unrelated delivery status/);

    const oversizedSource = path.join(temp, "oversized-clickhouse.ts");
    fs.writeFileSync(oversizedSource, `${fs.readFileSync(source, "utf8")}\n${"x".repeat(60_001)}`, "utf8");
    await assert.rejects(
      grill.collectDiscoveredContext(temp, { ...state, runId: "55555555-5555-4555-8555-555555555555" }, discovery({
        sources: [{
          kind: "file",
          ref: "oversized-clickhouse.ts",
          startLine: 1,
          endLine: 3,
          reason: "Batch inserts and checkpoint ordering directly constrain the ClickHouse sink behavior.",
        }],
      })),
      /片段过大/,
      "oversized line ranges must be rejected instead of silently truncating the declared evidence",
    );

    const otherSource = path.join(temp, "other-clickhouse.ts");
    fs.writeFileSync(otherSource, fs.readFileSync(source, "utf8"), "utf8");
    await assert.rejects(
      grill.collectDiscoveredContext(temp, { ...state, runId: "33333333-3333-4333-8333-333333333333", discoverySourceHints: [source] }, discovery({
        sources: [{
          kind: "file",
          ref: "other-clickhouse.ts",
          startLine: 1,
          endLine: 2,
          reason: "Batch inserts and checkpoint ordering directly constrain the ClickHouse sink behavior.",
        }],
      })),
      /没有读取并标注指定材料的行范围/,
      "legacy --source hints must be selected with bounded provenance rather than silently copied whole",
    );

    const statusFile = path.join(temp, "delivery-status.md");
    fs.writeFileSync(statusFile, "ClickHouse sink release approval is delayed until the deployment checklist is signed.\n", "utf8");
    await assert.rejects(
      grill.collectDiscoveredContext(temp, { ...state, runId: "33333333-3333-4333-8333-333333333333", discoverySeedPath: intake }, discovery({
        sources: [{
          kind: "file",
          ref: "delivery-status.md",
          startLine: 1,
          endLine: 1,
          reason: "ClickHouse sink release approval is delayed until deployment is signed.",
        }],
      })),
      /材料机制/,
      "a delivery-status source sharing only product anchors cannot become automatic evidence",
    );
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
    const noScopeAnchorEvidencePath = path.join(temp, "unrelated-evidence.md");
    fs.writeFileSync(noScopeAnchorEvidencePath, "The worker pool has a retry queue and a bounded lease timeout.", "utf8");
    assert.match(
      await grill.questionValidationError({ ...state, evidencePath: noScopeAnchorEvidencePath }, question({
        why: '"The worker pool has a retry queue and a bounded lease timeout."',
        question: "Which worker pool retry policy should we use?",
        decisionAxis: "worker pool retry policy",
        scopeLink: `${scope}: worker retries influence delivery latency.`,
      })),
      /硬性范围锚点/,
      "a source that never names the hard topic cannot be accepted merely because scopeLink asserts it",
    );
    const deliveryStatusEvidencePath = path.join(temp, "delivery-status.md");
    fs.writeFileSync(deliveryStatusEvidencePath, "ClickHouse sink release approval is delayed until the deployment checklist is signed.", "utf8");
    assert.match(
      await grill.questionValidationError({ ...state, evidencePath: deliveryStatusEvidencePath }, question({
        why: '"ClickHouse sink release approval is delayed until the deployment checklist is signed."',
        question: "Which ClickHouse sink deployment approval policy should the release use?",
        decisionAxis: "ClickHouse sink deployment approval policy",
        scopeLink: `${scope}: deployment approval delays affect release timing.`,
      })),
      /交付、发布或审批状态维度/,
      "shared product-name delivery status must not pass as an optimization evidence bundle",
    );
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
    const discoverySeedPath = path.join(temp, "intake.json");
    fs.writeFileSync(discoverySeedPath, JSON.stringify({ candidates: [{ id: "S1", role: "用户", text: "Discuss ClickHouse batching." }] }), "utf8");
    assert.equal(
      grill.validateAndNormalizeV2Snapshot({
        topic: "",
        discoverySeedPath,
        round: 0,
        phase: "discovering",
        questions: [],
        answers: new Map(),
        verdicts: new Map(),
      }),
      undefined,
      "a discovery snapshot restores before the final evidence bundle exists",
    );
    assert.match(
      grill.validateAndNormalizeV2Snapshot({
        topic: "",
        discoverySeedPath: path.join(temp, "missing-intake.json"),
        round: 0,
        phase: "discovering",
        questions: [],
        answers: new Map(),
        verdicts: new Map(),
      }),
      /候选会话文件/,
      "discovery recovery refuses a missing candidate intake",
    );

    const managedRunId = "11111111-1111-4111-8111-111111111111";
    const managedDir = path.join(temp, ".pi", "grill");
    fs.mkdirSync(managedDir, { recursive: true });
    const managedIntake = path.join(managedDir, `intake-${managedRunId}.json`);
    fs.writeFileSync(managedIntake, JSON.stringify({ candidates: [{ id: "S1", role: "用户", text: "ClickHouse sink optimization." }] }), "utf8");
    const managedDiscoverySnapshot = {
      runId: managedRunId,
      sessionId: "current-session",
      cwd: temp,
      topic: "",
      discoverySeedPath: managedIntake,
      round: 0,
      phase: "discovering",
      questions: [],
      answers: new Map(),
      verdicts: new Map(),
    };
    assert.equal(
      grill.validateAndNormalizeSnapshot(managedDiscoverySnapshot, { cwd: temp, sessionId: "current-session" }),
      undefined,
      "an active discovery snapshot must restore only from the current session and managed workspace artifact",
    );
    assert.match(
      grill.validateAndNormalizeSnapshot({ ...managedDiscoverySnapshot, sessionId: "other-session" }, { cwd: temp, sessionId: "current-session" }),
      /当前 Pi 会话/,
      "recovery refuses a snapshot from another Pi session",
    );
    assert.match(
      grill.validateAndNormalizeSnapshot({ ...managedDiscoverySnapshot, cwd: os.tmpdir() }, { cwd: temp, sessionId: "current-session" }),
      /当前工作区/,
      "recovery refuses a snapshot from another repository",
    );
    assert.match(
      grill.validateAndNormalizeSnapshot({ ...managedDiscoverySnapshot, discoverySeedPath: path.join(temp, "outside-intake.json") }, { cwd: temp, sessionId: "current-session" }),
      /受管理目录/,
      "recovery refuses arbitrary artifact paths even inside the working tree",
    );

    const activeRunId = "44444444-4444-4444-8444-444444444444";
    const activeIntake = path.join(managedDir, `intake-${activeRunId}.json`);
    const activeManifest = path.join(managedDir, `manifest-${activeRunId}.json`);
    const activeContext = path.join(managedDir, `context-${activeRunId}.md`);
    const activeEvidence = path.join(managedDir, `evidence-${activeRunId}.md`);
    fs.writeFileSync(activeIntake, JSON.stringify({ candidates: [] }), "utf8");
    fs.writeFileSync(activeManifest, JSON.stringify({ sources: [] }), "utf8");
    fs.writeFileSync(activeContext, sourceBody, "utf8");
    fs.writeFileSync(activeEvidence, sourceBody, "utf8");
    const activeQ1 = { ...question(), round: 1 };
    const activeSnapshot = {
      runId: activeRunId,
      sessionId: "current-session",
      cwd: temp,
      topic: scope,
      topicHint: scope,
      sourceLabels: ["自动检索文件: clickhouse.ts:L1-L2"],
      discoverySeedPath: activeIntake,
      manifestPath: activeManifest,
      contextPath: activeContext,
      evidencePath: activeEvidence,
      round: 0,
      phase: "answering",
      questions: [activeQ1],
      answers: new Map(),
      verdicts: new Map(),
    };
    assert.equal(
      grill.validateAndNormalizeSnapshot(activeSnapshot, { cwd: temp, sessionId: "current-session" }),
      undefined,
      "an active automatic snapshot restores only with managed evidence and context paths",
    );
    assert.match(
      grill.validateAndNormalizeSnapshot({ ...activeSnapshot, contextPath: contextPath }, { cwd: temp, sessionId: "current-session" }),
      /受管理目录/,
      "recovery rejects a context artifact that is not named for the run",
    );
    const outsideManagedContext = path.join(temp, "outside-managed-context.md");
    fs.writeFileSync(outsideManagedContext, sourceBody, "utf8");
    fs.rmSync(activeContext);
    fs.symlinkSync(outsideManagedContext, activeContext);
    assert.match(
      grill.validateAndNormalizeSnapshot(activeSnapshot, { cwd: temp, sessionId: "current-session" }),
      /受管理目录/,
      "recovery rejects a run-named managed artifact symlink that targets outside .pi/grill",
    );

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
    assert.equal(grill.validateAndNormalizeV2Snapshot(validSnapshot), undefined, "well-formed legacy-shaped snapshot should normalize in the compatibility helper");

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
    contractVersion: 3,
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
  assert.equal(json.meta.contractVersion, 3);
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
  fs.writeFileSync(source, [
    "ClickHouse sink optimization uses batch inserts and async_insert.",
    "The write path must preserve checkpoint ordering.",
    "The current plan needs a bounded flush decision.",
  ].join("\n") + "\n", "utf8");

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
      const isDiscovery = payload.params.agent === "context-scout";
      const isAsk = payload.params.agent === "griller" && Boolean(payload.params.output);
      const asyncId = isDiscovery ? "context-run" : isAsk ? `ask-run-${++askRunCount}` : "judge-run";
      const asyncDir = path.join(temp, asyncId);
      if (isDiscovery) {
        fs.mkdirSync(path.dirname(payload.params.output), { recursive: true });
        fs.writeFileSync(payload.params.output, JSON.stringify(discovery()), "utf8");
      } else if (isAsk) {
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
      buildContextEntries: () => [
        { type: "message", message: { role: "user", content: "Please assess ClickHouse sink optimization, especially batching and checkpoint ordering." } },
        { type: "message", message: { role: "assistant", content: "UNRELATED_DELIVERY_STATUS should not be collected as a separate evidence source." } },
      ],
    },
  };

  const previousMaxRounds = process.env.GRILL_MAX_ROUNDS;
  process.env.GRILL_MAX_ROUNDS = "2";
  try {
    grill.default(pi);
    assert.ok(commands.has("grill-storm"), "the branded command must be registered");
    assert.equal(commands.has("grilling"), false, "the legacy /grilling command must not remain registered");
    assert.equal(commands.has("grill"), false, "the legacy /grill command must not remain registered");
    await lifecycle.get("session_start")({}, ctx);
    await commands.get("grill-storm").handler("", ctx);
    await waitForTurn();
    assert.equal(spawnCount, 1, "no-argument invocation should start automatic context discovery first");

    // The same discovery completion may arrive through async-complete and polling; the manifest must only be consumed once.
    emit("subagent:async-complete", { id: "context-run", success: true });
    emit("subagent:async-complete", { id: "context-run", success: true });
    await waitForTurn();
    assert.equal(spawnCount, 2, "one validated manifest should start exactly one first question");
    assert.equal(sent.filter(({ message }) => message.customType === "grill-context-ready").length, 1, "duplicate discovery completion must produce one manifest delivery");

    const grillArtifacts = path.join(temp, ".pi", "grill");
    const contextFile = fs.readdirSync(grillArtifacts).find((file) => /^context-[0-9a-f-]+\.md$/.test(file));
    const context = fs.readFileSync(path.join(grillArtifacts, contextFile), "utf8");
    assert.match(context, /必须评审范围: ClickHouse sink optimization/);
    assert.doesNotMatch(context, /UNRELATED_DELIVERY_STATUS/);
    const manifestFile = fs.readdirSync(grillArtifacts).find((file) => /^manifest-[0-9a-f-]+\.json$/.test(file));
    const manifest = JSON.parse(fs.readFileSync(path.join(grillArtifacts, manifestFile), "utf8"));
    assert.equal(manifest.mode, "automatic");
    assert.equal(manifest.sources.length, 1);
    assert.match(manifest.sources[0].label, /clickhouse\.ts:L1-L2/);

    // Simulate async-complete and the polling fallback both consuming the same question artifact.
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
    assert.equal(spawnCount, 3, "answering round one should spawn a second question");
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
    assert.equal(spawnCount, 4, "answering round two should spawn terminal judgment");
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
    assert.equal(json.meta.contractVersion, 3);
    assert.equal(json.meta.contextCollection.mode, "automatic");
    assert.match(json.meta.contextCollection.manifestPath, /manifest-/);
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
testDiscoveryContract();
await testAutomaticCollectionGuards();
await testEvidenceAndSnapshotGuards();
await testExtensionFlow();
console.log("PASS: range-controlled choice contract");
