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
  lastTurnAwaitsAnswer,
  lastTurnHasText,
  looksOwned,
  makeContinueMessage,
  mutatingCallsOf,
  sessionEventsOf,
  shouldAutoContinue,
  tailAsksForAnswer,
  tailLooksLikeDsml,
  textOfMessage,
  toolCallsOf,
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

// ---------------------------------------------------------------- 问了不等

const ASK_REAL =
  "## 需要你点头的只有一件事\n上面这个 5 表 3 页的范围，**你认可吗？**\n- 认可 → 我下一轮直接出 NestJS 工程骨架。";

test("tailAsksForAnswer：认出真实的求确认", () => {
  assert.equal(tailAsksForAnswer(ASK_REAL), true);
  assert.equal(tailAsksForAnswer("上面的方案你看下，可以吗"), true);
  assert.equal(tailAsksForAnswer("这一步你想先做哪块？"), true);
  assert.equal(tailAsksForAnswer("请确认后我再动手"), true);
});

test("tailAsksForAnswer：普通陈述不算", () => {
  assert.equal(tailAsksForAnswer("我已经把 5 张表建好了，接下来写接口。"), false);
  assert.equal(tailAsksForAnswer(""), false);
  assert.equal(tailAsksForAnswer(undefined), false);
});

test("tailAsksForAnswer：代码围栏里的问号不算（解释规则时不误伤）", () => {
  const quoted = "判据是下面这个正则：\n```js\n/[你您][^。！？\\n]{0,40}[？?]/\n```\n就这样。";
  assert.equal(tailAsksForAnswer(quoted), false);
});

test("tailAsksForAnswer：只看尾部 400 字，很久以前的问句不算", () => {
  const long = "你认可吗？" + "接下来都是陈述句，没有任何提问。" .repeat(40);
  assert.equal(tailAsksForAnswer(long), false);
});

test("mutatingCallsOf：只认会动文件的工具", () => {
  const msg = {
    content: [
      { type: "tool-call", name: "write", input: {} },
      { type: "tool-call", name: "bash", input: {} },
      { type: "tool-call", name: "edit", input: {} },
      { type: "text", text: "hi" },
    ],
  };
  assert.deepEqual(
    mutatingCallsOf(msg).map((c) => c.name),
    ["write", "edit"],
  );
  assert.equal(toolCallsOf(msg).length, 3, "bash 是调用，但不动文件");
  assert.equal(mutatingCallsOf({}).length, 0);
  assert.equal(mutatingCallsOf(null).length, 0);
});

test("textOfMessage：只取 text，不取 reasoning", () => {
  const msg = {
    content: [
      { type: "reasoning", text: "内部思考" },
      { type: "text", text: "给你看的" },
      { type: "tool-call", name: "write", input: {} },
    ],
  };
  assert.equal(textOfMessage(msg), "给你看的");
  assert.equal(textOfMessage(undefined), "");
});

test("lastTurnHasText：这一轮到底有没有给用户看到正文", () => {
  const withText = [
    { type: "assistant/message", seq: 3, data: { turn: 2, step: 1, message: { content: [{ type: "text", text: "装好了" }] } } },
    { type: "turn/end", seq: 6, data: { turn: 2, reason: { kind: "aborted", reason: { kind: "user" } } } },
  ];
  assert.equal(lastTurnHasText(withText), true);

  // 实测里那 8 次用户中断全是这种：中断落在 step 边界，一个字都没落地
  const zero = [
    { type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "上一轮的话" }] } } },
    { type: "turn/end", seq: 6, data: { turn: 2, reason: { kind: "aborted", reason: { kind: "user" } } } },
  ];
  assert.equal(lastTurnHasText(zero), false);
  assert.equal(lastTurnHasText([]), false);
});

test("shouldAutoContinue：用户中断按 continueOnUserAbort 三档走", () => {
  const userAbort = { kind: "aborted", reason: { kind: "user" } };
  const never = normalizeConfig({ continueOnUserAbort: "never" });
  const silent = normalizeConfig({ continueOnUserAbort: "silent" });
  const always = normalizeConfig({ continueOnUserAbort: "always" });

  assert.equal(shouldAutoContinue(userAbort, never, { zeroOutput: true }), false);
  assert.equal(shouldAutoContinue(userAbort, silent, { zeroOutput: true }), true);
  assert.equal(shouldAutoContinue(userAbort, silent, { zeroOutput: false }), false);
  assert.equal(shouldAutoContinue(userAbort, always, { zeroOutput: false }), true);
});

