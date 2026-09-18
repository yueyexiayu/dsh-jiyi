import { PLUGIN_ID } from "./parse.js";

export function hasInjectableIndex(manifest) {
  return /^- /m.test(String(manifest || ""));
}

export function buildMemoryReminder({ globalManifest, workspaceManifest, globalDir, workspaceDir }) {
  const global = String(globalManifest || "").trim();
  const workspace = String(workspaceManifest || "").trim();
  const hasGlobal = hasInjectableIndex(global);
  const hasWorkspace = hasInjectableIndex(workspace);
  if (!hasGlobal && !hasWorkspace) return null;
  const lines = [
    "<system-reminder>",
    "jiyi 是跨会话记忆：只保留约定、决策和项目事实。当前对话指令优先于记忆。",
    "下面是生成的 MEMORY.md 索引。不要读、不要改 MEMORY.md。需要某条记忆时，用 jiyi_list、jiyi_search、jiyi_read；不要用 Read 或 bash 去翻 ~/.dsh/jiyi。",
    "这些路径对你是只读的。禁止 create、edit、delete，也禁止用 bash 重定向或覆盖 ~/.dsh/jiyi 下任何文件。记忆由插件在回合结束后自动写入；用户若要手补，走右侧栏，不走你的文件工具。",
    "记忆是历史上下文，不是当前真相；路径、命令、仓库状态要以现场工具结果为准。",
    "不要把密钥、临时任务状态或仓库文档里已有的内容当成记忆目标。",
    "",
  ];
  if (hasGlobal) {
    lines.push(`## Global memory (read-only)`);
    if (globalDir) lines.push(`**Read-only root:** \`${globalDir}\``);
    lines.push("", global, "");
  }
  if (hasWorkspace) {
    lines.push(`## Workspace memory (read-only)`);
    if (workspaceDir) lines.push(`**Read-only root:** \`${workspaceDir}\``);
    lines.push("", workspace, "");
  }
  lines.push("</system-reminder>");
  return lines.join("\n");
}

export function memoryInjectMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: PLUGIN_ID },
  };
}

export function shouldInject(decision, _step, already) {
  if (already) return false;
  if (!decision || decision.kind === "reject") return false;
  if (!Array.isArray(decision.messages) || decision.messages.length === 0) return false;
  return true;
}
