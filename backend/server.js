"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const express = require("express");
const websocketStream = require("websocket-stream");

function createAedesInstance() {
  const mod = require("aedes");
  const candidates = [];
  if (typeof mod === "function") candidates.push(mod);
  if (mod && typeof mod.default === "function") candidates.push(mod.default);
  if (mod && typeof mod.Aedes === "function") candidates.push(mod.Aedes);

  for (const C of candidates) {
    try {
      const inst = C();
      if (inst && typeof inst.handle === "function") return inst;
    } catch (err) {}
    try {
      const inst = new C();
      if (inst && typeof inst.handle === "function") return inst;
    } catch (err) {}
  }
  throw new Error("Unsupported `aedes` export: cannot create broker instance");
}

const MQTT_TCP_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_TCP_HOST = process.env.MQTT_HOST || "0.0.0.0";

const HTTP_PORT = Number(process.env.PORT || 80);
const HTTP_HOST = process.env.HOST || "0.0.0.0";
const WS_PATH = process.env.MQTT_WS_PATH || "/mqtt";

const VOTING_MS_SINGLE = 10_000;
const VOTING_MS_MULTIPLE = 15_000;
const VOTING_MS_ORDERING = 20_000;
const SUBMIT_TIMEOUT_MS = 5_000;
const SNAPSHOT_PATH = path.join(__dirname, "runtime", "quiz-session-state.json");
const AUDIT_LOG_PATH = path.join(__dirname, "runtime", "quiz-audit.log");

const answerLabels = ["A", "B", "C", "D"];

