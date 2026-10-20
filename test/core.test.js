import assert from "node:assert/strict";
import test from "node:test";

import {
  ABNORMAL_KINDS,
  SELF_SOURCE,
  SWALLOWED_KIND,
  backoffFor,
  causeKindOf,
  createState,
  failureCodeOf,
  hasFreshHumanTurn,
  inboxBusy,
  inspectStop,
  inspectSwallowed,
  inspectTurn,
  isContinueLikeKind,
  isHumanSourceKind,
  isUserAbort,
  lastTurnEnd,
  looksOwned,
  makeContinueMessage,
  sessionEventsOf,
  shouldAutoContinue,
  tailLooksLikeDsml,
} from "../lib/core.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../lib/config.js";

const cfg = normalizeConfig({});

function endEvent(seq, reason) {
  return { type: "turn/end", seq, data: { turn: 1, reason } };
}

function userEvent(seq, kind) {
  return { type: "user/message", seq, data: { source: { kind } } };
}

test("lastTurnEnd 取最后一条", () => {
  const events = [endEvent(1, { kind: "completed" }), { type: "step/start", seq: 2 }, endEvent(3, { kind: "error" })];
  assert.equal(lastTurnEnd(events).seq, 3);
  assert.equal(lastTurnEnd([]), null);
  assert.equal(lastTurnEnd(null), null);
});

test("causeKindOf 兼容字符串和对象两种 cause", () => {
  assert.equal(causeKindOf({ kind: "aborted", reason: "user" }), "user");
  assert.equal(causeKindOf({ kind: "aborted", reason: { kind: "hook" } }), "hook");
  assert.equal(causeKindOf({ kind: "aborted" }), "");
  assert.equal(causeKindOf(null), "");
});

test("isUserAbort 只认 user/cancel", () => {
  assert.equal(isUserAbort({ kind: "aborted", reason: { kind: "user" } }), true);
  assert.equal(isUserAbort({ kind: "aborted", reason: "user" }), true);
  assert.equal(isUserAbort({ kind: "aborted", reason: { kind: "hook", reason: "unstuck-stall" } }), false);
  assert.equal(isUserAbort({ kind: "aborted", reason: { kind: "disposed" } }), false);
  assert.equal(isUserAbort({ kind: "error" }), false);
});

test("inspectTurn 摘要正确", () => {
  const info = inspectTurn([endEvent(9, { kind: "error", error: { code: "network_error", message: "x" } })]);
  assert.equal(info.seq, 9);
  assert.equal(info.kind, "error");
  assert.equal(info.code, "NETWORK_ERROR");
  assert.equal(info.abnormal, true);
  assert.equal(info.userAbort, false);

  const done = inspectTurn([endEvent(1, { kind: "completed" })]);
  assert.equal(done.abnormal, false);
  assert.equal(done.code, "");
});

test("failureCodeOf 各种位置都能挖出来", () => {
  assert.equal(failureCodeOf({ error: { code: "AUTH" } }), "AUTH");
  assert.equal(failureCodeOf({ failure: { code: "quota" } }), "QUOTA");
  assert.equal(failureCodeOf({ code: "x" }), "X");
  assert.equal(failureCodeOf(null), "");
});

test("shouldAutoContinue：正常结束不续、报错续、用户中断不续、永久错误不续", () => {
  assert.equal(shouldAutoContinue({ kind: "completed" }, cfg), false);
  assert.equal(shouldAutoContinue({ kind: "blocked" }, cfg), false);
  assert.equal(shouldAutoContinue({ kind: "forked" }, cfg), false);
  assert.equal(shouldAutoContinue(null, cfg), false);

  assert.equal(shouldAutoContinue({ kind: "error", error: { code: "NETWORK" } }, cfg), true);
  assert.equal(shouldAutoContinue({ kind: "max-tokens" }, cfg), true);
  assert.equal(shouldAutoContinue({ kind: "interrupted" }, cfg), true);

  assert.equal(shouldAutoContinue({ kind: "aborted", reason: { kind: "user" } }, cfg), false);
  assert.equal(shouldAutoContinue({ kind: "aborted", reason: { kind: "hook", reason: "stall" } }, cfg), true);

  assert.equal(shouldAutoContinue({ kind: "error", error: { code: "AUTH" } }, cfg), false);
  assert.equal(shouldAutoContinue({ kind: "error", error: { code: "insufficient_balance" } }, cfg), false);
  assert.equal(shouldAutoContinue({ kind: "error", error: { code: "context_overflow" } }, cfg), false);
});