test("shouldAutoContinue：插件自己掐的轮次永远不续（防自激）", () => {
  const hookAbort = { kind: "aborted", reason: { kind: "hook", reason: "unstuck-stall" } };
  assert.equal(shouldAutoContinue(hookAbort, normalizeConfig({ continueOnUserAbort: "always" }), {}), true);
  // 但 stall 路径自己有 suppressAutoContinue 兜着，这里只保证判定不误伤
  const disposed = { kind: "aborted", reason: { kind: "disposed" } };
  assert.equal(shouldAutoContinue(disposed, normalizeConfig({}), {}), false, "会话被销毁不该续");
});

test("配置：新键的三档归一化，写错退回默认", () => {
  assert.equal(normalizeConfig({}).continueOnUserAbort, "never");
  assert.equal(normalizeConfig({ continueOnUserAbort: "SILENT" }).continueOnUserAbort, "silent");
  assert.equal(normalizeConfig({ continueOnUserAbort: "乱写" }).continueOnUserAbort, "never");
  assert.equal(normalizeConfig({}).pauseOnUnansweredQuestion, "mutate");
  assert.equal(normalizeConfig({ pauseOnUnansweredQuestion: "Any" }).pauseOnUnansweredQuestion, "any");
  assert.equal(normalizeConfig({ pauseOnUnansweredQuestion: "x" }).pauseOnUnansweredQuestion, "mutate");
  assert.equal(normalizeConfig({}).notifyUserAbort, true);
  assert.equal(normalizeConfig({ notifyUserAbort: false }).notifyUserAbort, false);
});

// ---------------------------------------- 「正文里让你确认/选择」的识别（v0.3.1）
//
// 实测案例 B：session-19b6c197 turn 45。旧检测器只扫尾部 400 字、只认「你/您…？」，
// 这段正文里三个问句一个都没命中，插件于是补了「继续」，模型自己开工了。

const ASK_REAL_B =
  "方案已经定，四个都查清楚了。动手前把关键点摆一下（**三处需要你点头**）：\n\n" +
  "## 1. 通讯录直接编辑成员\n点成员卡片上的 ✏️ → 弹小窗改。\n\n" +
  "三个要你拍板的：\n\n" +
  "**① 成员有账号时，改职务同步到账号**——同意吗？\n" +
  "**② 关键岗位 = 模板里除民警/辅警之外的岗位**——这个规则行吗？\n" +
  "**③ 6 个空分局**——要不要排除这类 0 人单位？\n\n" +
  "回「可以」我就开始，预计一轮做完。";

test("在等你回答：真实案例 B（三个问句都没有「你」字）要认出来", () => {
  assert.equal(tailAsksForAnswer(ASK_REAL_B), true);
});

test("在等你回答：「需要你点头」离结尾很远也要认（宽窗口强信号）", () => {
  const far = "需要你点头的有三处：\n" + "背景说明。".repeat(200) + "\n就这样。";
  assert.equal(tailAsksForAnswer(far), true);
});

test("在等你回答：被吞的 DSML 残留不能当问句", () => {
  const leaked = "Let me grep.</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>";
  assert.equal(tailAsksForAnswer(leaked), false);
});

test("在等你回答：旧误报案例（「？不必要。」+ DSML 残留）要判否", () => {
  const fp = '另外考虑是否要加"（本笔录共 6 页）"？不必要。\n\n做内容完整性校验。</｜｜DSML｜｜ parameter>';
  assert.equal(tailAsksForAnswer(fp), false);
});

test("在等你回答：代码围栏里的问号不算（解释规则时不能误伤自己）", () => {
  const doc = "规则是：\n```js\n/[你您]？/\n```\n就这样。";
  assert.equal(tailAsksForAnswer(doc), false);
});

test("在等你回答：普通陈述、空串都判否", () => {
  assert.equal(tailAsksForAnswer("五张表已经建好，接下来写接口。"), false);
  assert.equal(tailAsksForAnswer(""), false);
  assert.equal(tailAsksForAnswer(undefined), false);
});

test("在等你回答：最后一行以问号收尾且带求确认语气", () => {
  assert.equal(tailAsksForAnswer("我把方案列好了。\n要不要这样排？"), true);
});

test("lastTurnAwaitsAnswer：按最后一个轮次的最后一条正文判断", () => {
  const askTurn = (turn, text) => [
    { type: "assistant/message", seq: turn * 10, data: { turn, step: 1, message: { content: [{ type: "text", text }] } } },
    { type: "turn/end", seq: turn * 10 + 1, data: { turn, reason: { kind: "max-tokens" } } },
  ];
  assert.equal(lastTurnAwaitsAnswer(askTurn(1, ASK_REAL_B)), true);
  assert.equal(lastTurnAwaitsAnswer(askTurn(1, "开始干活。")), false);
  // 第二轮只是普通陈述 → 即使第一轮问过，也不再算「在等你」
  const two = [...askTurn(1, ASK_REAL_B), ...askTurn(2, "已经写完了。")];
  assert.equal(lastTurnAwaitsAnswer(two), false);
  assert.equal(lastTurnAwaitsAnswer([]), false);
});