const broker = createAedesInstance();
if (broker && typeof broker.listen === "function") {
  try {
    const maybePromise = broker.listen();
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch (err) {}
}

/** @type {Map<string, any>} */
const gamepads = new Map();

const quizStore = {
  version: null,
  categories: [],
  questions: [],
  quizzes: [],
};

const session = {
  activeQuizId: null,
  activeQuizName: null,
  questionIds: [],
  questionIndex: -1,
  identifyDisplayEnabled: true,
  stage: "idle", // idle,welcome,question,voting,collecting,review,reveal,stats,finished
  stageUpdatedAt: Date.now(),
  votingEndsAt: null,
  collectingEndsAt: null,
  currentRound: null,
  questionHistory: [],
  // Per-question shuffle maps: { [questionId]: { letterToOriginal, originalToLetter, displayAnswers, order } }
  questionShuffles: {},
};

let votingTimer = null;
let collectingTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function setStage(stage) {
  session.stage = stage;
  session.stageUpdatedAt = Date.now();
}

function ensureRuntimeDir() {
  const dir = path.dirname(SNAPSHOT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function clearTimers() {
  if (votingTimer) {
    clearTimeout(votingTimer);
    votingTimer = null;
  }
  if (collectingTimer) {
    clearTimeout(collectingTimer);
    collectingTimer = null;
  }
}

function normalizeAnswerType(v) {
  if (v === "single" || v === "multiple" || v === "ordering") return v;
  return "single";
}

function normalizeSelection(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const x = String(raw || "").toUpperCase();
    if (!answerLabels.includes(x)) continue;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

function votingDurationMsForAnswerType(answerType) {
  const type = normalizeAnswerType(answerType);
  if (type === "ordering") return VOTING_MS_ORDERING;
  if (type === "multiple") return VOTING_MS_MULTIPLE;
  return VOTING_MS_SINGLE;
}

function createAnswerShuffle(question) {
  if (!question) return null;
  const baseAnswers = Array.isArray(question.answers) ? question.answers : [];
  const n = baseAnswers.length;
  const indices = [];
  for (let i = 0; i < n; i++) indices.push(i);
  // Fisher-Yates
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
  }

  const displayAnswers = [];
  const letterToOriginal = {};
  const originalToLetter = {};
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const a = baseAnswers[idx] || {};
    const origId = String(a.id || "").toUpperCase();
    const letter = answerLabels[i] || String(i + 1);
    letterToOriginal[letter] = origId;
    originalToLetter[origId] = letter;
    displayAnswers.push({ id: letter, text: String(a.text || "") });
  }

  return { letterToOriginal, originalToLetter, displayAnswers, order: displayAnswers.map((x) => x.id) };
}

function ensureShuffleForQuestion(question) {
  if (!question || !question.id) return null;
  session.questionShuffles = session.questionShuffles || {};
  if (!session.questionShuffles[question.id]) {
    session.questionShuffles[question.id] = createAnswerShuffle(question);
  }
  return session.questionShuffles[question.id];
}

function isGamepadClientId(id) {
  return typeof id === "string" && (id.startsWith("g-") || id.startsWith("gamepad-"));
}

function nextGamepadNumber() {
  const used = new Set();
  for (const g of gamepads.values()) {
    const n = Number(g && g.gamepadNumber);
    if (Number.isInteger(n) && n > 0) used.add(n);
  }

  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

function ensureGamepad(id) {
  if (!isGamepadClientId(id)) return null;
  if (!gamepads.has(id)) {
    const gamepadNumber = nextGamepadNumber();
    gamepads.set(id, {
      id,
      gamepadNumber,
      name: `Tím ${gamepadNumber}`,
      connected: false,
      hiddenByAdmin: false,
      firstSeenAt: Date.now(),
      lastConnectAt: null,
      lastDisconnectAt: null,
      lastTelemetryAt: null,
      rssiDbm: null,
      batteryPct: null,
      points: 0,
      voted: false,
      submitted: false,
      lastSelection: [],
      lastResult: null,
      // per-round normalized response fractions (0..1)
      speedPercentages: [],
    });
  }
  const gp = gamepads.get(id);
  if (!Number.isInteger(Number(gp.gamepadNumber)) || Number(gp.gamepadNumber) < 1) {
    gp.gamepadNumber = nextGamepadNumber();
  }
  return gp;
}

function getQuestionById(id) {
  return quizStore.questions.find((q) => q.id === id) || null;
}

function computeQuizQuestionIds(quiz) {
  const categorySet = new Set(Array.isArray(quiz.selectedCategoryIds) ? quiz.selectedCategoryIds : []);
  const selectedQuestionIds = Array.isArray(quiz.selectedQuestionIds) ? quiz.selectedQuestionIds : [];
  const orderedQuestionIds = Array.isArray(quiz.orderedQuestionIds) ? quiz.orderedQuestionIds : [];
  const existingQuestionIds = new Set(quizStore.questions.map((q) => q.id));
  const poolSet = new Set();

  for (const id of selectedQuestionIds) {
    if (existingQuestionIds.has(id)) poolSet.add(id);
  }
  for (const q of quizStore.questions) {
    if (categorySet.has(q.categoryId) && existingQuestionIds.has(q.id)) {
      poolSet.add(q.id);
    }
  }

  const ids = [];
  const seen = new Set();

  // Keep explicit quiz order across full selected pool (categories + individual picks).
  for (const id of orderedQuestionIds) {
    if (!poolSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  // Then append any remaining individually selected questions.
  for (const id of selectedQuestionIds) {
    if (!poolSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  // Finally append remaining category-picked questions in repository order.
  for (const q of quizStore.questions) {
    if (!poolSet.has(q.id) || seen.has(q.id)) continue;
    seen.add(q.id);
    ids.push(q.id);
  }

  return ids;
}

function getCurrentQuestion() {
  const id = session.questionIds[session.questionIndex];
  if (!id) return null;
  return getQuestionById(id);
}

function getQuestionCorrectSelection(question) {
  const type = normalizeAnswerType(question.answerType);
  if (type === "ordering") {
    return normalizeSelection(question.ordering || []);
  }
  const out = [];
  for (const a of Array.isArray(question.answers) ? question.answers : []) {
    if (a && a.correct) out.push(String(a.id || "").toUpperCase());
  }
  return normalizeSelection(out);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort().join("|");
  const sb = [...b].sort().join("|");
  return sa === sb;
}

function sameSequence(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function evaluateAnswer(question, selection) {
  const type = normalizeAnswerType(question.answerType);
  const chosen = normalizeSelection(selection);
  const correctSel = getQuestionCorrectSelection(question);

  if (chosen.length === 0) {
    return { correct: false, timedOut: true };
  }

  if (type === "single") {
    return {
      correct: chosen.length === 1 && correctSel.length === 1 && chosen[0] === correctSel[0],
      timedOut: false,
    };
  }

  if (type === "multiple") {
    return {
      correct: sameSet(chosen, correctSel),
      timedOut: false,
    };
  }

  return {
    correct: sameSequence(chosen, correctSel),
    timedOut: false,
  };
}

function computeChosenPctFromTiming(timing) {
  if (!timing || typeof timing !== 'object') return null;
  const asNum = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const start = asNum(timing.startMs);
  const choice = asNum(timing.choiceMs);
  const end = asNum(timing.endMs);
  if (start === null || end === null) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return null;
  const actualChoice = Number.isFinite(choice) ? Math.max(start, Math.min(choice, end)) : end;
  const denom = Math.max(1, end - start);
  const frac = (actualChoice - start) / denom;
  if (!Number.isFinite(frac)) return null;
  if (frac < 0) return 0;
  if (frac > 1) return 1;
  return frac;
}

function compactControlPayloadForGamepad(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const type = String(payload.type || "");
  if (type === "phase") {
    const out = {
      type: "phase",
      phase: String(payload.phase || "idle"),
    };

    if (payload.question && typeof payload.question === "object") {
      out.question = {
        id: payload.question.id || null,
        answerType: normalizeAnswerType(payload.question.answerType),
      };
    }

    return out;
  }

  if (type === "submit-request") {
    return {
      type: "submit-request",
    };
  }

  if (type === "identify-display") {
    return {
      type: "identify-display",
      enabled: Boolean(payload.enabled),
      identifyNumber: Number.isFinite(payload.identifyNumber) ? Number(payload.identifyNumber) : null,
    };
  }

  return payload;
}

function publishToGamepad(gamepadId, topicKind, payload, opts = {}) {
  const retain = Boolean(opts && opts.retain);
  let outgoingPayload = payload;
  if (topicKind === "control") {
    outgoingPayload = compactControlPayloadForGamepad(payload);
    if (outgoingPayload && typeof outgoingPayload === "object") {
      const type = String(outgoingPayload.type || "");
      const gp = gamepads.get(gamepadId);
      const gpNumber = gp && Number.isInteger(Number(gp.gamepadNumber)) ? Number(gp.gamepadNumber) : null;
      if (type === "identify-display") {
        outgoingPayload.identifyNumber = gpNumber;
      }
    }
  }
  const topic = `gamepad/${gamepadId}/${topicKind}`;
  broker.publish(
    {
      topic,
      payload: JSON.stringify(outgoingPayload),
      qos: 1,
      retain,
    },
    () => {}
  );
}

function broadcastControl(payload, opts = {}) {
  for (const id of gamepads.keys()) {
    if (!isGamepadClientId(id)) continue;
    publishToGamepad(id, "control", payload, opts);
  }
}

function currentPhaseControlPayload() {
  const phase = String(session.stage || "idle");
  const payload = {
    type: "phase",
    phase,
  };

  const question = getCurrentQuestion();
  if (phase === "question" || phase === "voting" || phase === "collecting") {
    payload.question = questionPublicView(question);
  }

  return payload;
}

function publishPhaseToAllGamepads(payload) {
  const phasePayload = payload && typeof payload === "object"
    ? payload
    : currentPhaseControlPayload();
  broadcastControl(phasePayload, { retain: true });
}

function questionPublicView(question) {
  if (!question) return null;
  const view = {
    id: question.id,
    text: question.text,
    description: String(question.description || ""),
    answerType: normalizeAnswerType(question.answerType),
    points: Number(question.points || 1),
    imageDataUrl: question.imageDataUrl || null,
    ordering: normalizeSelection(question.ordering || []),
  };

  const shuffle = session.questionShuffles && session.questionShuffles[question.id] ? session.questionShuffles[question.id] : null;
  if (shuffle && Array.isArray(shuffle.displayAnswers) && shuffle.displayAnswers.length > 0) {
    view.answers = shuffle.displayAnswers.map((a) => ({ id: String(a.id || ""), text: String(a.text || "") }));
  } else {
    view.answers = (Array.isArray(question.answers) ? question.answers : []).map((a) => ({ id: String(a.id || ""), text: String(a.text || "") }));
  }

  return view;
}

function questionRevealView(question) {
  const view = questionPublicView(question);
  if (!view) return null;
  const correctSelectionOriginal = getQuestionCorrectSelection(question);
  const shuffle = session.questionShuffles && session.questionShuffles[question.id] ? session.questionShuffles[question.id] : null;
  let correctSelection = correctSelectionOriginal;
  if (shuffle && shuffle.originalToLetter) {
    correctSelection = (Array.isArray(correctSelectionOriginal) ? correctSelectionOriginal : []).map((id) => shuffle.originalToLetter[String(id || "").toUpperCase()] || String(id || "").toUpperCase());
  }
  return {
    ...view,
    correctSelection,
  };
}

function refreshGamepadVoteFlags() {
  const selections = session.currentRound && session.currentRound.selections ? session.currentRound.selections : {};
  const submitted = session.currentRound && session.currentRound.submitted ? session.currentRound.submitted : {};

  for (const gp of gamepads.values()) {
    gp.voted = Array.isArray(selections[gp.id]) && selections[gp.id].length > 0;
    gp.submitted = Boolean(submitted[gp.id]);
  }
}

function saveSnapshot() {
  ensureRuntimeDir();
  const snapshot = {
    savedAt: nowIso(),
    quizStore,
    session,
    gamepads: Array.from(gamepads.values()),
  };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf8");
}

function appendAudit(summary) {
  ensureRuntimeDir();
  const lines = [];
  lines.push("============================================================");
  lines.push(`Cas: ${new Date().toISOString()}`);
  lines.push(`Otazka #${summary.questionNumber}: ${summary.questionText}`);
  lines.push(`Typ: ${summary.answerType}`);
  lines.push(`Spravna odpoved: ${(summary.correctSelection || []).join(",") || "-"}`);
  lines.push(
    `Statistika: spravne=${summary.correctCount}, nespravne=${summary.incorrectCount}, timeout=${summary.timeoutCount}`
  );
  lines.push("Vysledky gamepadov:");
  for (const r of summary.results || []) {
    const status = r.timedOut ? "timeout" : (r.correct ? "spravne" : "nespravne");
    const selection = (r.selection || []).join(",") || "-";
    lines.push(
      ` - ${r.name || r.id} [${r.id}] | odpoved=${selection} | status=${status} | +${r.pointsAwarded} | body=${r.totalPoints}`
    );
  }
  fs.appendFileSync(AUDIT_LOG_PATH, `${lines.join("\n")}\n`, "utf8");
}

function publishRoundResultsToGamepads(summary) {
  if (!summary || !Array.isArray(summary.results)) return;
  if (Number.isFinite(summary.resultsPublishedAt)) return;

  for (const r of summary.results) {
    publishToGamepad(r.id, "result", {
      type: "result",
      correct: Boolean(r.correct),
      totalPoints: Number(r.totalPoints || 0),
    });
  }

  summary.resultsPublishedAt = Date.now();
}

function applySnapshotData(data) {
  if (!data || typeof data !== "object") {
    return false;
  }

  clearTimers();

  quizStore.version = data.quizStore && data.quizStore.version ? data.quizStore.version : null;
  quizStore.categories = Array.isArray(data.quizStore && data.quizStore.categories) ? data.quizStore.categories : [];
  quizStore.questions = Array.isArray(data.quizStore && data.quizStore.questions) ? data.quizStore.questions : [];
  quizStore.quizzes = Array.isArray(data.quizStore && data.quizStore.quizzes) ? data.quizStore.quizzes : [];

  const s = data.session || {};
  session.activeQuizId = s.activeQuizId || null;
  session.activeQuizName = s.activeQuizName || null;
  session.questionIds = Array.isArray(s.questionIds) ? s.questionIds : [];
  session.questionIndex = Number.isInteger(s.questionIndex) ? s.questionIndex : -1;
  session.identifyDisplayEnabled =
    typeof s.identifyDisplayEnabled === "boolean" ? s.identifyDisplayEnabled : true;
  session.stage = typeof s.stage === "string" ? s.stage : "idle";
  session.stageUpdatedAt = Number.isFinite(s.stageUpdatedAt) ? s.stageUpdatedAt : Date.now();
  session.votingEndsAt = Number.isFinite(s.votingEndsAt) ? s.votingEndsAt : null;
  session.collectingEndsAt = Number.isFinite(s.collectingEndsAt) ? s.collectingEndsAt : null;
  session.currentRound = s.currentRound && typeof s.currentRound === "object" ? s.currentRound : null;
  session.questionHistory = Array.isArray(s.questionHistory) ? s.questionHistory : [];
  session.questionShuffles = s.questionShuffles && typeof s.questionShuffles === "object" ? s.questionShuffles : {};

  gamepads.clear();
  for (const g of Array.isArray(data.gamepads) ? data.gamepads : []) {
    if (!g || !isGamepadClientId(g.id)) continue;
    gamepads.set(g.id, {
      id: g.id,
      gamepadNumber: Number.isInteger(Number(g.gamepadNumber)) ? Number(g.gamepadNumber) : nextGamepadNumber(),
      name: g.name || g.id,
      connected: Boolean(g.connected),
      hiddenByAdmin: Boolean(g.hiddenByAdmin),
      firstSeenAt: Number(g.firstSeenAt || Date.now()),
      lastConnectAt: g.lastConnectAt || null,
      lastDisconnectAt: g.lastDisconnectAt || null,
      lastTelemetryAt: g.lastTelemetryAt || null,
      rssiDbm: Number.isFinite(g.rssiDbm) ? Number(g.rssiDbm) : null,
      points: Number.isFinite(g.points) ? Number(g.points) : 0,
      voted: Boolean(g.voted),
      submitted: Boolean(g.submitted),
      lastSelection: normalizeSelection(g.lastSelection || []),
      lastResult: g.lastResult || null,
      speedPercentages: Array.isArray(g.speedPercentages) ? g.speedPercentages : [],
    });
  }

  const seenNumbers = new Set();
  for (const gp of gamepads.values()) {
    const n = Number(gp.gamepadNumber);
    const valid = Number.isInteger(n) && n > 0 && !seenNumbers.has(n);
    if (!valid) {
      gp.gamepadNumber = nextGamepadNumber();
    }
    seenNumbers.add(Number(gp.gamepadNumber));
  }

  refreshGamepadVoteFlags();

  // Re-arm timers on restore.
  if (session.stage === "voting" && Number.isFinite(session.votingEndsAt)) {
    const delay = Math.max(0, session.votingEndsAt - Date.now());
    votingTimer = setTimeout(() => endVotingPhase(), delay);
  }
  if (session.stage === "collecting" && Number.isFinite(session.collectingEndsAt)) {
    const delay = Math.max(0, session.collectingEndsAt - Date.now());
    collectingTimer = setTimeout(() => finalizeRound(), delay);
  }

  return true;
}

function loadSnapshotFromDisk() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return false;
  }
  const raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
  const data = JSON.parse(raw);
  return applySnapshotData(data);
}

function sessionStateForClient() {
  const question = getCurrentQuestion();
  const latestResult = session.questionHistory[session.questionHistory.length - 1] || null;
  const totalStats = session.questionHistory.reduce(
    (acc, item) => {
      acc.correctCount += Number(item && item.correctCount ? item.correctCount : 0);
      acc.incorrectCount += Number(item && item.incorrectCount ? item.incorrectCount : 0);
      acc.timeoutCount += Number(item && item.timeoutCount ? item.timeoutCount : 0);
      return acc;
    },
    { correctCount: 0, incorrectCount: 0, timeoutCount: 0 }
  );

  const leaderboard = Array.from(gamepads.values())
    .map((g) => {
      const sp = Array.isArray(g.speedPercentages) ? g.speedPercentages : [];
      const avgFrac = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : null;
      const avgPct = avgFrac !== null ? Math.round(avgFrac * 1000) / 10 : null; // 1 decimal percent
      return {
        id: g.id,
        gamepadNumber: Number(g.gamepadNumber || 0),
        name: g.name || g.id,
        points: Number(g.points || 0),
        avgResponsePct: avgPct,
      };
    })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const aAvg = a.avgResponsePct === null ? Infinity : a.avgResponsePct;
      const bAvg = b.avgResponsePct === null ? Infinity : b.avgResponsePct;
      if (aAvg !== bAvg) return aAvg - bAvg; // lower percent = faster
      return a.name.localeCompare(b.name);
    });

  const gamepadList = Array.from(gamepads.values())
    .filter((g) => !(g.hiddenByAdmin && !g.connected))
    .map((g) => ({
      id: g.id,
      gamepadNumber: Number(g.gamepadNumber || 0),
      name: g.name || g.id,
      connected: Boolean(g.connected),
      points: Number(g.points || 0),
      rssiDbm: Number.isFinite(g.rssiDbm) ? Number(g.rssiDbm) : null,
      batteryPct: Number.isFinite(g.batteryPct) ? Number(g.batteryPct) : null,
      lastTelemetryAt: g.lastTelemetryAt,
      voted: Boolean(g.voted),
      submitted: Boolean(g.submitted),
      lastSelection: normalizeSelection(g.lastSelection || []),
      lastResult: g.lastResult || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // attach avgResponsePct to gamepadList entries for UI
  for (const gp of gamepadList) {
    const g = gamepads.get(gp.id);
    const sp = g && Array.isArray(g.speedPercentages) ? g.speedPercentages : [];
    const avgFrac = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : null;
    gp.avgResponsePct = avgFrac !== null ? Math.round(avgFrac * 1000) / 10 : null;
  }

  const roundsWithResponders = session.questionHistory.filter(
    (item) => Number(item && item.totalResponders ? item.totalResponders : 0) > 0
  );

  const toInsight = (item) => {
    if (!item) return null;
    const totalResponders = Number(item.totalResponders || 0);
    const correctCount = Number(item.correctCount || 0);
    const successRate = totalResponders > 0 ? correctCount / totalResponders : 0;
    return {
      questionId: item.questionId || null,
      questionNumber: Number(item.questionNumber || 0),
      questionText: String(item.questionText || ""),
      correctCount,
      totalResponders,
      successRate,
      successPercent: Math.round(successRate * 1000) / 10,
    };
  };

  let bestQuestion = null;
  let worstQuestion = null;
  for (const item of roundsWithResponders) {
    const totalResponders = Number(item.totalResponders || 0);
    const correctCount = Number(item.correctCount || 0);
    const rate = totalResponders > 0 ? correctCount / totalResponders : 0;

    if (!bestQuestion) {
      bestQuestion = item;
    } else {
      const bestRate = Number(bestQuestion.correctCount || 0) / Number(bestQuestion.totalResponders || 1);
      if (rate > bestRate) {
        bestQuestion = item;
      }
    }

    if (!worstQuestion) {
      worstQuestion = item;
    } else {
      const worstRate = Number(worstQuestion.correctCount || 0) / Number(worstQuestion.totalResponders || 1);
      if (rate < worstRate) {
        worstQuestion = item;
      }
    }
  }

  const finalInsights = {
    bestQuestion: toInsight(bestQuestion),
    worstQuestion: toInsight(worstQuestion),
  };

  return {
    stage: session.stage,
    stageUpdatedAt: session.stageUpdatedAt,
    activeQuizId: session.activeQuizId,
    activeQuizName: session.activeQuizName,
    identifyDisplayEnabled: Boolean(session.identifyDisplayEnabled),
    questionIndex: session.questionIndex,
    totalQuestions: session.questionIds.length,
    votingEndsAt: session.votingEndsAt,
    collectingEndsAt: session.collectingEndsAt,
    currentQuestion: session.stage === "reveal"
      ? questionRevealView(question)
      : questionPublicView(question),
    latestResult,
    totalStats,
    finalInsights,
    leaderboard,
    gamepads: gamepadList,
  };
}

function beginQuiz(quizId) {
  const quiz = quizStore.quizzes.find((q) => q.id === quizId);
  if (!quiz) {
    throw new Error("Quiz not found");
  }

  const questionIds = computeQuizQuestionIds(quiz);
  if (questionIds.length < 1) {
    throw new Error("Selected quiz has no questions");
  }

  clearTimers();
  session.activeQuizId = quiz.id;
  session.activeQuizName = quiz.name || "Quiz";
  session.questionIds = questionIds;
  session.questionIndex = 0;
  session.votingEndsAt = null;
  session.collectingEndsAt = null;
  session.currentRound = null;
  session.questionHistory = [];

  for (const gp of gamepads.values()) {
    gp.points = 0;
    gp.voted = false;
    gp.submitted = false;
    gp.lastSelection = [];
    gp.lastResult = null;
  }

  setStage("welcome");
  publishPhaseToAllGamepads({
    type: "phase",
    phase: "welcome",
  });
  saveSnapshot();
}

function enterQuestionStage() {
  setStage("question");
  session.votingEndsAt = null;
  session.collectingEndsAt = null;
  session.currentRound = null;

  const question = getCurrentQuestion();
  // Ensure we have a stable shuffle mapping for this question so clients
  // (gamepads/quiz display/admin) see answers in the same randomized order.
  try { ensureShuffleForQuestion(question); } catch (e) {}
  publishPhaseToAllGamepads({
    type: "phase",
    phase: "question",
    question: questionPublicView(question),
  });
}

function beginVotingPhase() {
  if (session.stage !== "question") {
    throw new Error("Voting can only start from question phase");
  }

  clearTimers();

  const now = Date.now();
  const question = getCurrentQuestion();
  try { ensureShuffleForQuestion(question); } catch (e) {}
  const questionId = question && question.id ? question.id : null;
  const answerType = question ? normalizeAnswerType(question.answerType) : "single";
  const votingMs = votingDurationMsForAnswerType(answerType);

  session.currentRound = {
    questionId,
    answerType,
    selections: {},
    submitted: {},
    // per-gamepad timings collected from clients (startMs, choiceMs, endMs)
    timings: {},
    expectedResponderIds: Array.from(gamepads.values())
      .filter((g) => g.connected)
      .map((g) => g.id),
    startedAt: now,
    votingEndsAt: now + votingMs,
    collectingEndsAt: null,
  };

  for (const gp of gamepads.values()) {
    gp.voted = false;
    gp.submitted = false;
    gp.lastSelection = [];
    gp.lastResult = null;
  }

  session.votingEndsAt = now + votingMs;
  session.collectingEndsAt = null;
  setStage("voting");

  publishPhaseToAllGamepads({
    type: "phase",
    phase: "voting",
    question: questionPublicView(question),
  });

  votingTimer = setTimeout(() => endVotingPhase(), votingMs);
}

function allExpectedSubmitted() {
  if (!session.currentRound) return true;
  const expected = Array.isArray(session.currentRound.expectedResponderIds)
    ? session.currentRound.expectedResponderIds
    : [];
  const submitted = session.currentRound.submitted || {};
  return expected.every((id) => Boolean(submitted[id]));
}

function endVotingPhase() {
  if (session.stage !== "voting") return;

  clearTimers();

  const now = Date.now();
  const question = getCurrentQuestion();

  setStage("collecting");
  session.votingEndsAt = null;
  session.collectingEndsAt = now + SUBMIT_TIMEOUT_MS;
  if (session.currentRound) {
    session.currentRound.collectingEndsAt = session.collectingEndsAt;
  }

  publishPhaseToAllGamepads({
    type: "phase",
    phase: "collecting",
    question: questionPublicView(question),
  });

  broadcastControl({
    type: "submit-request",
  });

  if (allExpectedSubmitted()) {
    finalizeRound();
    return;
  }

  collectingTimer = setTimeout(() => finalizeRound(), SUBMIT_TIMEOUT_MS);
}

function finalizeRound() {
  if (session.stage !== "collecting" && session.stage !== "voting") return;

  clearTimers();

  const question = getCurrentQuestion();
  const shuffle = session.questionShuffles && question && session.questionShuffles[question.id] ? session.questionShuffles[question.id] : null;
  if (!question) {
    setStage("question");
    return;
  }

  const round = session.currentRound || {
    selections: {},
    submitted: {},
    expectedResponderIds: [],
  };

  const expectedIds = Array.from(new Set([
    ...Array.from(gamepads.keys()).filter((id) => isGamepadClientId(id)),
    ...(Array.isArray(round.expectedResponderIds) ? round.expectedResponderIds : []),
    ...Object.keys(round.selections || {}),
    ...Object.keys(round.submitted || {}),
  ])).filter((id) => {
    if (!isGamepadClientId(id)) return false;
    if (!gamepads.has(id)) return false; // exclude deleted/unknown gamepads
    const g = gamepads.get(id);
    // Only count currently connected gamepads (admin-hidden or disconnected are excluded)
    return Boolean(g && g.connected);
  });

  const results = [];
  let correctCount = 0;
  let incorrectCount = 0;
  let timeoutCount = 0;

  for (const id of expectedIds) {
    const gp = ensureGamepad(id);
    const selected = normalizeSelection((round.selections || {})[id] || []);
    const answered = selected.length > 0;

    // Map displayed letters back to original answer IDs for evaluation
    let selectedForEval = selected;
    try {
      if (shuffle && shuffle.letterToOriginal) {
        selectedForEval = (Array.isArray(selected) ? selected : []).map((l) => shuffle.letterToOriginal[String(l || "").toUpperCase()] || String(l || "").toUpperCase());
      }
    } catch (e) {}

    const evalResult = evaluateAnswer(question, selectedForEval);
    const pointsAwarded = evalResult.correct ? Number(question.points || 1) : 0;

    if (evalResult.correct) correctCount += 1;
    else if (evalResult.timedOut) timeoutCount += 1;
    else incorrectCount += 1;

    if (gp) {
      gp.points = Number(gp.points || 0) + pointsAwarded;
      gp.voted = answered;
      gp.submitted = Boolean((round.submitted || {})[id]);
      // Keep lastSelection as displayed letters for admin/UI clarity
      gp.lastSelection = selected;
      // compute response percentage from client-provided timings, if any
      // NOTE: for tie-breaks we only record timing percentages from CORRECT answers.
      let responsePct = null;
      try {
        if (round && round.timings && round.timings[id]) {
          responsePct = computeChosenPctFromTiming(round.timings[id]);
        }
      } catch (e) {}

      // persist per-gamepad speed stats only for correct answers
      if (evalResult.correct && Number.isFinite(responsePct)) {
        gp.speedPercentages = Array.isArray(gp.speedPercentages) ? gp.speedPercentages : [];
        gp.speedPercentages.push(responsePct);
      }

      gp.lastResult = {
        questionId: question.id,
        correct: evalResult.correct,
        timedOut: evalResult.timedOut,
        pointsAwarded,
        totalPoints: gp.points,
        at: Date.now(),
        responsePct: (evalResult.correct && Number.isFinite(responsePct)) ? responsePct : null,
      };
    }

    results.push({
      id,
      name: gp ? gp.name : id,
      selection: selected,
      submitted: Boolean((round.submitted || {})[id]),
      correct: evalResult.correct,
      timedOut: evalResult.timedOut,
      pointsAwarded,
      totalPoints: gp ? gp.points : pointsAwarded,
      responsePct: (typeof gp !== 'undefined' && gp.lastResult) ? gp.lastResult.responsePct : null,
    });

    publishToGamepad(id, "control", {
      type: "phase",
      phase: "reveal",
      questionId: question.id,
    }, { retain: true });
  }

  // For summary, present correctSelection using displayed letters (if shuffled)
  const correctSelectionOriginal = getQuestionCorrectSelection(question);
  const correctSelectionDisplay = (shuffle && shuffle.originalToLetter)
    ? (Array.isArray(correctSelectionOriginal) ? correctSelectionOriginal : []).map((id) => shuffle.originalToLetter[String(id || "").toUpperCase()] || String(id || "").toUpperCase())
    : correctSelectionOriginal;

  const summary = {
    questionNumber: session.questionIndex + 1,
    questionId: question.id,
    questionText: question.text,
    answerType: normalizeAnswerType(question.answerType),
    correctSelection: correctSelectionDisplay,
    correctCount,
    incorrectCount,
    timeoutCount,
    totalResponders: expectedIds.length,
    results,
    finishedAt: Date.now(),
    resultsPublishedAt: null,
  };

  session.questionHistory.push(summary);
  session.currentRound = null;
  session.collectingEndsAt = null;
  session.votingEndsAt = null;

  refreshGamepadVoteFlags();
  // Publish results immediately (per-gamepad result messages) and move to
  // reveal phase so audience sees correct answers without requiring an admin click.
  try {
    publishRoundResultsToGamepads(summary);
  } catch (e) {}
  setStage("reveal");
  publishPhaseToAllGamepads({
    type: "phase",
    phase: "reveal",
    question: questionRevealView(question),
  });
  appendAudit(summary);
  saveSnapshot();
}

function toQuestionOrFinishAfterReveal() {
  // Advance after reveal directly to next question or finish.
  if (session.questionIndex + 1 >= session.questionIds.length) {
    setStage("finished");
    publishPhaseToAllGamepads({ type: "phase", phase: "finished" });
    saveSnapshot();
    return;
  }

  session.questionIndex += 1;
  enterQuestionStage();
  saveSnapshot();
}

function handleChoiceMessage(gamepadId, payload) {
  const gp = ensureGamepad(gamepadId);
  if (!gp) return;

  const selection = normalizeSelection(payload.selection || (payload.button ? [payload.button] : []));
  gp.lastSelection = selection;

  if (session.stage === "voting" && session.currentRound) {
    session.currentRound.selections[gamepadId] = selection;
    gp.voted = selection.length > 0;
  }
}

function handleSubmitMessage(gamepadId, payload) {
  const gp = ensureGamepad(gamepadId);
  if (!gp) return;

  const selection = normalizeSelection(payload.selection || []);
  gp.lastSelection = selection;

  if ((session.stage === "collecting" || session.stage === "voting") && session.currentRound) {
    session.currentRound.selections[gamepadId] = selection;
    // store timing payload if provided (client-monotonic measurements)
    try {
      const t = payload.timing;
      if (t && typeof t === 'object') {
        if (!session.currentRound.timings) session.currentRound.timings = {};
        const startMs = (t.startMs !== null && t.startMs !== undefined && String(t.startMs).trim() !== '' && Number.isFinite(Number(t.startMs))) ? Number(t.startMs) : null;
        const choiceMs = (t.choiceMs !== null && t.choiceMs !== undefined && String(t.choiceMs).trim() !== '' && Number.isFinite(Number(t.choiceMs))) ? Number(t.choiceMs) : null;
        const endMs = (t.endMs !== null && t.endMs !== undefined && String(t.endMs).trim() !== '' && Number.isFinite(Number(t.endMs))) ? Number(t.endMs) : null;
        session.currentRound.timings[gamepadId] = { startMs, choiceMs, endMs };
      }
    } catch (e) {}
    session.currentRound.submitted[gamepadId] = true;
    gp.voted = selection.length > 0;
    gp.submitted = true;

    if (session.stage === "collecting" && allExpectedSubmitted()) {
      finalizeRound();
    }
  }
}

function handleTelemetryMessage(gamepadId, payload) {
  const gp = ensureGamepad(gamepadId);
  if (!gp) return;
  gp.lastTelemetryAt = Date.now();
  const rssi = Number(payload.rssiDbm);
  if (Number.isFinite(rssi)) gp.rssiDbm = rssi;
  const battery = Number(payload.batteryPct);
  if (Number.isFinite(battery)) {
    gp.batteryPct = Math.max(0, Math.min(100, Math.round(battery)));
  }
}

broker.on("client", (client) => {
  const id = client && client.id ? String(client.id) : "";
  const gp = ensureGamepad(id);
  if (gp) {
    gp.connected = true;
    gp.hiddenByAdmin = false;
    gp.lastConnectAt = Date.now();

    // Push identify + phase sync after subscribe and once again shortly after.
    const syncOne = () => {
      publishToGamepad(id, "control", {
        type: "identify-display",
        enabled: Boolean(session.identifyDisplayEnabled),
      });
      publishToGamepad(id, "control", currentPhaseControlPayload(), { retain: true });

      if (session.stage === "collecting" && Number.isFinite(session.collectingEndsAt)) {
        publishToGamepad(id, "control", {
          type: "submit-request",
        });
      }
    };

    setTimeout(syncOne, 300);
    setTimeout(syncOne, 1400);
  }
});

broker.on("clientDisconnect", (client) => {
  const id = client && client.id ? String(client.id) : "";
  const gp = ensureGamepad(id);
  if (gp) {
    gp.connected = false;
    gp.lastDisconnectAt = Date.now();
  }
});

broker.on("publish", (packet, client) => {
  if (!client) return;
  const topic = packet && packet.topic ? String(packet.topic) : "";
  if (!topic.startsWith("gamepad/")) return;

  const parts = topic.split("/");
  const gamepadId = parts[1];
  const kind = parts[2] || "";

  if (!isGamepadClientId(gamepadId)) return;

  let payload = {};
  try {
    payload = JSON.parse(packet.payload ? packet.payload.toString("utf8") : "{}");
  } catch (err) {
    return;
  }

  if (kind === "telemetry") {
    handleTelemetryMessage(gamepadId, payload);
    return;
  }
  if (kind === "choice") {
    handleChoiceMessage(gamepadId, payload);
    return;
  }
  if (kind === "submit") {
    handleSubmitMessage(gamepadId, payload);
  }
});

const mqttTcpServer = net.createServer(broker.handle);
mqttTcpServer.on("error", (err) => {
  console.error("MQTT TCP server error:", err && err.message ? err.message : err);
});

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const httpServer = http.createServer(app);
websocketStream.createServer({ server: httpServer, path: WS_PATH }, broker.handle);

app.get("/quiz", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "quiz.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/maker", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "maker.html"));
});

app.get("/gamepad", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "gamepad.html"));
});

app.get("/api/state", (req, res) => {
  res.json(sessionStateForClient());
});

app.get("/api/quizzes", (req, res) => {
  const list = quizStore.quizzes.map((q) => ({
    id: q.id,
    name: q.name || "Quiz",
    totalQuestions: computeQuizQuestionIds(q).length,
  }));
  res.json({ quizzes: list });
});

app.get("/api/gamepads", (req, res) => {
  const list = Array.from(gamepads.values())
    .filter((g) => !(g.hiddenByAdmin && !g.connected))
    .map((g) => ({
      id: g.id,
      gamepadNumber: Number(g.gamepadNumber || 0),
      name: g.name || g.id,
      connected: Boolean(g.connected),
      points: Number(g.points || 0),
      voted: Boolean(g.voted),
      submitted: Boolean(g.submitted),
      rssiDbm: Number.isFinite(g.rssiDbm) ? Number(g.rssiDbm) : null,
      batteryPct: Number.isFinite(g.batteryPct) ? Number(g.batteryPct) : null,
      lastTelemetryAt: g.lastTelemetryAt,
      lastSelection: normalizeSelection(g.lastSelection || []),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ gamepads: list });
});

app.patch("/api/gamepads/:id", (req, res) => {
  const gp = ensureGamepad(req.params.id);
  if (!gp) {
    return res.status(404).json({ error: "Gamepad not found" });
  }

  if (typeof req.body.name === "string") {
    const trimmed = req.body.name.trim();
    gp.name = trimmed || gp.id;
  }

  if (req.body.points !== undefined) {
    const p = Number(req.body.points);
    if (!Number.isFinite(p)) {
      return res.status(400).json({ error: "points must be a number" });
    }
    gp.points = Math.max(0, Math.round(p));
  }

  saveSnapshot();
  return res.json({ ok: true });
});

app.post("/api/gamepads/:id/ack-correct", (req, res) => {
  const id = String(req.params.id || "");
  const gp = ensureGamepad(id);
  if (!gp) {
    return res.status(404).json({ error: "Gamepad not found" });
  }

  const question = getCurrentQuestion() || (session.questionHistory.length ? getQuestionById(session.questionHistory[session.questionHistory.length - 1].questionId) : null);
  if (!question) {
    return res.status(400).json({ error: "No current question context" });
  }

  const pts = Number(question.points || 1);
  gp.points = Number(gp.points || 0) + pts;
  gp.lastResult = gp.lastResult || {};
  gp.lastResult.correct = true;
  gp.lastResult.pointsAwarded = Number(gp.lastResult.pointsAwarded || 0) + pts;
  gp.lastResult.totalPoints = gp.points;

  saveSnapshot();
  return res.json({ ok: true });
});

app.delete("/api/gamepads/:id", (req, res) => {
  const id = String(req.params.id || "");
  const gp = gamepads.get(id);
  if (!gp) {
    return res.status(404).json({ error: "Gamepad not found" });
  }

  if (gp.connected) {
    return res.status(409).json({ error: "Gamepad is online and cannot be deleted" });
  }

  gp.hiddenByAdmin = true;

  if (session.currentRound && typeof session.currentRound === "object") {
    if (Array.isArray(session.currentRound.expectedResponderIds)) {
      session.currentRound.expectedResponderIds = session.currentRound.expectedResponderIds.filter((x) => x !== id);
    }
  }

  saveSnapshot();
  return res.json({ ok: true });
});

app.post("/api/quiz/load", (req, res) => {
  const data = req.body;
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "Missing JSON payload" });
  }
  if (!Array.isArray(data.questions) || !Array.isArray(data.quizzes) || !Array.isArray(data.categories)) {
    return res.status(400).json({ error: "Invalid quiz JSON structure" });
  }

  quizStore.version = typeof data.version === "string" ? data.version : null;
  quizStore.categories = data.categories;
  quizStore.questions = data.questions;
  quizStore.quizzes = data.quizzes;

  const quizzes = quizStore.quizzes.map((q) => ({
    id: q.id,
    name: q.name || "Quiz",
    totalQuestions: computeQuizQuestionIds(q).length,
  }));

  saveSnapshot();
  return res.json({ ok: true, quizzes });
});

