/**
 * dsh-unstuck 纯逻辑层。
 *
 * 这一层不 import cordis，也不碰定时器/文件系统，只做「看事件、判状态、算退避」，
 * 方便 node --test 直接单测。真正的副作用都在 index.js。
 */

/** 我们自己注入的消息 source.kind，用来和「真人发的消息」区分。 */
export const SELF_SOURCE = "dsh-unstuck";

/**
 * 只有 kind === "user" 是真人打的字。
 *
 * 用白名单而不是黑名单，是因为踩过坑：一个真实会话里 user/message 的
 * source.kind 有十几种，全是 harness 自己塞的上下文 ——
 *   time-context(114) user(108) runtime-context(31) skill-catalog(31)
 *   continue(21) agent-instructions(18) goal(6) user-approval(5)
 *   plugin:* plugin:hindsight dsh-rewind tool-jobs model-selection tool-goal
 * 如果把这些当成「用户接手」，监督员就会永远判定「用户还在，别插嘴」，
 * 结果功能静默失效 —— 这比多发一条「继续」糟得多。
 */
export const HUMAN_SOURCE_KINDS = new Set(["user"]);

/**
 * 已经有人续跑过了：dsh 桌面端的「继续」按钮（kind: "continue"）、
 * 以及我们自己的续跑。看到这类消息就别再补一条，免得一轮变两条。
 *
 * "dsh-supervisor" 是本插件的旧名。改名前的会话日志里留着这种 kind，
 * 认它才不会在老会话里补出第二条「继续」。
 */
export const CONTINUE_LIKE_KINDS = new Set(["continue", SELF_SOURCE, "dsh-supervisor"]);

/** 这条消息是真人打的吗？ */
export function isHumanSourceKind(kind) {
  return HUMAN_SOURCE_KINDS.has(String(kind || ""));
}

/** 这条消息是不是「已经有人让他继续」？ */
export function isContinueLikeKind(kind) {
  return CONTINUE_LIKE_KINDS.has(String(kind || ""));
}

/** 值得自动续跑的 turn/end 原因。completed / blocked / forked 一律不动。 */
export const ABNORMAL_KINDS = ["error", "aborted", "max-tokens", "interrupted"];

/**
 * 「假完成」：turn/end 明明写着 completed，这一轮其实没干完。
 *
 * 这是本机实测到的最常见的断连形态，比 error 常见得多。真实日志（同一会话三轮）：
 *
 *   turn1 step21 | reasoning+text | reasoning === text | 无 tool-call | 尾部 "</｜｜DSML｜｜ parameter>…calls>"
 *   turn2 step138 | reasoning+text | reasoning === text | 无 tool-call | 尾部 "…temp dir.</｜｜DSML｜｜ parameter>"
 *   turn3 step10  | reasoning+text | reasoning === text | 无 tool-call | 尾部 "Hmm, the"
 *
 * 机理：模型本来要发工具调用，中转站（openai-completions 兼容层）没能把 DeepSeek 原生的
 * DSML 工具调用转成 OpenAI 的 tool_calls，于是那段标记被当成普通正文吐了出来，
 * assistant 消息里只剩 reasoning + text、没有 tool-call。
 * agent 循环认为「模型没要求调工具」= 这一轮说完了 → turn/end completed → 静默 idle。
 * 用户看到的就是「跑着跑着自己断了，得手动发一句才继续」。
 *
 * 判定不用猜：reasoning 块和 text 块**逐字节相同**是最硬的指纹
 * （本机 172 条 assistant 消息里只出现 3 次，正是被吞的 3 次，零误报）。
 */
export const SWALLOWED_KIND = "swallowed";

/**
 * 尾部像不像被截断的 DSML 标记。
 *
 * 这条是兜底规则（没有 reasoning 块可对比时才用得上），所以要防误伤：
 * 正常消息里出现 "DSML" 几乎只有一种情况 —— 人在讨论它。讨论时一定会把标记
 * 放进代码围栏里举例，而真泄漏的正文里不会有围栏。所以见到围栏就判它不是泄漏。
 */
