import { lastTurnEnd, lastTurnAwaitsAnswer, tailAsksForAnswer, textOfMessage } from "./lib/core.js";
const ASK = "三个要你拍板的：\n**① 同意吗？**\n回「可以」我就开始。";
const ev = [
  { type: "assistant/message", seq: 10, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: ASK }] } } },
  { type: "turn/end", seq: 11, data: { turn: 1, reason: { kind: "max-tokens" } } },
];
console.log("lastTurnEnd =", JSON.stringify(lastTurnEnd(ev)));
console.log("tail =", tailAsksForAnswer(ASK));
console.log("textOf =", JSON.stringify(textOfMessage(ev[0].data.message)));
console.log("awaits =", lastTurnAwaitsAnswer(ev));