app.post("/api/session/start", (req, res) => {
  try {
    beginQuiz(String(req.body.quizId || ""));
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to start quiz" });
  }
});

app.post("/api/session/start-voting", (req, res) => {
  try {
    beginVotingPhase();
    saveSnapshot();
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to start voting" });
  }
});

app.post("/api/session/next", (req, res) => {
  try {
    if (session.stage === "welcome") {
      enterQuestionStage();
    } else if (session.stage === "question") {
      beginVotingPhase();
    } else if (session.stage === "review") {
      const latest = session.questionHistory[session.questionHistory.length - 1] || null;
      publishRoundResultsToGamepads(latest);
      setStage("reveal");
      broadcastControl({ type: "phase", phase: "reveal" });
    } else if (session.stage === "reveal") {
      // Skip stats stage entirely and proceed to next question or finish
      toQuestionOrFinishAfterReveal();
    } else {
      throw new Error("No forward transition available from current stage");
    }

    saveSnapshot();
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to advance stage" });
  }
});

app.post("/api/session/finalize", (req, res) => {
  try {
    // Only allow finalize when we're in reveal/review and at last question
    if (!(session.stage === "reveal" || session.stage === "review")) {
      throw new Error("Can only finalize after reveal/review stage");
    }
    if (session.questionIndex + 1 < session.questionIds.length) {
      throw new Error("Not the last question");
    }

    // Mark session finished but do NOT broadcast a new phase to gamepads.
    // This preserves the last published result display on gamepads.
    setStage("finished");
    // Broadcast a short control message instructing gamepads to turn their
    // LEDs off while preserving the displayed totals we already sent via
    // result messages.
    try {
      broadcastControl({ type: "final-stats" });
    } catch (e) {}
    // Persist state
    saveSnapshot();
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to finalize quiz" });
  }
});

