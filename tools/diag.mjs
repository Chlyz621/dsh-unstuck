#!/usr/bin/env node
/**
 * 断连体检：扫 <DSH_HOME>/sessions 下所有会话日志，报告每一轮到底是怎么结束的。
 *
 * 用法：
 *   node tools/diag.mjs                  # 扫全部会话，只列有问题的
 *   node tools/diag.mjs --all            # 连正常的轮次也列
 *   node tools/diag.mjs --home C:\x\.dsh # 指定 DSH_HOME
 *   node tools/diag.mjs --limit 20       # 只看最近 20 个会话
 *
 * 判据和插件运行时用的是同一份代码（lib/core.js 的 inspectSwallowed），
 * 所以这里看到的和 unstuck.jsonl 里记的是同一件事。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { inspectSwallowed, lastTurnEnd } from "../lib/core.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const flag = (name) => process.argv.includes(`--${name}`);

function resolveHome() {
  const explicit = arg("home", "");
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(os.homedir(), ".dsh");
}

function readEvents(file) {
  const raw = fs.readFileSync(file);
  let text;
  try {
    text = zlib.zstdDecompressSync(raw).toString("utf8");
  } catch {
    text = raw.toString("utf8");
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 把事件按 turn 切开，逐轮判定。 */
function auditSession(events) {
  const turns = new Map();
  for (const event of events) {
    const turn = event?.data?.turn;
    if (turn === undefined) continue;
    if (!turns.has(turn)) turns.set(turn, []);
    turns.get(turn).push(event);
  }

  const rows = [];
  for (const [turn, list] of [...turns.entries()].sort((a, b) => a[0] - b[0])) {
    const end = lastTurnEnd(list);
    const kind = end?.data?.reason?.kind || "(未结束)";
    // 整条会话的事件一起喂进去，让 inspectSwallowed 自己找最后一条 turn/end
    const upto = events.filter((event) => (event?.seq || 0) <= (end?.seq || 0));
    const sw = inspectSwallowed(upto);
    const steps = list.filter((event) => event?.type === "step/start").length;
    rows.push({
      turn,
      kind,
      steps,
      swallowed: sw.swallowed,
      why: sw.why,
      step: sw.step,
      detail: sw.detail,
      time: end?.time ? new Date(end.time).toISOString().replace("T", " ").slice(0, 19) : "",
      seq: end?.seq || 0,
    });
  }
  return rows;
}

function main() {
  const home = resolveHome();
  const sessionsRoot = path.join(home, "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    console.error(`找不到会话目录：${sessionsRoot}`);
    process.exit(1);
  }

  const files = [];
  for (const workspace of fs.readdirSync(sessionsRoot)) {
    const wsPath = path.join(sessionsRoot, workspace);
    let stat;
    try {
      stat = fs.statSync(wsPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const session of fs.readdirSync(wsPath)) {
      const file = path.join(wsPath, session, "session.v4.jsonl.zstd");
      if (!fs.existsSync(file)) continue;
      files.push({ file, workspace, session, mtime: fs.statSync(file).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const limit = Number(arg("limit", "0")) || 0;
  const picked = limit > 0 ? files.slice(0, limit) : files;

  let totalTurns = 0;
  let totalSwallowed = 0;
  const byKind = new Map();
  const byWhy = new Map();
  const hits = [];

  for (const entry of picked) {
    let events;
    try {
      events = readEvents(entry.file);
    } catch (e) {
      console.error(`读不了 ${entry.file}: ${e?.message || e}`);
      continue;
    }
    const rows = auditSession(events);
    if (rows.length === 0) continue;
    const bad = rows.filter((row) => row.swallowed);
    totalTurns += rows.length;
    totalSwallowed += bad.length;
    for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) || 0) + 1);
    for (const row of bad) byWhy.set(row.why, (byWhy.get(row.why) || 0) + 1);
    if (bad.length > 0) hits.push({ entry, rows, bad });
  }

  // ---- 报告 ----
  console.log(`DSH_HOME : ${home}`);
  console.log(`扫描会话 : ${picked.length} 个（共 ${files.length} 个）`);
  console.log(`总轮次   : ${totalTurns}`);
  const pct = totalTurns > 0 ? ((totalSwallowed / totalTurns) * 100).toFixed(1) : "0.0";
  console.log(`假完成   : ${totalSwallowed} 轮（${pct}%）`);
  if (byKind.size > 0) {
    console.log(
      `结束原因 : ${[...byKind.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}`,
    );
  }
  if (byWhy.size > 0) {
    console.log(
      `假完成类型: ${[...byWhy.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}`,
    );
  }

  if (hits.length === 0) {
    console.log("\n没发现「假完成」的轮次。");
    return;
  }

  console.log("\n有问题的会话：");
  for (const { entry, rows, bad } of hits) {
    const name = `${entry.workspace.slice(0, 34)} / ${entry.session.slice(0, 12)}`;
    console.log(`\n  ${name}   ${bad.length}/${rows.length} 轮被吞`);
    for (const row of flag("all") ? rows : bad) {
      const mark = row.swallowed ? "✗" : " ";
      console.log(
        `    ${mark} turn ${String(row.turn).padStart(2)} | ${String(row.steps).padStart(3)} 步 | ${row.kind.padEnd(12)} | ${row.time}` +
          (row.swallowed ? ` | ${row.why} (step ${row.step}, ${row.detail})` : ""),
      );
    }
  }
}

main();
