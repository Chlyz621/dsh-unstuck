/**
 * dsh-unstuck 配置：默认值 + 归一化 + 用户覆盖文件。
 *
 * 三层覆盖（后者赢）：内置默认 → cordis.patch.yml 里的 config → <dshHome>/unstuck/config.json
 * 这样调参不用改 patch、不用重启也能改文件后等下次 apply。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ABNORMAL_KINDS, PERMANENT_CODES, SWALLOWED_KIND } from "./core.js";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  verbose: false,

  // ---- 轮次续跑 ----
  /** 总开关：turn 异常结束时自动发一条「继续」。 */
  autoContinue: true,
  /** 每个 turn 最多自动续跑几次，用完就停手并记录。 */
  continueMax: 3,
  /** 续跑时发出去的内容。 */
  continueText: "继续",
  /**
   * 「假完成」时发的措辞。比单纯的「继续」多一点指向性：
   * 上一轮是工具调用没发出去（不是没想清楚），直接让它重新发工具调用，
   * 能显著提高一次就救回来的概率。
   */
  continueTextSwallowed: "继续。你上一条消息里的工具调用没有正常发出，请直接重新发起工具调用，不要重复解释。",
  /** 发现异常后先等一下，让 turn/end 落盘、避免和用户手速抢。 */
  continueDelayMs: 700,
  /** 第 1/2/3… 次续跑前的额外等待，防止把上游打爆。 */
  backoffMs: [1500, 5000, 15000],
  /** 只在这些 turn/end 原因上续跑。 */
  continueOn: [...ABNORMAL_KINDS],
  /**
   * 「假完成」也续跑：turn/end 写着 completed，但那一轮其实没干完
   * （reasoning 被复制成正文、工具调用被中转站吞成文本 → 静默 idle）。
   * 这是实测里最常见的断连形态，默认开。
   */
  continueOnSwallowed: true,
  /**
   * 用户按了停止（turn/end = aborted{kind:'user'}）怎么办。
   *   "never"  —— 一律不碰。默认值：你按停止就是停止。
   *   "silent" —— 只在「这一轮一个字都没输出」时补一条。
   *              实测 8 次用户中断全是零输出，和「界面看着卡住我按一下」无法区分。
   *   "always" —— 只要不是监督员自己掐的都续（不建议：会和你的停止抢）。
   */
  continueOnUserAbort: "never",
  /** 用户中断被跳过时是否额外提醒一次（只在零输出时提醒）。 */
  notifyUserAbort: true,
  /**
   * 「问了不等」：正文在等你点头，模型却自己往下干 → 掐掉这一轮，等你回答。
   *   "off"    —— 不管。
   *   "mutate" —— 只有在它开始动文件（write/edit/delete/apply_patch…）时才掐。默认。
   *   "any"    —— 问完只要还有下一步动作（含 shell）就掐。
   * 实测案例见 core.js 的 tailAsksForAnswer 注释。
   */
  pauseOnUnansweredQuestion: "mutate",
  /** 命中这些失败 code 就不续跑（发了也没用，还会烧钱）。 */
  skipCodes: [...PERMANENT_CODES],

  // ---- 模型请求重试 ----
  /**
   * 默认关闭：dsh-purge 的 autoRetry 已经在做同一件事，
   * 两边都开会叠成 6 次重试。purge 没开时再打开这个。
   */
  autoRetry: false,
  retryMax: 2,

  // ---- 卡死检测 ----
  /** 模型请求发出后长时间没有任何流片段 → 判定卡死，掐掉重来。 */
  stallEnabled: true,
  /** 多久没有流片段算卡死（毫秒）。默认 3 分钟。 */
  stallMs: 180000,
  /** 掐掉卡死的那一轮之后，等多久再补「继续」（给 abort 落盘留时间）。 */
  stallResumeMs: 800,
  /** 巡检间隔。 */
  tickMs: 15000,
  /**
   * 整轮（含工具执行）完全没有任何事件的兜底阈值，0 = 关闭。
   * 默认关，因为 `pnpm install` 这类长工具本来就很久没事件。
   */
  hardStallMs: 0,

  // ---- 阻塞提醒 ----
  /** 卡在等审批 / 等回答时，多久提醒一次。 */
  notifyBlocked: true,
  blockedNotifyMs: 120000,

  // ---- 通知 ----
  /** 额外执行的命令，{msg} 会被替换成消息正文。留空则只写日志。 */
  notifyCommand: "",
  /** 日志超过这个大小就轮转成 .1。 */
  logMaxBytes: 5 * 1024 * 1024,

  // ---- 其它 ----
  /** 子 agent（被托管）默认不插手。 */
  skipOwnedAgents: true,
});