app.post("/api/session/prev", (req, res) => {
  try {
    if (session.stage === "voting" || session.stage === "collecting") {
      throw new Error("Cannot go back during voting/collecting");
    }

    if (session.stage === "reveal") {
      setStage("review");
    } else if (session.stage === "review") {
      setStage("question");
    } else if (session.stage === "question") {
      if (session.questionIndex > 0 && session.questionHistory.length > 0) {
        session.questionIndex -= 1;
        setStage("reveal");
        broadcastControl({ type: "phase", phase: "reveal" });
      } else {
        setStage("welcome");
      }
    } else {
      throw new Error("No backward transition available from current stage");
    }

    saveSnapshot();
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to go back" });
  }
});

app.post("/api/session/restore", (req, res) => {
  try {
    const ok = loadSnapshotFromDisk();
    if (!ok) {
      return res.status(404).json({ error: "No snapshot file found" });
    }
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Restore failed" });
  }
});

app.post("/api/session/restore-file", (req, res) => {
  try {
    const ok = applySnapshotData(req.body);
    if (!ok) {
      return res.status(400).json({ error: "Invalid snapshot JSON" });
    }
    saveSnapshot();
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Restore from file failed" });
  }
});

app.post("/api/session/end", (req, res) => {
  try {
    if (session.stage === "idle") {
      throw new Error("No active quiz session");
    }

    clearTimers();
    session.votingEndsAt = null;
    session.collectingEndsAt = null;
    session.currentRound = null;
    setStage("finished");
    broadcastControl({ type: "phase", phase: "finished" });
    saveSnapshot();
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to end quiz" });
  }
});

app.post("/api/session/identify-display", (req, res) => {
  try {
    const enabled = Boolean(req.body && req.body.enabled);
    session.identifyDisplayEnabled = enabled;

    broadcastControl({
      type: "identify-display",
      enabled,
    });

    saveSnapshot();
    return res.json({ ok: true, state: sessionStateForClient() });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to update identify display" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

mqttTcpServer.listen(MQTT_TCP_PORT, MQTT_TCP_HOST, () => {
  console.log(`MQTT broker (TCP) listening on ${MQTT_TCP_HOST}:${MQTT_TCP_PORT}`);
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`HTTP listening on http://${HTTP_HOST}:${HTTP_PORT}`);
  console.log(`MQTT over WebSocket available at ${WS_PATH}`);
});

process.on("SIGINT", () => {
  console.log("\nshutting down...");
  clearTimers();
  try {
    saveSnapshot();
  } catch (err) {}
  try {
    mqttTcpServer.close(() => {});
  } catch (err) {}
  try {
    httpServer.close(() => {});
  } catch (err) {}
  try {
    broker.close(() => process.exit(0));
  } catch (err) {
    process.exit(0);
  }
});