test("continueOn 可以收窄", () => {
  const only = normalizeConfig({ continueOn: ["error"] });
  assert.equal(shouldAutoContinue({ kind: "max-tokens" }, only), false);
  assert.equal(shouldAutoContinue({ kind: "error" }, only), true);
});

test("hasFreshHumanTurn：只认 kind === \"user\" 的真人消息", () => {
  const base = [endEvent(5, { kind: "error" })];
  assert.equal(hasFreshHumanTurn(base), false);
  assert.equal(hasFreshHumanTurn([...base, userEvent(6, "user")]), true);
  // 桌面端「继续」按钮 / 我们自己的续跑：已经有人续过了，别再补一条
  assert.equal(hasFreshHumanTurn([...base, userEvent(6, "continue")]), true);
  assert.equal(hasFreshHumanTurn([...base, userEvent(6, SELF_SOURCE)]), true);
  // turn/end 之前的人类消息不算「接手」
  assert.equal(hasFreshHumanTurn([userEvent(1, "user"), endEvent(5, { kind: "error" })]), false);
  assert.equal(hasFreshHumanTurn([]), false);
});

test("harness 自己塞的上下文不算真人接手（否则续跑永远不触发）", () => {
  const base = [endEvent(5, { kind: "error" })];
  // 这些全是真实会话里观测到的 source.kind，一个都不是人打的
  for (const kind of [
    "time-context",
    "runtime-context",
    "skill-catalog",
    "agent-instructions",
    "goal",
    "user-approval",
    "tool-jobs",
    "model-selection",
    "tool-goal",
    "dsh-rewind",
    "plugin",
    "plugin:dsh-im",
    "plugin:hindsight",
    "system",
    "dsh-purge",
    "content-risk-recovery",
  ]) {
    assert.equal(
      hasFreshHumanTurn([...base, userEvent(6, kind)]),
      false,
      `${kind} 不该被当成真人接手`,
    );
  }
  // 缺 source / 缺 kind 的脏数据也不能当真人
  assert.equal(hasFreshHumanTurn([...base, { type: "user/message", seq: 6 }]), false);
});

test("isHumanSourceKind / isContinueLikeKind 的边界", () => {
  assert.equal(isHumanSourceKind("user"), true);
  assert.equal(isHumanSourceKind("User"), false);
  assert.equal(isHumanSourceKind(undefined), false);
  assert.equal(isHumanSourceKind(""), false);
  assert.equal(isContinueLikeKind("continue"), true);
  assert.equal(isContinueLikeKind(SELF_SOURCE), true);
  assert.equal(isContinueLikeKind("user"), false);
  assert.equal(isContinueLikeKind(undefined), false);
});

test("inboxBusy 看 nextTurn/nextStep", () => {
  assert.equal(inboxBusy(null), false);
  assert.equal(inboxBusy({}), false);
  assert.equal(inboxBusy({ inbox: { nextTurn: [], nextStep: [] } }), false);
  assert.equal(inboxBusy({ inbox: { nextTurn: [{}], nextStep: [] } }), true);
  assert.equal(inboxBusy({ inbox: { nextTurn: [], nextStep: [{}] } }), true);
});

test("sessionEventsOf 兜底", () => {
  assert.deepEqual(sessionEventsOf(null), []);
  assert.deepEqual(sessionEventsOf({ session: { snapshotEvents: () => [{ type: "x" }] } }), [{ type: "x" }]);
  assert.deepEqual(sessionEventsOf({ session: { events: [{ type: "y" }] } }), [{ type: "y" }]);
  assert.deepEqual(sessionEventsOf({ session: { snapshotEvents: () => null } }), []);
});