export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value !== false && value !== 0 && value !== "false";
}

/** 三档开关：只接受白名单里的字面量，写错就退回默认。 */
export function asEnum(value, fallback, allowed) {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

export function asStringList(value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v || "").trim()).filter(Boolean);
    return list.length > 0 ? list : [...fallback];
  }
  if (typeof value === "string" && value.trim()) {
    const list = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return list.length > 0 ? list : [...fallback];
  }
  return [...fallback];
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_CONFIG;
  const backoff = Array.isArray(src.backoffMs)
    ? src.backoffMs.map((v) => clampInt(v, 0, 0, 600000))
    : [...d.backoffMs];
  return {
    enabled: asBool(src.enabled, d.enabled),
    verbose: asBool(src.verbose, d.verbose),

    autoContinue: asBool(src.autoContinue, d.autoContinue),
    continueMax: clampInt(src.continueMax, d.continueMax, 0, 50),
    continueText: typeof src.continueText === "string" && src.continueText.trim()
      ? src.continueText.trim()
      : d.continueText,
    continueTextSwallowed:
      typeof src.continueTextSwallowed === "string" && src.continueTextSwallowed.trim()
        ? src.continueTextSwallowed.trim()
        : d.continueTextSwallowed,
    continueDelayMs: clampInt(src.continueDelayMs, d.continueDelayMs, 0, 600000),
    backoffMs: backoff.length > 0 ? backoff : [...d.backoffMs],
    continueOn: (() => {
      const list = asStringList(src.continueOn, d.continueOn);
      const onSwallowed = asBool(src.continueOnSwallowed, d.continueOnSwallowed);
      if (!onSwallowed) return list.filter((k) => k !== SWALLOWED_KIND);
      return list.includes(SWALLOWED_KIND) ? list : [...list, SWALLOWED_KIND];
    })(),
    continueOnSwallowed: asBool(src.continueOnSwallowed, d.continueOnSwallowed),
    continueOnUserAbort: asEnum(src.continueOnUserAbort, d.continueOnUserAbort, ["never", "silent", "always"]),
    notifyUserAbort: asBool(src.notifyUserAbort, d.notifyUserAbort),
    pauseOnUnansweredQuestion: asEnum(src.pauseOnUnansweredQuestion, d.pauseOnUnansweredQuestion, [
      "off",
      "mutate",
      "any",
    ]),
    skipCodes: asStringList(src.skipCodes, d.skipCodes).map((c) => c.toUpperCase()),

    autoRetry: asBool(src.autoRetry, d.autoRetry),
    retryMax: clampInt(src.retryMax, d.retryMax, 0, 20),

    stallEnabled: asBool(src.stallEnabled, d.stallEnabled),
    stallMs: clampInt(src.stallMs, d.stallMs, 1000, 6 * 3600 * 1000),
    stallResumeMs: clampInt(src.stallResumeMs, d.stallResumeMs, 0, 60000),
    tickMs: clampInt(src.tickMs, d.tickMs, 1000, 600000),
    hardStallMs: clampInt(src.hardStallMs, d.hardStallMs, 0, 24 * 3600 * 1000),

    notifyBlocked: asBool(src.notifyBlocked, d.notifyBlocked),
    blockedNotifyMs: clampInt(src.blockedNotifyMs, d.blockedNotifyMs, 5000, 24 * 3600 * 1000),

    notifyCommand: typeof src.notifyCommand === "string" ? src.notifyCommand.trim() : d.notifyCommand,
    logMaxBytes: clampInt(src.logMaxBytes, d.logMaxBytes, 65536, 512 * 1024 * 1024),

    skipOwnedAgents: asBool(src.skipOwnedAgents, d.skipOwnedAgents),
  };
}

/** $DSH_HOME，找不到就退回 ~/.dsh。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  const home = os.homedir();
  const direct = path.join(home, ".dsh");
  try {
    if (fs.existsSync(direct)) return direct;
  } catch {
    /* 忽略 */
  }
  return direct;
}

export function userConfigPath(dshHome) {
  return path.join(dshHome, "unstuck", "config.json");
}

/** 读用户覆盖配置；坏了就当没有，不要让监督员自己把 dsh 拖死。 */
export function readUserConfig(dshHome) {
  try {
    const fp = userConfigPath(dshHome);
    if (!fs.existsSync(fp)) return {};
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 插件 config + 用户文件 → 最终配置。 */
export function loadConfig(pluginConfig, dshHome) {
  return normalizeConfig({ ...DEFAULT_CONFIG, ...(pluginConfig || {}), ...readUserConfig(dshHome) });
}
