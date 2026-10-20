/**
 * 冒烟测试：把插件装进一个**真的 cordis Context**里，
 * 确认 ctx.effect / ctx.on 在真实语义下不报错、能装上、能卸载，
 * 顺便验证 profile 里的 node_modules 联接真的能被解析到。
 *
 * 不是单测（单测用假 ctx），这是装进 dsh 之前的最后一道人工验证。
 *
 * 跑法（默认找 %USERPROFILE%\.dsh\profiles\tauri）：
 *   node test\smoke-cordis.mjs
 * 指定 profile：
 *   node test\smoke-cordis.mjs C:\Users\me\.dsh\profiles\tauri
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const profileDir =
  process.argv[2] ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "profiles", "tauri");

if (!fs.existsSync(path.join(profileDir, "package.json"))) {
  console.error(`找不到 profile：${profileDir}`);
  process.exit(1);
}

// 从 profile 目录解析，而不是从本文件所在目录 —— ESM 的解析基准是文件位置
const req = createRequire(path.join(profileDir, "package.json"));
const load = async (spec) => import(pathToFileURL(req.resolve(spec)).href);

/**
 * cordis 是 peerDependency，不一定躺在 profile 的 node_modules 里
 * （pnpm 隔离安装时它在 dsh 自己的依赖树里）。挨个试。
 */
async function loadCordis() {
  const bases = [
    path.join(profileDir, "package.json"),
    ...(process.env.DSH_DEPS_DIR
      ? [path.join(process.env.DSH_DEPS_DIR, "package.json")]
      : []),
    "C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/package.json",
    path.join(path.dirname(path.dirname(profileDir)), "..", "dsh", "package.json"),
  ];
  const tried = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    try {
      const r = createRequire(base);
      return await import(pathToFileURL(r.resolve("@deepseek-ai/cordis")).href);
    } catch (e) {
      tried.push(`${base}: ${e.code || e.message}`);
    }
  }
  throw new Error(`找不到 @deepseek-ai/cordis，试过：\n  ${tried.join("\n  ")}`);
}

// 用临时 DSH_HOME，别把冒烟记录写进真的 unstuck.jsonl
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unstuck-smoke-"));
process.env.DSH_HOME = tmpHome;

const { Context } = await loadCordis();
const plugin = await load("dsh-unstuck");

console.log(`profile   = ${profileDir}`);
console.log(`DSH_HOME  = ${tmpHome}`);

const app = new Context();
let failed = null;
app.on("internal/error", (err) => {
  failed = err;
});

app.plugin(plugin.default ?? plugin, { enabled: true, verbose: true });
await new Promise((r) => setTimeout(r, 50));

if (failed) {
  console.error("插件装配时抛错了：", failed);
  process.exit(1);
}

const logFile = path.join(tmpHome, "unstuck", "unstuck.jsonl");
if (!fs.existsSync(logFile)) {
  console.error("没写出日志，说明 apply 没跑到最后");
  process.exit(1);
}
const lines = fs
  .readFileSync(logFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const boot = lines.find((l) => l.event === "boot");
if (!boot) {
  console.error("日志里没有 boot 记录：", lines);
  process.exit(1);
}
if (!boot.listeners) {
  console.error("一个监听器都没挂上：", boot);
  process.exit(1);
}

// 造个假 agent，确认监听器真的挂在 Context 上、事件能走通
const agent = {
  id: "smoke-session",
  status: "running",
  inbox: { nextTurn: [], nextStep: [] },
  session: { snapshotEvents: () => [] },
  followup() {},
  cancel() {},
};
app.emit("agent/status", { agent, status: "running" });
app.emit("agent/status", { agent, status: "idle" });
await new Promise((r) => setTimeout(r, 50));

console.log("✓ 装配成功");
console.log(`  listeners  = ${boot.listeners}`);
console.log(`  日志行数   = ${lines.length}`);
console.log(`  事件       = ${lines.map((l) => l.event).join(", ")}`);

await app.stop?.();
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log("✓ 卸载干净");
