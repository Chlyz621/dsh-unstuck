/**
 * dsh-unstuck —— dsh 的监督员插件。
 *
 * 负责三件事：
 *   1. 轮次异常结束（报错 / 非用户中断 / 输出截断 / 崩溃残留 / **假完成**）→ 自动发「继续」
 *   2. 模型请求发出后长时间没有任何流片段（假死）→ 掐掉当前轮再续跑
 *   3. 卡在等审批 / 等回答问题 → 记录 + 通知（不代替你回答）
 *
 * 「假完成」是本机实测里最常见的断连形态，见 core.js 的 inspectSwallowed 注释。
 *
 * 设计约束（踩过的坑，别改回去）：
 *   - 续跑前必须在「真正发的那一刻」重新校验：status / inbox / 有没有真人新消息，
 *     否则会和用户手速抢，出现「用户刚发完，监督员又补一条」。
 *   - 续跑消息的 source.kind 必须是 dsh-unstuck，才能被 hasFreshHumanTurn 排除，
 *     不然自己发的消息会被当成人类输入，把预算清零后无限续跑。
 *   - 我们自己 cancel 出去的 cause 用 { kind: 'hook' }，不是 'user'，
 *     这样 isUserAbort 不会把「监督员掐的」误判成「用户按的停止」。
 *
 * 实测依据（2026-10-21，本机 41 个会话 / 140 个轮次，用 tools/diag.mjs 可复现）：
 *   completed 107、error 14、aborted 11、max-tokens 4、interrupted 1、未结束 3。
 *   其中 19 轮（13.6%）是「假完成」——轮次**正常** completed，但活儿没干：
 *   模型把工具调用写成了 DeepSeek 原生 DSML 文本，而中转站按 openai-completions
 *   协议返回，message 里只有 reasoning + text、没有 tool_calls。agent 循环看不到
 *   工具调用，就认为这一轮说完了，安静地回 idle。dsh 自带的「继续」按钮也救不了，
 *   因为 completed 属于它的 SETTLED_TURN_END_KINDS，会被 409 拒掉。
 *
 * 为什么不在源头改（把 DSML 转回 tool_calls）：dsh 的 agent 事件面里**没有**
 *   改写消息的 waterfall；agent/pre-step 的文档明确写 Model-visible content must
 *   use logged channels，不能就地改消息。所以只能在轮次结束后补一条带指向性的
 *   「继续」，让模型自己重发工具调用。
 *
 * 为什么 autoRetry 默认关：dsh-purge 的 autoRetry 默认是开的，两边都开会叠成
 *   6 次重试，反而更容易把上游打挂。要用就二选一。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import * as core from "./core.js";
import { loadConfig, resolveDshHome } from "./config.js";

export const name = "dsh-unstuck";

/** 不声明 inject：少一个服务就 pending 卡住宿主，这里纯靠事件，不需要任何服务。 */
export const inject = [];

function sessionIdOf(agent) {
  return String(agent?.id || agent?.session?.id || "");
}