export function tailLooksLikeDsml(text) {
  if (typeof text !== "string") return false;
  if (/```/.test(text)) return false; // 举例/引用，不是泄漏
  return /DSML[^\n]{0,40}$/.test(text.slice(-90));
}

/**
 * 这一轮是不是「假完成」。只看最后一条 turn/end 及其所属 turn 的最后一条 assistant 消息。
 * 返回 { swallowed, why, turn, step, detail }。
 *
 * 判据来自本机实测（2026-10-21，41 个会话 / 140 个轮次）：
 *   - completed 107 轮里，19 轮（13.6%）的末条 assistant 消息既没有 tool-call，
 *     也没有正常正文，形态只有两种：
 *       no-output  只写了 reasoning，正文一个字都没有（8 轮）
 *       dsml-leak  正文末尾是模型原生的 DSML 工具调用标记（11 轮）
 *   - 其余 completed 都是真的说完了（有正文、有结论），不能碰。
 * 要重新校准阈值/形态，跑 `node tools/diag.mjs --all`，它会把每个会话逐轮列出来。
 */
export function inspectSwallowed(events) {
  const list = Array.isArray(events) ? events : [];
  const none = { swallowed: false, why: "", turn: 0, step: 0, detail: "" };
  const end = lastTurnEnd(list);
  if (!end) return none;
  if (end.data?.reason?.kind !== "completed") return none;

  const turn = end.data?.turn;
  const inTurn = list.filter(
    (event) => event?.type === "assistant/message" && (turn === undefined || event.data?.turn === turn),
  );
  const last = inTurn[inTurn.length - 1];
  if (!last) return none;

  const content = Array.isArray(last.data?.message?.content) ? last.data.message.content : [];
  const hasToolCall = content.some((block) => block?.type === "tool-call");
  if (hasToolCall) return none;

  const join = (type) =>
    content
      .filter((block) => block?.type === type)
      .map((block) => String(block.text ?? ""))
      .join("");
  const reasoning = join("reasoning");
  const text = join("text");
  const base = { turn: last.data?.turn || 0, step: last.data?.step || 0 };

  // 只想了没做：有 reasoning，但一个字的正文都没有。
  if (text.trim() === "" && reasoning.trim() !== "") {
    return { swallowed: true, why: "no-output", ...base, detail: `reasoning=${reasoning.length}` };
  }
  // 最硬的指纹：正文是 reasoning 的逐字节复制。
  if (reasoning.length > 0 && text === reasoning) {
    return {
      swallowed: true,
      why: tailLooksLikeDsml(text) ? "dsml-leak" : "echo-reasoning",
      ...base,
      detail: `len=${text.length}`,
    };
  }
  // 兜底：正文本身以 DSML 残片收尾（没有 reasoning 块可对比时也能抓到）。
  if (tailLooksLikeDsml(text)) {
    return { swallowed: true, why: "dsml-leak", ...base, detail: `len=${text.length}` };
  }
  return none;
}

/**
 * 永久性失败：发「继续」也救不回来，只会白烧钱，必须人来处理。
 * 命中这些 code 时监督员只记录 + 通知，不续跑。
 */
export const PERMANENT_CODES = [
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID",
  "INVALID_REQUEST",
  "QUOTA",
  "ACCOUNT_QUOTA",
  "BILLING",
  "INSUFFICIENT_BALANCE",
  "MODEL_NOT_FOUND",
  "CONTEXT_OVERFLOW",
  "CONTEXT_LENGTH",
  "CONTEXT_WINDOW_EXCEEDED",
  "NO_ADAPTER",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
];

/** 从后往前找最后一条 turn/end。 */
export function lastTurnEnd(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === "turn/end") return list[i];
  }
  return null;
}

/** turn/end 里 aborted 的 cause 形状：字符串或 { kind }。 */
export function causeKindOf(reason) {
  const cause = reason?.reason;
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object" && typeof cause.kind === "string") return cause.kind;
  return "";
}

/** 是不是「用户自己按了停止」。这类中断绝不自动续跑，否则会跟用户抢。 */
export function isUserAbort(reason) {
  if (!reason || reason.kind !== "aborted") return false;
  const kind = causeKindOf(reason);
  return kind === "user" || kind === "cancel";
}

/**
 * 「问了不等」：正文在等你点头，模型却自己往下干。
 *
 * 实测案例（session-d54e23f7 turn 5，2026-10-22 02:07:24）：
 *   正文写「上面这个 5 表 3 页的范围，**你认可吗？**」「认可 → 我下一轮直接出…」，
 *   然后**同一个轮次**里 27 秒后就开始建工程，02:10:10 装完 244 个包。
 *   用户在 02:10:11 按停止才拦住，接着问「你刚刚都给我提了什么什么问题？」
 *
 * 判据是启发式，只看正文尾部 400 字：
 *   - 命中明确的求确认措辞，或
 *   - 有「你/您 …… ？」这样的第二人称问句
 * 代码围栏里的问号不算（解释规则时会被误伤）。
 */
export const ASK_MARKERS = [
  "你认可",
  "认可吗",
  "需要你点头",
  "你只要回",
  "确认一下",
  "你同意",
  "要我继续",
  "要不要我",
  "行不行",
  "可以吗",
  "你决定",
  "你来选",
  "告诉我一声",
  "等你回",
  "请确认",
];

export function tailAsksForAnswer(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const tail = text.slice(-400);
  if (/```/.test(tail)) return false; // 代码围栏里的问号不算
  if (ASK_MARKERS.some((m) => tail.includes(m))) return true;
  return /[你您][^。！？\n]{0,40}[？?]/.test(tail);
}

