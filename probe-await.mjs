import { lastTurnEnd, lastTurnAwaitsAnswer, inspectStop, lastTurnHasText } from "./lib/core.js";
const ASK = "三个要你拍板的：\n**① 同意吗？**\n回「可以」我就开始。";
const ev = (turn, text, reason) => [
  { type: "assistant/message", seq: 10, data: { turn, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } } },
  { type: "turn/end", seq: 11, data: { turn, reason } },
];
const e = ev(1, ASK, { kind: "max-tokens" });
console.log("end =", JSON.stringify(lastTurnEnd(e)?.data));
console.log("awaiting =", lastTurnAwaitsAnswer(e));
console.log("inspectStop =", JSON.stringify((({kind,seq})=>({kind,seq}))(inspectStop(e))));