export function apply(ctx, config) {
  const dshHome = resolveDshHome();
  const cfg = loadConfig(config, dshHome);

  if (!cfg.enabled) {
    console.log("[dsh-unstuck] disabled by config, nothing installed");
    return;
  }

  const logDir = path.join(dshHome, "unstuck");
  const logFile = path.join(logDir, "unstuck.jsonl");

  function rotateIfNeeded() {
    try {
      const st = fs.statSync(logFile);
      if (st.size > cfg.logMaxBytes) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      /* 文件不存在就不用轮转 */
    }
  }

  function record(level, event, extra) {
    // debug 级只在 verbose 时落盘：否则每轮都会写一条 "running"，
    // 把真正有用的 continue-sent / stall-detected 淹掉。
    if (level !== "debug" || cfg.verbose) {
      const line = JSON.stringify({
        t: new Date().toISOString(),
        level,
        event,
        ...(extra && typeof extra === "object" ? extra : {}),
      });
      try {
        fs.mkdirSync(logDir, { recursive: true });
        rotateIfNeeded();
        fs.appendFileSync(logFile, `${line}\n`);
      } catch {
        /* 日志写不进去不能影响主流程 */
      }
      const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
      console.log(`[dsh-unstuck] ${event}${suffix}`);
    }
  }

  /** 需要人知道的事：写日志 + 可选跑一条命令（比如弹 Windows 通知）。 */
  function notify(event, extra, message) {
    record("warn", event, extra);
    if (!cfg.notifyCommand) return;
    try {
      const text = String(message || event).replace(/["'`\r\n]/g, " ");
      const cmd = cfg.notifyCommand.includes("{msg}")
        ? cfg.notifyCommand.split("{msg}").join(text)
        : `${cfg.notifyCommand} ${text}`;
      spawn(cmd, { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (e) {
      record("error", "notify-command-failed", { err: String(e?.message || e) });
    }
  }

  const state = core.createState();
  const timers = new Set();
  const pendingApprovals = new Map();
  /**
   * 已经 disposed 的 agent 对象。用 WeakSet 记对象而不是记 session id：
   * 同一个 session 被 resume 出来会是一个**新的** agent 对象，不受影响；
   * 而旧对象迟到的 status 事件会被丢掉，不会对着死 agent 发 followup。
   */
  const deadAgents = new WeakSet();

  /**
   * 「问了不等」守卫。key = session id，value = { turn, step, seq, askedAt, paused }。
   * 只记「最近一次在正文里问过你」的位置，不记历史；一个轮次结束就清掉。
   * 判据在 core.tailAsksForAnswer，实测案例在它的注释里。
   */
  const questionGuard = new Map();

  /** 上一次巡检的时刻，用来识别事件循环被卡住 / 机器睡眠造成的时钟跳变。 */
  let lastTickAt = 0;

  function later(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        fn();
      } catch (e) {
        record("error", "timer-threw", { err: String(e?.message || e) });
      }
    }, Math.max(0, Number(ms) || 0));
    timers.add(timer);
    return timer;
  }

  function listen(event, handler) {
    if (typeof ctx?.on !== "function") return null;
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      try {
        return ctx.on(event, handler);
      } catch {
        return null;
      }
    }
  }

  // ---------------------------------------------------------------- 续跑

  /** 「假完成」用带指向性的措辞，普通异常用通用的「继续」。 */
  function continueTextFor(kind) {
    return kind === core.SWALLOWED_KIND ? cfg.continueTextSwallowed : cfg.continueText;
  }

  function planContinue(agent, id, info, trigger) {
    if (!cfg.autoContinue) return;
    if (!core.shouldAutoContinue(info.reason, cfg, { zeroOutput: info.zeroOutput })) {
      if (info.abnormal) {
        record("info", "continue-skipped", {
          session: id,
          trigger,
          kind: info.kind,
          code: info.code,
          why: info.userAbort ? "user-abort" : "policy",
          zeroOutput: Boolean(info.zeroOutput),
        });
        // 用户中断 + 这一轮一个字都没输出：和「界面看着卡住我按一下」无法区分，
        // 至少让你知道监督员看见了这件事，而不是默默跳过。
        if (info.userAbort && info.zeroOutput && cfg.notifyUserAbort) {
          notify(
            "user-abort-noted",
            { session: id, turn: info.turn, continues: state.get(id)?.continues ?? 0 },
            `dsh 会话 ${id.slice(0, 8)} 第 ${info.turn} 轮被停止，且一个字都没输出；` +
              `如果那是界面看着卡住了，说一句「继续」就行`,
          );
        }
      }
      return;
    }
    const s = state.slot(id);
    if (!s) return;
    if (info.seq !== 0 && s.lastContinueSeq === info.seq) return;
    if (s.continues >= cfg.continueMax) {
      notify(
        "continue-budget-exhausted",
        { session: id, kind: info.kind, code: info.code, continues: s.continues },
        `dsh 会话 ${id.slice(0, 8)} 连续中断 ${s.continues} 次，监督员已停手，需要人工看一眼`,
      );
      return;
    }
    const delay = cfg.continueDelayMs + core.backoffFor(s.continues, cfg.backoffMs);
    later(() => fireContinue(agent, id, info, trigger), delay);
  }

  /** 真正发「继续」的那一刻，把所有前置条件重新验一遍。 */
  function fireContinue(agent, id, info, trigger) {
    const s = state.slot(id);
    if (!s) return;
    if (agent.status === "running") return;
    if (core.inboxBusy(agent)) {
      record("info", "continue-deferred", { session: id, why: "inbox-busy" });
      return;
    }
    const events = core.sessionEventsOf(agent);
    if (core.hasFreshHumanTurn(events)) {
      record("info", "continue-deferred", { session: id, why: "user-took-over" });
      return;
    }
    const now = core.inspectStop(events);
    if (now.seq !== info.seq) return;
    now.zeroOutput = !core.lastTurnHasText(events);
    if (!core.shouldAutoContinue(now.reason, cfg, { zeroOutput: now.zeroOutput })) return;

    const text = continueTextFor(now.kind);
    try {
      agent.followup(core.makeContinueMessage(text, `${core.SELF_SOURCE}-${randomUUID()}`));
    } catch (e) {
      record("error", "continue-failed", { session: id, err: String(e?.message || e) });
      return;
    }
    s.continues += 1;
    s.lastContinueSeq = info.seq;
    s.lastContinueAt = Date.now();
    record("info", "continue-sent", {
      session: id,
      trigger,
      attempt: s.continues,
      kind: info.kind,
      code: info.code,
      text,
    });
  }

  // ---------------------------------------------------------------- 卡死

  function handleStall(agent, id, s, why, now) {
    const silence = now - Math.max(s.requestAt || 0, s.lastStreamAt || 0, s.runningSince || 0);
    record("warn", "stall-detected", { session: id, why, silenceMs: silence, continues: s.continues });

    if (!cfg.autoContinue) {
      notify(
        "stall-no-recovery",
        { session: id, why, silenceMs: silence },
        `dsh 会话 ${id.slice(0, 8)} 疑似卡死（${Math.round(silence / 1000)}s 无响应）`,
      );
      return;
    }
    if (s.continues >= cfg.continueMax) {
      notify(
        "stall-budget-exhausted",
        { session: id, why, silenceMs: silence, continues: s.continues },
        `dsh 会话 ${id.slice(0, 8)} 反复卡死 ${s.continues} 次，监督员已停手`,
      );
      return;
    }

    // 我们主动掐掉这一轮，会产生一条 aborted 的 turn/end，
    // 打个标记让 idle 分支别再多发一条「继续」。
    if (agent.status === "running") s.suppressAutoContinue = true;
    try {
      agent.cancel({ kind: "hook", reason: "unstuck-stall" }, { keepInbox: true });
    } catch (e) {
      record("error", "stall-cancel-failed", { session: id, err: String(e?.message || e) });
      s.suppressAutoContinue = false;
    }

    later(() => {
      try {
        if (agent.status === "running") {
          record("warn", "stall-still-running", { session: id });
          return;
        }
        if (core.inboxBusy(agent)) {
          record("info", "stall-inbox-busy", { session: id });
          return;
        }
        const events = core.sessionEventsOf(agent);
        if (core.hasFreshHumanTurn(events)) return;
        fireContinue(agent, id, core.inspectStop(events), "stall");
      } finally {
        s.stallFired = false;
      }
    }, cfg.stallResumeMs);
  }

  function tick() {
    const now = Date.now();
    const gap = lastTickAt === 0 ? 0 : now - lastTickAt;
    lastTickAt = now;
    if (!cfg.stallEnabled) return;

    /**
     * 时钟跳变防护：巡检间隔突然远超预期，说明事件循环被卡住或机器睡眠了；
     * 也可能是系统时钟被 NTP 往回校正（那时 gap 是负数）。
     * 这段时间的「静默」不是模型没响应，把它算进 silence 会把健康请求误判成卡死
     * ——醒来第一眼就掐掉一个其实正在正常生成的长请求。所以把锚点整体后移
     * （gap 为负时就是前移），让这段空档不参与计时，并且这一轮不做任何判定。
     */
    const jumpLimit = Math.max(3000, cfg.tickMs * 8);
    if (Math.abs(gap) > jumpLimit) {
      for (const [, s] of state.entries()) {
        if (s.requestAt > 0) s.requestAt += gap;
        if (s.lastStreamAt > 0) s.lastStreamAt += gap;
        if (s.runningSince > 0) s.runningSince += gap;
        if (s.lastActivityAt > 0) s.lastActivityAt += gap;
      }
      record("info", "clock-jump", { gapMs: gap, tickMs: cfg.tickMs });
      return;
    }

    for (const [id, s] of state.entries()) {
      const agent = s.agent;
      if (!agent || agent.status !== "running") continue;
      if (s.stallFired) continue;
      const anchor = Math.max(s.requestAt || 0, s.lastStreamAt || 0, s.runningSince || 0);
      if (s.requestAt > 0 && now - anchor > cfg.stallMs) {
        s.stallFired = true;
        handleStall(agent, id, s, "no-stream", now);
        continue;
      }
      if (cfg.hardStallMs > 0 && now - Math.max(s.lastActivityAt || 0, s.runningSince || 0) > cfg.hardStallMs) {
        s.stallFired = true;
        handleStall(agent, id, s, "no-activity", now);
      }
    }
  }

  // ---------------------------------------------------------------- 事件

  function onStatus(payload) {
    const agent = payload?.agent;
    if (!agent) return;
    if (deadAgents.has(agent)) return;
    const id = sessionIdOf(agent);
    if (!id) return;
    if (cfg.skipOwnedAgents && core.looksOwned(agent)) return;
    const s = state.slot(id);
    if (!s) return;
    s.agent = agent;
    const now = Date.now();
    s.lastActivityAt = now;

    if (payload.status === "running") {
      s.runningSince = now;
      s.stallFired = false;
      s.suppressAutoContinue = false;
      s.requestAt = 0;
      s.lastStreamAt = 0;
      if (core.hasFreshHumanTurn(core.sessionEventsOf(agent))) state.resetBudget(s);
      record("debug", "running", { session: id });
      return;
    }

    // idle：一轮结束了，判断要不要补一条「继续」
    s.runningSince = 0;
    s.requestAt = 0;
    const events = core.sessionEventsOf(agent);
    const info = core.inspectStop(events);
    // 这一轮有没有给你看到过任何正文（见 core.lastTurnHasText 的实测依据）
    info.zeroOutput = !core.lastTurnHasText(events);
    if (info.swallowed) {
      // 「假完成」：turn/end 写着 completed，其实工具调用被吞了、这轮没干完。
      // 注意绝不能走下面的 resetBudget 分支，否则预算永远清零 = 没有上限。
      record("warn", "turn-swallowed", {
        session: id,
        turn: info.swallowed.turn,
        step: info.swallowed.step,
        why: info.swallowed.why,
        detail: info.swallowed.detail,
        continues: s.continues,
      });
    } else if (info.kind === "completed" || info.kind === "blocked" || info.kind === "forked") {
      state.resetBudget(s);
      return;
    }
    if (s.suppressAutoContinue) {
      s.suppressAutoContinue = false;
      record("info", "continue-skipped", { session: id, trigger: "turn-end", why: "stall-already-handled" });
      return;
    }
    planContinue(agent, id, info, "turn-end");
  }

  async function onRequest(payload, next) {
    const agent = payload?.agent;
    if (agent) {
      const s = state.slot(sessionIdOf(agent));
      if (s) {
        s.agent = agent;
        const now = Date.now();
        s.requestAt = now;
        s.lastStreamAt = 0;
        s.lastActivityAt = now;
      }
    }
    return await next();
  }

  function onStream(payload) {
    const agent = payload?.agent;
    if (!agent) return;
    const s = state.slot(sessionIdOf(agent));
    if (!s) return;
    const now = Date.now();
    s.lastStreamAt = now;
    s.lastActivityAt = now;
    // AssistantStreamFrame.type: 'start' | 'chunk' | 'end'
    if (payload?.frame?.type === "end") s.requestAt = 0;
  }

  async function onRequestError(payload, next) {
    const agent = payload?.agent;
    const s = agent ? state.slot(sessionIdOf(agent)) : null;
    if (s) {
      s.requestAt = 0;
      s.lastActivityAt = Date.now();
    }
    const downstream = await next();
    if (downstream?.kind === "retry") return downstream;
    if (!cfg.autoRetry || !s) return downstream;
    if (payload?.signal?.aborted) return downstream;

    const code = String(payload?.failure?.code || "").toUpperCase();
    if (code && cfg.skipCodes.includes(code)) return downstream;

    const id = sessionIdOf(agent);
    const key = `${payload?.turn || 0}:${payload?.step || 0}:${code}`;
    if (s.retryKey === key) return downstream;
    if ((s.retries || 0) >= cfg.retryMax) return downstream;

    s.retries = (s.retries || 0) + 1;
    s.retryKey = key;
    record("info", "request-retry", {
      session: id,
      turn: payload?.turn,
      step: payload?.step,
      code,
      attempt: s.retries,
    });
    return { kind: "retry" };
  }

  function onDisposed(payload) {
    const agent = payload?.agent;
    if (agent && typeof agent === "object") deadAgents.add(agent);
    const id = sessionIdOf(agent);
    if (id) state.delete(id);
  }

  /**
   * 真人往 inbox 里塞了消息 = 用户接手了，续跑预算立刻清零。
   * 这是最可靠的「用户还活着」信号：比事后翻 session 日志早一步。
   * 只认 kind === "user"：harness 自己塞的 time-context / skill-catalog
   * 之类不算，否则预算永远被重置，等于没有上限。
   */
  function onInboxInserted(payload) {
    const agent = payload?.agent;
    if (!agent) return;
    if (!core.isHumanSourceKind(payload?.message?.source?.kind)) return;
    const s = state.get(sessionIdOf(agent));
    if (s) state.resetBudget(s);
  }

  async function onUserQuestion(request, next) {
    const id = sessionIdOf(request?.agent);
    record("info", "question-asked", { session: id });
    let timer = null;
    if (cfg.notifyBlocked) {
      timer = setTimeout(() => {
        timers.delete(timer);
        notify(
          "question-blocked",
          { session: id, waitedMs: cfg.blockedNotifyMs },
          `dsh 会话 ${id.slice(0, 8) || "?"} 在等你回答问题，已等 ${Math.round(cfg.blockedNotifyMs / 1000)}s`,
        );
      }, cfg.blockedNotifyMs);
      timers.add(timer);
    }
    try {
      return await next();
    } finally {
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    }
  }

  /**
   * 「问了不等」：正文在等你点头，模型却自己往下干。
   *
   * 实测案例（session-d54e23f7 turn 5，2026-10-22 02:07:24）：
   *   正文写「上面这个 5 表 3 页的范围，**你认可吗？**」并承诺「认可 → 我下一轮直接出…」，
   *   27 秒后**同一个轮次**里自己开始建工程，02:10:10 装完 244 个包；
   *   你在 02:10:11 按了停止，然后问「你刚刚都给我提了什么问题？」。
   *
   * 判据：核心 tailAsksForAnswer 认出「问句」→ 记位置；同轮后续 step 出现
   * 会动文件的工具调用（或 any 模式下的任何调用）→ 判为没等回答。
   * 掐掉这一轮，但不发「继续」（suppressAutoContinue），把发言权还给你。
   */
  function checkUnansweredQuestion(id, event) {
    if (cfg.pauseOnUnansweredQuestion === "off") return;
    const data = event.data || {};
    const turn = data.turn;
    const step = data.step;
    if (typeof turn !== "number") return;
    const message = data.message;

    if (core.tailAsksForAnswer(core.textOfMessage(message))) {
      questionGuard.set(id, { turn, step, seq: event.seq, askedAt: Date.now(), paused: false });
      record("debug", "question-detected", { session: id, turn, step });
      return; // 问句所在这一步本身不算「往下干」
    }

    const g = questionGuard.get(id);
    if (!g || g.turn !== turn || g.paused) return;
    if (typeof step === "number" && typeof g.step === "number" && step < g.step) return;

    const any = cfg.pauseOnUnansweredQuestion === "any";
    const calls = any ? core.toolCallsOf(message) : core.mutatingCallsOf(message);
    if (calls.length === 0) return;

    g.paused = true;
    const s = state.get(id);
    const agent = s?.agent;
    record("warn", "question-paused", {
      session: id,
      turn,
      step,
      questionSeq: g.seq,
      tools: calls.map((c) => String(c.name || "")).slice(0, 6),
    });
    notify(
      "question-paused",
      { session: id, turn, step },
      `dsh 会话 ${id.slice(0, 8)} 第 ${turn} 轮问了你问题却没等回答就往下做，已替你暂停`,
    );
    if (!agent || agent.status !== "running") return;
    if (s) s.suppressAutoContinue = true;
    try {
      agent.cancel({ kind: "hook", reason: "unstuck-unanswered-question" }, { keepInbox: true });
    } catch (e) {
      record("error", "question-pause-failed", { session: id, err: String(e?.message || e) });
    }
  }

  function onSessionEvent(session, event) {
    try {
      if (!event || typeof event !== "object") return;
      const id = String(session?.id || "");
      if (event.type === "approval/asked") {
        record("info", "approval-asked", { session: id, id: event.data?.id });
        if (!cfg.notifyBlocked) return;
        const key = `${id}:${event.data?.id}`;
        const timer = setTimeout(() => {
          pendingApprovals.delete(key);
          timers.delete(timer);
          notify(
            "approval-blocked",
            { session: id, waitedMs: cfg.blockedNotifyMs },
            `dsh 会话 ${id.slice(0, 8)} 在等你审批`,
          );
        }, cfg.blockedNotifyMs);
        pendingApprovals.set(key, timer);
        timers.add(timer);
        return;
      }
      if (event.type === "approval/decided") {
        const key = `${id}:${event.data?.id}`;
        const timer = pendingApprovals.get(key);
        if (timer) {
          clearTimeout(timer);
          timers.delete(timer);
          pendingApprovals.delete(key);
        }
        return;
      }
      if (event.type === "assistant/message") {
        checkUnansweredQuestion(id, event);
        return;
      }
      if (event.type === "user/message") {
        // 你回话了，「问了不等」这件事就结束了
        if (core.isHumanSourceKind(event.data?.source?.kind)) questionGuard.delete(id);
        return;
      }
      if (event.type === "turn/end") {
        questionGuard.delete(id);
        const s = state.get(id);
        if (s) s.lastActivityAt = Date.now();
      }
    } catch {
      /* 会话事件流里出任何岔子都不能冒泡 */
    }
  }

  // ---------------------------------------------------------------- 装配

  ctx.effect(() => {
    const offs = [
      listen("agent/status", onStatus),
      listen("agent/request", onRequest),
      listen("agent/assistant-stream", onStream),
      listen("agent/request-error", onRequestError),
      listen("agent/disposed", onDisposed),
      listen("agent/inbox/inserted", onInboxInserted),
      listen("user-questions/request", onUserQuestion),
      listen("session/event", onSessionEvent),
    ];

    const interval = setInterval(() => {
      try {
        tick();
      } catch (e) {
        record("error", "tick-threw", { err: String(e?.message || e) });
      }
    }, cfg.tickMs);
    if (typeof interval.unref === "function") interval.unref();

    record("info", "boot", {
      home: dshHome,
      autoContinue: cfg.autoContinue,
      continueOnSwallowed: cfg.continueOnSwallowed,
      continueOnUserAbort: cfg.continueOnUserAbort,
      pauseOnUnansweredQuestion: cfg.pauseOnUnansweredQuestion,
      continueMax: cfg.continueMax,
      continueText: cfg.continueText,
      stallMs: cfg.stallEnabled ? cfg.stallMs : 0,
      autoRetry: cfg.autoRetry,
      listeners: offs.filter(Boolean).length,
      configFile: path.join(logDir, "config.json"),
    });

    return () => {
      clearInterval(interval);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      pendingApprovals.clear();
      questionGuard.clear();
      for (const off of offs) {
        try {
          if (typeof off === "function") off();
        } catch {
          /* 忽略 */
        }
      }
      record("info", "dispose", {});
    };
  });
}

const plugin = { name, inject, apply };

export default plugin;