test("looksOwned 认子 agent", () => {
  assert.equal(looksOwned({ id: "a" }), false);
  assert.equal(looksOwned({ id: "a", parent: {} }), true);
  assert.equal(looksOwned({ id: "a", session: { parentSessionId: "p" } }), true);
});

test("backoffFor 查表 + 越界取最后一档", () => {
  const table = [100, 200];
  assert.equal(backoffFor(0, table), 100);
  assert.equal(backoffFor(1, table), 200);
  assert.equal(backoffFor(99, table), 200);
  assert.equal(backoffFor(-1, table), 100);
  assert.equal(backoffFor(0, []), 1500);
  assert.equal(backoffFor(0, null), 1500);
});

test("makeContinueMessage 带自己的 source", () => {
  const msg = makeContinueMessage("继续", "id-1");
  assert.equal(msg.id, "id-1");
  assert.equal(msg.role, "user");
  assert.equal(msg.content[0].text, "继续");
  assert.equal(msg.source.kind, SELF_SOURCE);
  assert.equal(makeContinueMessage("  ").content[0].text, "继续");
  assert.ok(makeContinueMessage("继续").id.length > 0);
});

test("createState 有上限，满了淘汰最老的", () => {
  const state = createState(3, 2);
  state.slot("a");
  state.slot("b");
  state.slot("c");
  assert.equal(state.size, 3);
  state.slot("d");
  assert.equal(state.size, 2);
  assert.equal(state.get("a"), null);
  assert.equal(state.get("c")?.continues, 0);
});

test("resetBudget 清空计数", () => {
  const state = createState();
  const s = state.slot("a");
  s.continues = 5;
  s.retries = 2;
  s.stallFired = true;
  state.resetBudget(s);
  assert.equal(s.continues, 0);
  assert.equal(s.retries, 0);
  assert.equal(s.stallFired, false);
});

test("ABNORMAL_KINDS 与 dsh 真实 turn/end 原因对齐", () => {
  assert.deepEqual([...ABNORMAL_KINDS].sort(), ["aborted", "error", "interrupted", "max-tokens"]);
});

test("配置归一化：垃圾输入不炸，默认值兜住", () => {
  const c = normalizeConfig({ continueMax: "abc", stallMs: 1, backoffMs: "x", skipCodes: "auth, quota" });
  assert.equal(c.continueMax, DEFAULT_CONFIG.continueMax);
  assert.equal(c.stallMs, 1000);
  assert.deepEqual(c.backoffMs, [...DEFAULT_CONFIG.backoffMs]);
  assert.deepEqual(c.skipCodes, ["AUTH", "QUOTA"]);
  assert.equal(c.autoRetry, false);
  assert.equal(c.continueText, "继续");
});

test("配置归一化：0 是有意义的（关掉）", () => {
  const c = normalizeConfig({ continueMax: 0, retryMax: 0, hardStallMs: 0 });
  assert.equal(c.continueMax, 0);
  assert.equal(c.retryMax, 0);
  assert.equal(c.hardStallMs, 0);
});

// ---------------------------------------------------------------- 假完成

function asst(seq, step, blocks, turn = 1) {
  return {
    type: "assistant/message",
    seq,
    data: { turn, step, message: { role: "assistant", content: blocks } },
  };
}

const completedEnd = (seq, turn = 1) => ({
  type: "turn/end",
  seq,
  data: { turn, reason: { kind: "completed" } },
});

test("假完成：正文是 reasoning 的逐字节复制 + 无 tool-call → 抓到", () => {
  const body = "Let me do both on a temp dir.</｜｜DSML｜｜ parameter>";
  const sw = inspectSwallowed([
    asst(1, 138, [
      { type: "reasoning", text: body },
      { type: "text", text: body },
    ]),
    completedEnd(2),
  ]);
  assert.equal(sw.swallowed, true);
  assert.equal(sw.why, "dsml-leak");
  assert.equal(sw.step, 138);
});

test("假完成：正常收尾（正文和 reasoning 不一样）不算", () => {
  const sw = inspectSwallowed([
    asst(1, 9, [
      { type: "reasoning", text: "想清楚了" },
      { type: "text", text: "改好了，测试 43 个全过。" },
    ]),
    completedEnd(2),
  ]);
  assert.equal(sw.swallowed, false);
});