/**
 * 会动到你文件/系统的工具。shell 不算：它常常只用来读，
 * 算进来会让「问一句然后 ls 一下」被误判成开工。
 */
export const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "delete",
  "move",
  "copy",
  "apply_patch",
  "patch",
  "create_file",
  "ops_write",
  "ops_edit",
  "ops_delete",
  "ops_move",
  "str_replace_editor",
  "notebook_edit",
]);

export function toolCallsOf(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b?.type === "tool-call");
}

export function mutatingCallsOf(message) {
  return toolCallsOf(message).filter((b) => MUTATING_TOOLS.has(String(b.name || "")));
}

/** 一条 assistant 消息里的正文（不含 reasoning）。 */
export function textOfMessage(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/**
 * 最后一个轮次里，assistant 有没有给你看到过任何正文。
 *
 * 实测（本机全部会话）：8 次 turn/end = aborted{kind:'user'}，**8 次全是零输出** ——
 * 你在模型请求在飞的时候按了停止，中断在 step 边界生效，那一 step 一个字都没落地。
 * 这种「零输出的用户中断」和「界面看着卡住了我按一下」在日志里长得一模一样。
 */
export function lastTurnHasText(events) {
  const list = Array.isArray(events) ? events : [];
  const end = lastTurnEnd(list);
  if (!end) return false;
  const turn = end.data?.turn;
  const msgs = list.filter((e) => e.type === "assistant/message" && e.data?.turn === turn);
  return msgs.some((e) => textOfMessage(e.data?.message).trim().length > 0);
}

/** 失败 code，大小写无关地归一。 */
export function failureCodeOf(reason) {
  const raw = reason?.error?.code ?? reason?.failure?.code ?? reason?.code;
  return String(raw || "").toUpperCase();
}

/** 把最后一条 turn/end 折成判断用的摘要。 */
export function inspectTurn(events) {
  const end = lastTurnEnd(events);
  const reason = end?.data?.reason || null;
  return {
    seq: end?.seq || 0,
    turn: end?.data?.turn || 0,
    reason,
    kind: reason?.kind || "",
    code: failureCodeOf(reason),
    userAbort: isUserAbort(reason),
    abnormal: Boolean(reason && ABNORMAL_KINDS.includes(reason.kind)),
  };
}

/**
 * 把「异常结束」和「假完成」合成一个判断，供 onStatus 与 fireContinue 共用 ——
 * 两处必须用同一个口径，否则「该续」和「真的发」会打架。
 */
export function inspectStop(events) {
  const info = inspectTurn(events);
  const sw = inspectSwallowed(events);
  if (!sw.swallowed) return info;
  return {
    ...info,
    kind: SWALLOWED_KIND,
    abnormal: true,
    swallowed: sw,
    reason: { kind: SWALLOWED_KIND, swallowed: sw.why },
  };
}

/**
 * 该不该续跑。cfg 用 normalize 之后的形状。
 *
 * opts.zeroOutput = 这一轮 abort 之前有没有给用户看到过正文（见 lastTurnHasText）。
 * 用户中断按 cfg.continueOnUserAbort 分三档：
 *   never  —— 一律不碰（默认；用户按了停止就是停止）
 *   silent —— 只在「零输出」时补一条：这种中断和「界面看着卡住」无法区分
 *   always —— 只要不是自己掐的都续
 */
export function shouldAutoContinue(reason, cfg, opts) {
  if (!reason) return false;
  if (!cfg.continueOn.includes(reason.kind)) return false;
  const code = failureCodeOf(reason);
  if (code && cfg.skipCodes.includes(code)) return false;
  // 会话被销毁时 agent 已经不在了，续跑只会在空对象上发消息
  if (causeKindOf(reason) === "disposed") return false;
  if (isUserAbort(reason)) {
    const mode = cfg.continueOnUserAbort || "never";
    if (mode === "always") return true;
    if (mode === "silent") return opts?.zeroOutput === true;
    return false;
  }
  return true;
}

/**
 * 最后一条 turn/end 之后，有没有人已经接手了这一轮 —— 真人发话，或者
 * 别的东西已经补过一条「继续」。有的话监督员就不该再插嘴。
 *
 * 注意只认 kind === "user" 的真人消息：time-context / runtime-context /
 * skill-catalog 这些是 harness 每轮自己塞的，认错了会让续跑永远不触发。
 */
export function hasFreshHumanTurn(events) {
  const list = Array.isArray(events) ? events : [];
  const end = lastTurnEnd(list);
  const after = end ? list.filter((event) => (event?.seq || 0) > end.seq) : list;
  return after.some((event) => {
    if (event?.type !== "user/message") return false;
    const kind = event.data?.source?.kind;
    return isHumanSourceKind(kind) || isContinueLikeKind(kind);
  });
}

/**
 * inbox 里还有没排队的活（排队中就别再塞「继续」）。
 * 真实结构见 @deepseek-ai/dsh-agent 的 Inbox：nextTurn / nextStep 两个只读数组。
 */
export function inboxBusy(agent) {
  try {
    const inbox = agent?.inbox;
    if (!inbox) return false;
    if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0) return true;
    if (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return true;
    if (typeof inbox.hasPending === "function" && inbox.hasPending()) return true;
  } catch {
    /* 结构不认识就当不忙 */
  }
  return false;
}

/** 取 agent 的会话事件快照，各种实现都兜一下。 */
export function sessionEventsOf(agent) {
  const session = agent?.session;
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch {
    /* 换下一种 */
  }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch {
    /* 没有就没有 */
  }
  return [];
}

/** 子 agent（被别的 agent 托管的）默认不插手，免得跟 subagent 框架打架。 */
export function looksOwned(agent) {
  try {
    if (agent?.parent || agent?.owner || agent?.ownedBy) return true;
    const session = agent?.session;
    if (session?.parentSessionId || session?.parent) return true;
  } catch {
    /* 忽略 */
  }
  return false;
}

/** 第 n 次续跑前等多久：查表，超出就取最后一档。 */
export function backoffFor(index, table) {
  const list = Array.isArray(table) && table.length > 0 ? table : [1500];
  const i = Math.max(0, Math.min(list.length - 1, Math.trunc(Number(index) || 0)));
  const value = Number(list[i]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 续跑消息。source.kind 必须是我们自己，才能被 hasFreshHumanTurn 排除。 */
export function makeContinueMessage(text, id) {
  const body = String(text || "继续").trim() || "继续";
  return {
    id: id || `${SELF_SOURCE}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    role: "user",
    content: [{ type: "text", text: body }],
    source: {
      kind: SELF_SOURCE,
      form: "notice",
      summary: "auto-continue",
    },
  };
}

/** 每会话的监督状态。Map 插入序做 FIFO，防止长开进程无限膨胀。 */
export function createState(cap = 200, evict = 50) {
  const bySession = new Map();

  function slot(sessionId) {
    const id = String(sessionId || "");
    if (!id) return null;
    let cur = bySession.get(id);
    if (cur) return cur;
    if (bySession.size >= cap) {
      let i = 0;
      for (const key of bySession.keys()) {
        if (i >= evict) break;
        bySession.delete(key);
        i += 1;
      }
    }
    cur = {
      agent: null,
      continues: 0,
      lastContinueSeq: 0,
      lastContinueAt: 0,
      retries: 0,
      retryKey: "",
      stallFired: false,
      suppressAutoContinue: false,
      requestAt: 0,
      lastStreamAt: 0,
      runningSince: 0,
      lastActivityAt: 0,
      notified: new Set(),
    };
    bySession.set(id, cur);
    return cur;
  }

  return {
    slot,
    get(sessionId) {
      return bySession.get(String(sessionId || "")) || null;
    },
    delete(sessionId) {
      bySession.delete(String(sessionId || ""));
    },
    entries() {
      return bySession.entries();
    },
    get size() {
      return bySession.size;
    },
    resetBudget(s) {
      if (!s) return;
      s.continues = 0;
      s.lastContinueSeq = 0;
      s.retries = 0;
      s.retryKey = "";
      s.stallFired = false;
      s.suppressAutoContinue = false;
      s.notified = new Set();
    },
  };
}
