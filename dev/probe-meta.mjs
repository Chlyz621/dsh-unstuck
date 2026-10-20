// 端到端验证：调用 dsh 自己的 readPluginMeta，看它给这个插件读出什么显示名。
// 注意：脚本必须放在 dsh 安装根目录才能 import 到 @deepseek-ai/dsh-app-boot，
// 但 parentURL 必须指向 profile 目录（插件实际被解析的位置），否则什么都解析不到。
const { readPluginMeta } = await import("@deepseek-ai/dsh-app-boot");

const parentURL = "file:///C:/Users/Administrator/.dsh/profiles/tauri/package.json";
const meta = readPluginMeta("dsh-unstuck", parentURL);

if (meta === undefined) {
  console.log("undefined —— 说明 locale/en.json 与 package.json 都没解析到");
} else {
  console.log(
    JSON.stringify(
      meta,
      (k, v) => (k === "icon" && typeof v === "string" ? `<data URL ${v.length} 字节>` : v),
      2,
    ),
  );
}