test("假完成：这一轮有 tool-call 就不算", () => {
  const body = "同一段";
  const sw = inspectSwallowed([
    asst(1, 3, [
      { type: "reasoning", text: body },
      { type: "text", text: body },
      { type: "tool-call", name: "read", arguments: "{}" },
    ]),
    completedEnd(2),
  ]);
  assert.equal(sw.swallowed, false);
});

test("假完成：只有 reasoning 没有正文 → no-output", () => {
  const sw = inspectSwallowed([
    asst(1, 10, [{ type: "reasoning", text: "Hmm, the" }]),
    completedEnd(2),
  ]);
  assert.equal(sw.swallowed, true);
  assert.equal(sw.why, "no-output");
});

test("假完成：尾部有 DSML 残片，即使没有 reasoning 块也能抓到", () => {
  const sw = inspectSwallowed([
    asst(1, 21, [{ type: "text", text: "check user-questions events.\n</｜｜DSML｜｜ calls>" }]),
    completedEnd(2),
  ]);
  assert.equal(sw.swallowed, true);
  assert.equal(sw.why, "dsml-leak");
});

test("防误伤：消息里带代码围栏的 DSML 举例不算泄漏", () => {
  const sw = inspectSwallowed([
    asst(1, 9, [
      {
        type: "text",
        text: "这个泄漏长这样：\n\n```\n</｜｜DSML｜｜ calls>\n```\n\n所以会静默停住。",
      },
    ]),
    completedEnd(1),
  ]);
  assert.equal(sw.swallowed, false);
  assert.equal(tailLooksLikeDsml("```\n</｜｜DSML｜｜ calls>\n```"), false);
  // 没有围栏的同一段尾部仍然要抓得住
  assert.equal(tailLooksLikeDsml("check events.\n</｜｜DSML｜｜ calls>"), true);
});

test("假完成：error 的 turn/end 不走这个判定（交给 ABNORMAL_KINDS）", () => {
  const body = "同一段";
  const sw = inspectSwallowed([
    asst(1, 3, [
      { type: "reasoning", text: body },
      { type: "text", text: body },
    ]),
    { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", error: { code: "NETWORK" } } } },
  ]);
  assert.equal(sw.swallowed, false);
});

test("假完成：只看最后一条 turn/end 所属的那一轮", () => {
  const body = "上一轮的残局";
  const sw = inspectSwallowed([
    asst(1, 1, [
      { type: "reasoning", text: body },
      { type: "text", text: body },
    ]),
    completedEnd(2, 1),
    asst(3, 1, [
      { type: "reasoning", text: "想清楚了" },
      { type: "text", text: "这是正常答案" },
    ], 2),
    completedEnd(4, 2),
  ]);
  assert.equal(sw.swallowed, false);
});

test("inspectStop：假完成折成 swallowed 原因，并能被 shouldAutoContinue 接管", () => {
  const body = "x</｜｜DSML｜｜ parameter>";
  const events = [
    asst(1, 5, [
      { type: "reasoning", text: body },
      { type: "text", text: body },
    ]),
    completedEnd(2),
  ];
  const stop = inspectStop(events);
  assert.equal(stop.kind, SWALLOWED_KIND);
  assert.equal(stop.abnormal, true);
  assert.equal(stop.seq, 2);
  assert.equal(shouldAutoContinue(stop.reason, cfg), true);

  const off = normalizeConfig({ continueOnSwallowed: false });
  assert.equal(shouldAutoContinue(stop.reason, off), false);
});

test("inspectStop：正常 completed 不会被误判成 swallowed", () => {
  const stop = inspectStop([
    asst(1, 2, [
      { type: "reasoning", text: "想清楚了" },
      { type: "text", text: "做完了" },
    ]),
    completedEnd(2),
  ]);
  assert.equal(stop.kind, "completed");
  assert.equal(stop.swallowed, undefined);
  assert.equal(shouldAutoContinue(stop.reason, cfg), false);
});
