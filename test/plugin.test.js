/**
 * 用假 ctx / 假 agent 跑一遍真实的事件流，确认「该续的时候续、不该续的时候闭嘴」。
 * 这里不加载 cordis，只模拟它的事件语义（emit / waterfall / effect）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 临时 DSH_HOME，免得读到用户真实配置、也别往人家目录里写日志。 */
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sup-test-"));
  process.env.DSH_HOME = dir;
  return dir;
}

function createFakeCtx() {
  const listeners = new Map();
  const disposers = [];
  return {
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {
        const cur = listeners.get(name) ?? [];
        const i = cur.indexOf(handler);
        if (i >= 0) cur.splice(i, 1);
      };
    },
    effect(setup) {
      const d = setup();
      if (typeof d === "function") disposers.push(d);
      return d;
    },
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    },
    async waterfall(name, ...args) {
      const list = [...(listeners.get(name) ?? [])];
      let i = -1;
      const next = async () => {
        i += 1;
        if (i < list.length) return await list[i](...args, next);
        return undefined;
      };
      return await next();
    },
    listenerCount(name) {
      return (listeners.get(name) ?? []).length;
    },
    async disposeAll() {
      while (disposers.length > 0) {
        const d = disposers.pop();
        try {
          await d();
        } catch {
          /* 忽略 */
        }
      }
    },
  };
}

function createAgent(id, events = []) {
  const agent = {
    id,
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    events,
    sent: [],
    cancels: [],
    session: {
      snapshotEvents: () => agent.events,
    },
    followup(message) {
      agent.sent.push(message);
      agent.status = "running";
    },
    cancel(cause, options) {
      agent.cancels.push({ cause, options });
      agent.status = "idle";
    },
  };
  return agent;
}

function turnEnd(seq, reason) {
  return { type: "turn/end", seq, data: { turn: 1, reason } };
}

/** 每个用例一套干净的插件实例。 */
function boot(overrides = {}) {
  makeHome();
  const ctx = createFakeCtx();
  apply(ctx, {
    continueDelayMs: 0,
    backoffMs: [0],
    stallEnabled: false,
    tickMs: 60000,
    notifyCommand: "",
    ...overrides,
  });
  return ctx;
}

test("报错结束 → 自动补一条「继续」", async () => {
  const ctx = boot();
  const agent = createAgent("s1", [turnEnd(5, { kind: "error", error: { code: "NETWORK" } })]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 1);
  assert.equal(agent.sent[0].content[0].text, "继续");
  assert.equal(agent.sent[0].source.kind, "dsh-unstuck");
  await ctx.disposeAll();
});

test("正常跑完 → 一句话都不说", async () => {
  const ctx = boot();
  const agent = createAgent("s2", [turnEnd(5, { kind: "completed" })]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

function asstMessage(seq, step, blocks, turn = 1) {
  return {
    type: "assistant/message",
    seq,
    data: { turn, step, message: { role: "assistant", content: blocks } },
  };
}

test("假完成（工具调用被吞成正文）→ 自动补一条「继续」", async () => {
  const ctx = boot();
  const body = "Let me do both on a temp dir.</｜｜DSML｜｜ parameter>";
  const agent = createAgent("s2b", [
    asstMessage(4, 138, [
      { type: "reasoning", text: body },
      { type: "text", text: body },
    ]),
    turnEnd(5, { kind: "completed" }),
  ]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 1, "completed 但被吞，也要续");
  assert.equal(agent.sent[0].source.kind, "dsh-unstuck");
  await ctx.disposeAll();
});

test("假完成也吃预算上限：continueMax=1 时连吞两次只续一次", async () => {
  const ctx = boot({ continueMax: 1 });
  const body = "同一段</｜｜DSML｜｜ parameter>";
  const swallowed = (a, b) => [
    asstMessage(a, 1, [
      { type: "reasoning", text: body },
      { type: "text", text: body },
    ]),
    turnEnd(a + 1, { kind: "completed" }),
  ];
  const agent = createAgent("s2c", swallowed(4, 5));

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 1);

  agent.events = [...swallowed(4, 5), ...swallowed(8, 9)];
  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 1, "预算用完就不该再续");
  await ctx.disposeAll();
});

test("关掉 continueOnSwallowed → 假完成不再插手", async () => {
  const ctx = boot({ continueOnSwallowed: false });
  const body = "同一段</｜｜DSML｜｜ parameter>";
  const agent = createAgent("s2d", [
    asstMessage(4, 1, [
      { type: "reasoning", text: body },
      { type: "text", text: body },
    ]),
    turnEnd(5, { kind: "completed" }),
  ]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("用户自己按停止 → 不续（不能跟人抢）", async () => {
  const ctx = boot();
  const agent = createAgent("s3", [turnEnd(5, { kind: "aborted", reason: { kind: "user" } })]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("鉴权类永久失败 → 不续，白烧钱没意义", async () => {
  const ctx = boot();
  const agent = createAgent("s4", [turnEnd(5, { kind: "error", error: { code: "AUTH" } })]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("截断 / 崩溃残留 → 续", async () => {
  const ctx = boot();
  const agent = createAgent("s5", [turnEnd(5, { kind: "max-tokens" })]);
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 1);

  const agent2 = createAgent("s6", [turnEnd(7, { kind: "interrupted" })]);
  ctx.emit("agent/status", { agent: agent2, status: "idle" });
  await wait(20);
  assert.equal(agent2.sent.length, 1);
  await ctx.disposeAll();
});

test("用户已经自己发了消息 → 监督员不插嘴", async () => {
  const ctx = boot();
  const agent = createAgent("s7", [
    turnEnd(5, { kind: "error", error: { code: "NETWORK" } }),
    { type: "user/message", seq: 6, data: { source: { kind: "user" } } },
  ]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("inbox 里还有排队的活 → 先让别人跑", async () => {
  const ctx = boot();
  const agent = createAgent("s8", [turnEnd(5, { kind: "error", error: { code: "NETWORK" } })]);
  agent.inbox.nextTurn.push({ id: "queued" });

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("同一轮只续一次（同一个 seq 不重复触发）", async () => {
  const ctx = boot();
  const agent = createAgent("s9", [turnEnd(5, { kind: "error", error: { code: "NETWORK" } })]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 1);

  // 同一份日志再抖一次 idle，不该再发
  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 1);
  await ctx.disposeAll();
});

test("连续失败会耗尽预算，然后停手", async () => {
  const ctx = boot({ continueMax: 2 });
  const agent = createAgent("s10", [turnEnd(1, { kind: "error", error: { code: "NETWORK" } })]);

  for (let i = 0; i < 4; i += 1) {
    agent.events = [turnEnd(1 + i * 2, { kind: "error", error: { code: "NETWORK" } })];
    agent.status = "idle";
    ctx.emit("agent/status", { agent, status: "idle" });
    await wait(20);
  }

  assert.equal(agent.sent.length, 2);
  await ctx.disposeAll();
});

test("用户接手后预算重新长回来", async () => {
  const ctx = boot({ continueMax: 1 });
  const agent = createAgent("s11", [turnEnd(1, { kind: "error", error: { code: "NETWORK" } })]);

  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 1);

  // 用户自己发了一条 → 预算清零
  ctx.emit("agent/inbox/inserted", { agent, message: { source: { kind: "user" } } });

  agent.events = [turnEnd(3, { kind: "error", error: { code: "NETWORK" } })];
  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 2);
  await ctx.disposeAll();
});

test("自己发的消息不能给自己续命（预算不被自己清零）", async () => {
  const ctx = boot({ continueMax: 1 });
  const agent = createAgent("s12", [turnEnd(1, { kind: "error", error: { code: "NETWORK" } })]);

  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 1);

  // 模拟 followup 触发的 inbox 事件，kind 是我们自己
  ctx.emit("agent/inbox/inserted", { agent, message: { source: { kind: "dsh-unstuck" } } });

  agent.events = [turnEnd(3, { kind: "error", error: { code: "NETWORK" } })];
  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 1);
  await ctx.disposeAll();
});

test("harness 塞的上下文不会把预算清零（否则等于没有上限）", async () => {
  const ctx = boot({ continueMax: 1 });
  const agent = createAgent("s12b", [turnEnd(1, { kind: "error", error: { code: "NETWORK" } })]);

  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(900);
  assert.equal(agent.sent.length, 1, "第一次异常要续");

  // 每轮 harness 都会塞 time-context / runtime-context / skill-catalog，
  // 这些绝不能重置预算，否则 continueMax 形同虚设
  for (const kind of ["time-context", "runtime-context", "skill-catalog", "agent-instructions"]) {
    ctx.emit("agent/inbox/inserted", { agent, message: { source: { kind } } });
  }

  agent.events = [turnEnd(3, { kind: "error", error: { code: "NETWORK" } })];
  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(900);

  assert.equal(agent.sent.length, 1, "预算 1 用完了，不该再续");
  await ctx.disposeAll();
});

test("request-error 瀑布：默认不动，开了 autoRetry 才接管", async () => {
  const ctx = boot();
  const agent = createAgent("s13", []);
  const payload = {
    agent,
    turn: 1,
    step: 1,
    provider: "p",
    failure: { code: "NETWORK", message: "boom" },
    signal: new AbortController().signal,
  };
  assert.equal(await ctx.waterfall("agent/request-error", payload), undefined);
  await ctx.disposeAll();

  const ctx2 = boot({ autoRetry: true, retryMax: 2 });
  const agent2 = createAgent("s14", []);
  const payload2 = { ...payload, agent: agent2 };
  assert.deepEqual(await ctx2.waterfall("agent/request-error", payload2), { kind: "retry" });
  // 同一个 turn:step:code 只接管一次，避免无限重试
  assert.equal(await ctx2.waterfall("agent/request-error", payload2), undefined);
  await ctx2.disposeAll();
});

test("request-error 瀑布：永久错误和用户中断不重试", async () => {
  const ctx = boot({ autoRetry: true });
  const agent = createAgent("s15", []);
  const base = { agent, turn: 1, step: 1, provider: "p", signal: new AbortController().signal };

  assert.equal(await ctx.waterfall("agent/request-error", { ...base, failure: { code: "AUTH" } }), undefined);

  const ac = new AbortController();
  ac.abort();
  assert.equal(await ctx.waterfall("agent/request-error", { ...base, failure: { code: "NETWORK" }, signal: ac.signal }), undefined);
  await ctx.disposeAll();
});

test("卡死：请求发出后一直没有流 → 掐掉当前轮再补「继续」", async () => {
  const STALL_MS = 1500;
  const ctx = boot({ stallEnabled: true, stallMs: STALL_MS, tickMs: 20, stallResumeMs: 0 });
  const agent = createAgent("s16", [turnEnd(1, { kind: "error", error: { code: "NETWORK" } })]);
  agent.status = "running";

  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("agent/request", { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({}));

  // 负向断言必须自证「确实是在阈值之前观察到的」。
  // 事件循环被卡住时，wait() 的定时器和 20ms 巡检定时器会同时到期，
  // Node 按到期时间先跑巡检 → 直接判定超时掐掉 → 这里就会误报失败。
  const t0 = Date.now();
  await wait(400);
  const elapsed = Date.now() - t0;
  if (elapsed < STALL_MS) {
    assert.equal(agent.cancels.length, 0, "还没到阈值不该动手");
  }

  await wait(STALL_MS + 200);
  assert.equal(agent.cancels.length, 1, "超过阈值应该掐掉");
  assert.equal(agent.cancels[0].cause.kind, "hook", "cause 必须是 hook，不能冒充用户中断");
  assert.equal(agent.cancels[0].options.keepInbox, true, "排队的活要留着");

  await wait(80);
  assert.equal(agent.sent.length, 1, "掐掉之后应该补一条继续");
  await ctx.disposeAll();
});

test("卡死：在跑长工具（没有请求在飞）不会被误判", async () => {
  const ctx = boot({ stallEnabled: true, stallMs: 1000, tickMs: 20, stallResumeMs: 0 });
  const agent = createAgent("s18", []);
  agent.status = "running";
  ctx.emit("agent/status", { agent, status: "running" });

  await wait(1200);
  assert.equal(agent.cancels.length, 0);
  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("user-questions 卡住时只记录，不替用户回答", async () => {
  const ctx = boot({ blockedNotifyMs: 5000 });
  const agent = createAgent("s19", []);
  const answer = { answers: [] };

  const result = await ctx.waterfall("user-questions/request", { questions: [], agent }, async () => answer);
  assert.deepEqual(result, answer);
  await ctx.disposeAll();
});

test("审批事件只是记录，不产生副作用", async () => {
  const ctx = boot();
  ctx.emit("session/event", { id: "s20" }, { type: "approval/asked", data: { id: "a1", toolName: "bash" } });
  ctx.emit("session/event", { id: "s20" }, { type: "approval/decided", data: { id: "a1", outcome: "allowed-once" } });
  // 乱序/畸形事件不能炸
  ctx.emit("session/event", { id: "s20" }, { type: "approval/decided", data: { id: "nope" } });
  ctx.emit("session/event", null, null);
  await ctx.disposeAll();
});

test("子 agent 不插手", async () => {
  const ctx = boot();
  const agent = createAgent("s21", [turnEnd(1, { kind: "error", error: { code: "NETWORK" } })]);
  agent.parent = { id: "root" };

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("agent/disposed 之后不再跟踪", async () => {
  const ctx = boot();
  const agent = createAgent("s22", [turnEnd(1, { kind: "error", error: { code: "NETWORK" } })]);
  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("agent/disposed", { agent });
  agent.status = "idle";
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("装配了预期的事件监听，dispose 后全部卸载", async () => {
  const ctx = boot();
  for (const name of [
    "agent/status",
    "agent/request",
    "agent/assistant-stream",
    "agent/request-error",
    "agent/disposed",
    "agent/inbox/inserted",
    "user-questions/request",
    "session/event",
  ]) {
    assert.equal(ctx.listenerCount(name), 1, `缺少监听 ${name}`);
  }
  await ctx.disposeAll();
  for (const name of ["agent/status", "agent/request", "user-questions/request"]) {
    assert.equal(ctx.listenerCount(name), 0, `${name} 没卸载`);
  }
});

test("enabled=false 时完全不装配", async () => {
  makeHome();
  const ctx = createFakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(ctx.listenerCount("agent/status"), 0);
  await ctx.disposeAll();
});

// ---------------------------------------------------------------- 问了不等

const ASK_BODY =
  "## 需要你点头的只有一件事\n上面这个 5 表 3 页的范围，**你认可吗？**\n- 认可 → 我下一轮直接出工程骨架。";

test("问了不等：问完不等人回答就动文件 → 掐掉这一轮，且不自动续跑", async () => {
  const ctx = boot({ pauseOnUnansweredQuestion: "mutate" });
  const agent = createAgent("s30", []);
  agent.status = "running";
  const session = { id: "s30" };

  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("session/event", session, asstMessage(10, 1, [{ type: "text", text: ASK_BODY }]));
  assert.equal(agent.cancels.length, 0, "只是问了一句，不该动手");

  ctx.emit("session/event", session, asstMessage(11, 2, [{ type: "tool-call", name: "write", input: {} }]));
  assert.equal(agent.cancels.length, 1, "问完就去写文件，要掐");
  assert.equal(agent.cancels[0].cause.kind, "hook", "不能冒充用户中断");
  assert.equal(agent.cancels[0].options.keepInbox, true);

  // 掐完 agent 回 idle，监督员不能顺手补「继续」把发言权抢回去
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 0, "问了不等之后不该自动续跑");
  await ctx.disposeAll();
});

test("问了不等：问完只是读文件（不动文件）不掐", async () => {
  const ctx = boot({ pauseOnUnansweredQuestion: "mutate" });
  const agent = createAgent("s31", []);
  agent.status = "running";
  const session = { id: "s31" };

  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("session/event", session, asstMessage(10, 1, [{ type: "text", text: ASK_BODY }]));
  ctx.emit("session/event", session, asstMessage(11, 2, [{ type: "tool-call", name: "bash", input: {} }]));
  assert.equal(agent.cancels.length, 0, "读一下不算开工");
  await ctx.disposeAll();
});

test("问了不等：any 模式下连只读命令也掐", async () => {
  const ctx = boot({ pauseOnUnansweredQuestion: "any" });
  const agent = createAgent("s32", []);
  agent.status = "running";
  const session = { id: "s32" };

  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("session/event", session, asstMessage(10, 1, [{ type: "text", text: ASK_BODY }]));
  ctx.emit("session/event", session, asstMessage(11, 2, [{ type: "tool-call", name: "bash", input: {} }]));
  assert.equal(agent.cancels.length, 1);
  await ctx.disposeAll();
});

test("问了不等：off 模式完全不管", async () => {
  const ctx = boot({ pauseOnUnansweredQuestion: "off" });
  const agent = createAgent("s33", []);
  agent.status = "running";
  const session = { id: "s33" };

  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("session/event", session, asstMessage(10, 1, [{ type: "text", text: ASK_BODY }]));
  ctx.emit("session/event", session, asstMessage(11, 2, [{ type: "tool-call", name: "write", input: {} }]));
  assert.equal(agent.cancels.length, 0);
  await ctx.disposeAll();
});

test("问了不等：你回话之后就不算「没等」", async () => {
  const ctx = boot({ pauseOnUnansweredQuestion: "mutate" });
  const agent = createAgent("s34", []);
  agent.status = "running";
  const session = { id: "s34" };

  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("session/event", session, asstMessage(10, 1, [{ type: "text", text: ASK_BODY }]));
  ctx.emit("session/event", session, {
    type: "user/message",
    seq: 11,
    data: { id: "u1", role: "user", content: [{ type: "text", text: "认可" }], source: { kind: "user" } },
  });
  ctx.emit("session/event", session, asstMessage(12, 2, [{ type: "tool-call", name: "write", input: {} }]));
  assert.equal(agent.cancels.length, 0, "你已经点头了，它往下做是对的");
  await ctx.disposeAll();
});

test("问了不等：上一轮的提问不会跨轮误伤", async () => {
  const ctx = boot({ pauseOnUnansweredQuestion: "mutate" });
  const agent = createAgent("s35", []);
  agent.status = "running";
  const session = { id: "s35" };

  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("session/event", session, asstMessage(10, 1, [{ type: "text", text: ASK_BODY }], 1));
  ctx.emit("session/event", session, { type: "turn/end", seq: 11, data: { turn: 1, reason: { kind: "completed" } } });
  ctx.emit("session/event", session, asstMessage(12, 1, [{ type: "tool-call", name: "write", input: {} }], 2));
  assert.equal(agent.cancels.length, 0);
  await ctx.disposeAll();
});

// ---------------------------------------------------------------- 用户中断

const ABORTED_BY_USER = (seq, turn) => ({
  type: "turn/end",
  seq,
  data: { turn, reason: { kind: "aborted", reason: { kind: "user" } } },
});

test("用户中断 + 默认 never → 不续跑，只记一笔", async () => {
  const home = makeHome();
  const ctx = createFakeCtx();
  apply(ctx, { continueDelayMs: 0, backoffMs: [0], stallEnabled: false, tickMs: 60000 });
  const agent = createAgent("s36", [ABORTED_BY_USER(6, 2)]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 0, "你按了停止就是停止");
  await ctx.disposeAll();

  const lines = fs
    .readFileSync(path.join(home, "unstuck", "unstuck.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const skipped = lines.find((l) => l.event === "continue-skipped" && l.why === "user-abort");
  assert.ok(skipped, "要留下 user-abort 记录");
  assert.equal(skipped.zeroOutput, true, "这一轮一个字都没输出");
  assert.ok(
    lines.some((l) => l.event === "user-abort-noted"),
    "零输出的用户中断要额外提醒一次（可能就是界面看着卡住）",
  );
});

test("用户中断但已经出过正文 + never → 不续也不提醒", async () => {
  const home = makeHome();
  const ctx = createFakeCtx();
  apply(ctx, { continueDelayMs: 0, backoffMs: [0], stallEnabled: false, tickMs: 60000 });
  const agent = createAgent("s37", [
    asstMessage(4, 1, [{ type: "text", text: "我已经把依赖装好了，接下来写建表 SQL。" }], 2),
    ABORTED_BY_USER(6, 2),
  ]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();

  const lines = fs
    .readFileSync(path.join(home, "unstuck", "unstuck.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(!lines.some((l) => l.event === "user-abort-noted"), "出过正文就是你自己叫停，不用吵你");
});

test("用户中断 + continueOnUserAbort=silent → 只在零输出时补一条「继续」", async () => {
  const ctx = boot({ continueOnUserAbort: "silent" });
  const agent = createAgent("s38", [ABORTED_BY_USER(6, 2)]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);

  assert.equal(agent.sent.length, 1);
  assert.equal(agent.sent[0].content[0].text, "继续");
  assert.equal(agent.sent[0].source.kind, "dsh-unstuck");
  await ctx.disposeAll();
});

test("用户中断 + silent 但已经出过正文 → 不续", async () => {
  const ctx = boot({ continueOnUserAbort: "silent" });
  const agent = createAgent("s39", [
    asstMessage(4, 1, [{ type: "text", text: "我先把表建好。" }], 2),
    ABORTED_BY_USER(6, 2),
  ]);

  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  assert.equal(agent.sent.length, 0);
  await ctx.disposeAll();
});

test("日志文件真的写出来了", async () => {  const home = makeHome();
  const ctx = createFakeCtx();
  apply(ctx, { continueDelayMs: 0, backoffMs: [0], stallEnabled: false, tickMs: 60000 });
  const agent = createAgent("s23", [turnEnd(1, { kind: "error", error: { code: "NETWORK" } })]);
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(20);
  await ctx.disposeAll();

  const logFile = path.join(home, "unstuck", "unstuck.jsonl");
  assert.equal(fs.existsSync(logFile), true);
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.event === "boot"));
  assert.ok(lines.some((l) => l.event === "continue-sent"));
});

test("时钟跳变：机器睡眠/事件循环被卡后，不把健康请求误判成卡死", async () => {
  // 注意：cfg.tickMs 会被 clamp 到最小 1000，所以这里的等待必须长于 1 秒。
  const home = makeHome();
  const ctx = createFakeCtx();
  apply(ctx, {
    continueDelayMs: 0,
    backoffMs: [0],
    stallEnabled: true,
    stallMs: 1500,
    tickMs: 1000,
    stallResumeMs: 0,
  });
  const agent = createAgent("s24", []);
  agent.status = "running";
  ctx.emit("agent/status", { agent, status: "running" });
  ctx.emit("agent/request", { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({}));

  await wait(1100); // 第一次巡检，建立 lastTickAt；此时静默还没到 1500
  assert.equal(agent.cancels.length, 0, "第一轮巡检不该动手");

  // 假装睡了一分钟。没有防护的话，下一轮巡检会看到「静默 60 秒」直接掐掉，
  // 而实际上模型可能一直在正常生成——只是机器合盖了。
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60_000;
    await wait(1100); // 这一轮巡检必须只搬锚点、不判定
  } finally {
    Date.now = realNow;
  }

  assert.equal(agent.cancels.length, 0, "时钟跳变不该被当成卡死");

  await ctx.disposeAll();

  const logFile = path.join(home, "unstuck", "unstuck.jsonl");
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.event === "clock-jump"), "应该留下 clock-jump 记录");
});

// ------------------------------------------------ 正文里让你确认/选择就别续跑
//
// 用户 m01897 原话：「他可能没给我弹问题，只是让我在那确定、选择，让我自己输。
// 这种情况下你就直接继续，我就没空输他让我选的内容。」
// 实测案例 B（session-19b6c197 turn 45）的正文原文，旧检测器对它返回 false。

const ASK_BODY_B =
  "方案已经定，四个都查清楚了。动手前把关键点摆一下（**三处需要你点头**）：\n\n" +
  "## 1. 通讯录直接编辑成员\n点成员卡片上的 ✏️ → 弹小窗改。\n\n" +
  "三个要你拍板的：\n\n" +
  "**① 成员有账号时，改职务同步到账号**——同意吗？\n" +
  "**② 关键岗位 = 模板里除民警/辅警之外的岗位**——这个规则行吗？\n" +
  "**③ 6 个空分局**——要不要排除这类 0 人单位？\n\n" +
  "回「可以」我就开始，预计一轮做完。";

test("正文里让你确认 → 不补「继续」（旧版会补，模型就自己开工了）", async () => {
  const home = makeHome();
  const ctx = createFakeCtx();
  apply(ctx, { continueDelayMs: 0, backoffMs: [0], stallEnabled: false, tickMs: 60000, respectPendingQuestion: true });
  const agent = createAgent("s40", [
    asstMessage(10, 1, [{ type: "text", text: ASK_BODY_B }]),
    turnEnd(11, { kind: "max-tokens" }),
  ]);
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(30);

  assert.equal(agent.sent.length, 0, "它在等你拍板，不能替你做决定");

  await ctx.disposeAll();
  const logFile = path.join(home, "unstuck", "unstuck.jsonl");
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(
    lines.some((l) => l.event === "continue-skipped" && l.why === "awaiting-answer"),
    "应该留下 awaiting-answer 记录",
  );
});

test("正文里让你确认 → 关掉 respectPendingQuestion 就照旧续（对照组）", async () => {
  const ctx = boot({ respectPendingQuestion: false });
  const agent = createAgent("s41", [
    asstMessage(10, 1, [{ type: "text", text: ASK_BODY_B }]),
    turnEnd(11, { kind: "max-tokens" }),
  ]);
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(30);

  assert.equal(agent.sent.length, 1, "关掉开关后行为回到旧版");
  await ctx.disposeAll();
});

test("只是陈述、没让你回答 → 照旧续（别把正常续跑也拦了）", async () => {
  const ctx = boot({ respectPendingQuestion: true });
  const agent = createAgent("s42", [
    asstMessage(10, 1, [{ type: "text", text: "五张表已经建好，接下来写接口。" }]),
    turnEnd(11, { kind: "max-tokens" }),
  ]);
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(30);

  assert.equal(agent.sent.length, 1, "没有求确认的话就该续");
  await ctx.disposeAll();
});

test("等你回话之后你回了 → 不再算「在等你」", async () => {
  const ctx = boot({ respectPendingQuestion: true });
  const agent = createAgent("s43", [
    asstMessage(10, 1, [{ type: "text", text: ASK_BODY_B }]),
    turnEnd(11, { kind: "max-tokens" }),
    {
      type: "user/message",
      seq: 12,
      data: { turn: 2, message: { role: "user", content: [{ type: "text", text: "可以" }] }, source: { kind: "user" } },
    },
    asstMessage(20, 1, [{ type: "text", text: "开始动手。" }], 2),
    { type: "turn/end", seq: 21, data: { turn: 2, reason: { kind: "max-tokens" } } },
  ]);
  ctx.emit("agent/status", { agent, status: "idle" });
  await wait(30);

  assert.equal(agent.sent.length, 1, "你已经回过话了，该续就续");
  await ctx.disposeAll();
});
