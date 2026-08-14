#!/usr/bin/env node
/**
 * patch-vision.js — DSH 识图补丁引擎（幂等，可安全重复执行）
 *
 * 让纯文本模型（如 DeepSeek）也能接收图片消息：
 * - dsh-attachment / dsh-attachment-local: 暴露附件对象路径（pathOf）。
 * - dsh-llm-pi-ai: 对无 image 输入的模型，把 image 块渲染成带本地路径的文本，
 *   不再抛 UNSUPPORTED_CONTENT（配合 vision 技能的 vision.js fallback）。
 * - dsh-llm-deepseek: 同样降级渲染为占位文本。
 * - dsh-host-apiproxy: 移除 prompt 准入与模型切换时对"纯文本模型+图片"的拒绝。
 *
 * 目标：自动查找 $DSH_HOME/profiles/* 下所有包含 dsh-host-apiproxy 的
 * @deepseek-ai 目录（DSH_HOME 未设置时默认 ~/.dsh）。
 * 每次执行后自动对受影响的 5 个包做 node --check 语法校验。
 *
 * 本文件同时是 dsh-vision-skill 插件在启动时的补丁引擎（module.exports），
 * 也可作为独立脚本运行：node patch-vision.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

/** 当前 DSH 用户目录（$DSH_HOME 或默认 ~/.dsh）。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/**
 * 查找所有可修补的 @deepseek-ai 目录（存在且含 dsh-host-apiproxy）。
 * 覆盖两种布局：$DSH_HOME/profiles/node_modules/@deepseek-ai（共享/提升安装）
 * 与 $DSH_HOME/profiles/<name>/node_modules/@deepseek-ai（按 profile 安装）。
 */
function findRoots() {
  const profiles = path.join(dshHome(), "profiles");
  const roots = [];
  const seen = new Set();
  const add = (root) => {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (fs.existsSync(path.join(resolved, "dsh-host-apiproxy"))) roots.push(resolved);
  };
  if (fs.existsSync(profiles)) {
    add(path.join(profiles, "node_modules", "@deepseek-ai"));
    for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") continue;
      add(path.join(profiles, entry.name, "node_modules", "@deepseek-ai"));
    }
  }
  return roots;
}

const OPS = [
  // 1. 抽象 store: pathOf
  {
    rel: "dsh-attachment/lib/index.js",
    marker: "pathOf(ref) {",
    old: "var AttachmentStore = class extends Service {\n\tconstructor(ctx) {\n\t\tsuper(ctx, \"attachments\");\n\t}\n};\n",
    new: "var AttachmentStore = class extends Service {\n\tconstructor(ctx) {\n\t\tsuper(ctx, \"attachments\");\n\t}\n\t/**\n\t* Resolve the local filesystem path of a stored attachment reference, when\n\t* the backend exposes one. Text-only model routes render image blocks as\n\t* path text so a vision helper can read the stored bytes.\n\t* @param ref - an attachment reference previously returned by this store.\n\t* @returns the absolute path of the stored object.\n\t*/\n\tpathOf(ref) {\n\t\tthrow new AttachmentError(\"This attachment store does not expose object paths.\", \"UNSUPPORTED_CONTENT\");\n\t}\n};\n"
  },
  // 2. 本地 store: pathOf 实现
  {
    rel: "dsh-attachment-local/lib/index.js",
    marker: "return objectPath(this.root, ensureReference(ref));",
    old: "\tasync readImage(ref, signal) {\n\t\treturn readImageFile(this.root, ref, signal);\n\t}\n};\n",
    new: "\tasync readImage(ref, signal) {\n\t\treturn readImageFile(this.root, ref, signal);\n\t}\n\tpathOf(ref) {\n\t\treturn objectPath(this.root, ensureReference(ref));\n\t}\n};\n"
  },
  // 3. pi-ai: 新增"图片→路径文本"上下文构建器
  {
    rel: "dsh-llm-pi-ai/lib/index.js",
    marker: "function toTextWithImagePathsContext",
    old: "\treturn piContext(options, messages);\n}\n//#endregion\n//#region lib/types/stream.js\n",
    new: "\treturn piContext(options, messages);\n}\n/**\n* Convert a text-only model's request to pi-ai context, degrading image\n* blocks into path-carrying text so the harness vision helper (read_image →\n* vision.js fallback) can still service the image. The image is never sent\n* to the model.\n*/\nasync function toTextWithImagePathsContext(options, attachments) {\n\tconst toolNames = /* @__PURE__ */ new Map();\n\tconst messages = [];\n\tfor (const message of options.messages) {\n\t\tif (message.role === \"system\") {\n\t\t\tif (contentHasImage(message.content)) throw new LlmError(\"pi-ai cannot represent an image in an in-history system message\", \"UNSUPPORTED_CONTENT\");\n\t\t\tmessages.push({\n\t\t\t\trole: \"user\",\n\t\t\t\tcontent: flattenText(message),\n\t\t\t\ttimestamp: 0\n\t\t\t});\n\t\t\tcontinue;\n\t\t}\n\t\tif (message.role === \"assistant\") {\n\t\t\tconst assistant = toPiAssistant(message);\n\t\t\tfor (const block of assistant.content) if (block.type === \"toolCall\") toolNames.set(CallId(block.id), block.name);\n\t\t\tmessages.push(assistant);\n\t\t\tcontinue;\n\t\t}\n\t\tconst text = imagePathsText(message.content.filter((block) => block.type !== \"tool-result\"), attachments);\n\t\tconst results = message.content.filter((block) => block.type === \"tool-result\");\n\t\tif (text.length > 0 || results.length === 0) messages.push({\n\t\t\trole: \"user\",\n\t\t\tcontent: text,\n\t\t\ttimestamp: 0\n\t\t});\n\t\tfor (const result of results) messages.push({\n\t\t\trole: \"toolResult\",\n\t\t\ttoolCallId: result.toolCallId,\n\t\t\ttoolName: toolNames.get(result.toolCallId) ?? \"unknown\",\n\t\t\tcontent: [{\n\t\t\t\ttype: \"text\",\n\t\t\t\ttext: imagePathsText(result.content, attachments) || \"(no output)\"\n\t\t\t}],\n\t\t\tisError: result.isError ?? false,\n\t\t\ttimestamp: 0\n\t\t});\n\t}\n\treturn piContext(options, messages);\n}\n/** Render one image attachment as path-carrying text for a text-only model route. */\nfunction imagePathText(attachment, attachments) {\n\tconst label = attachment.name === void 0 ? \"图片附件\" : `图片附件（${attachment.name}）`;\n\treturn `[${label} ${attachment.attachmentId}，本地路径：${attachments.pathOf(attachment)}]`;\n}\n/** Flatten content to text, degrading image blocks into path-carrying text. */\nfunction imagePathsText(blocks, attachments) {\n\treturn blocks.map((block) => {\n\t\tswitch (block.type) {\n\t\t\tcase \"text\": return block.text;\n\t\t\tcase \"image\": return imagePathText(block.attachment, attachments);\n\t\t\tcase \"tool-result\": return imagePathsText(block.content, attachments);\n\t\t\tdefault: return \"\";\n\t\t}\n\t}).join(\"\");\n}\n//#endregion\n//#region lib/types/stream.js\n"
  },
  // 4. pi-ai: stream() 对纯文本模型走降级路径
  {
    rel: "dsh-llm-pi-ai/lib/index.js",
    marker: "await toTextWithImagePathsContext(options, attachments)",
    old: "\t\t\ttry {\n\t\t\t\tconst containsImage = options.messages.some((message) => contentHasImage(message.content));\n\t\t\t\tif (containsImage && !model.input.includes(\"image\")) throw new LlmError(`pi-ai model \"${model.id}\" does not support image input`, \"UNSUPPORTED_CONTENT\");\n\t\t\t\tconst attachments = containsImage ? this.config.resolveAttachments?.() : void 0;\n\t\t\t\tif (containsImage && attachments === void 0) throw new LlmError(\"pi-ai image input requires the durable attachment service\", \"UNSUPPORTED_CONTENT\");\n\t\t\t\tconst context = attachments === void 0 ? toPiContext(options) : await toPiContext(options, attachments);\n",
    new: "\t\t\ttry {\n\t\t\t\tconst containsImage = options.messages.some((message) => contentHasImage(message.content));\n\t\t\t\tconst attachments = containsImage ? this.config.resolveAttachments?.() : void 0;\n\t\t\t\tif (containsImage && attachments === void 0) throw new LlmError(\"pi-ai image input requires the durable attachment service\", \"UNSUPPORTED_CONTENT\");\n\t\t\t\tconst context = !containsImage ? toPiContext(options) : model.input.includes(\"image\") ? await toPiContext(options, attachments) : await toTextWithImagePathsContext(options, attachments);\n"
  },
  // 5. deepseek 适配器: 图片降级为占位文本而不是抛错
  {
    rel: "dsh-llm-deepseek/lib/index.js",
    marker: "function textOnly(blocks) {",
    old: "/** Reject core image content before any text-flattening path can silently erase it. */\nfunction assertTextOnly(blocks) {\n\tif (contentHasImage(blocks)) throw new LlmError(\"The DeepSeek chat-completions adapter does not support image content.\", \"UNSUPPORTED_CONTENT\");\n}\n",
    new: "/**\n* Flatten core content to text for the text-only wire, degrading image\n* blocks into an explicit placeholder instead of rejecting the whole turn:\n* the model cannot see the image, but the harness vision helper can still be\n* pointed at the referenced attachment.\n*/\nfunction textOnly(blocks) {\n\treturn blocks.map((block) => {\n\t\tif (block.type === \"text\") return block.text;\n\t\tif (block.type === \"image\") return `[image attachment ${block.attachment.attachmentId}]`;\n\t\treturn \"\";\n\t}).join(\"\");\n}\n"
  },
  // 6. deepseek 适配器: serializeMessages 使用 textOnly
  {
    rel: "dsh-llm-deepseek/lib/index.js",
    marker: "content: textOnly(message.content)",
    old: "\tfor (const message of messages) {\n\t\tassertTextOnly(message.content);\n\t\tif (message.role === \"system\") {\n\t\t\twire.push({\n\t\t\t\trole: \"system\",\n\t\t\t\tcontent: flattenText(message.content)\n\t\t\t});\n\t\t\tcontinue;\n\t\t}\n",
    new: "\tfor (const message of messages) {\n\t\tif (message.role === \"system\") {\n\t\t\twire.push({\n\t\t\t\trole: \"system\",\n\t\t\t\tcontent: textOnly(message.content)\n\t\t\t});\n\t\t\tcontinue;\n\t\t}\n"
  },
  // 7. deepseek 适配器: 用户文本
  {
    rel: "dsh-llm-deepseek/lib/index.js",
    marker: "const text = textOnly(message.content);",
    old: "\t\tconst text = flattenText(message.content);\n",
    new: "\t\tconst text = textOnly(message.content);\n"
  },
  // 8. deepseek 适配器: 工具结果文本
  {
    rel: "dsh-llm-deepseek/lib/index.js",
    marker: "content: textOnly(result.content)",
    old: "\t\t\tcontent: flattenText(result.content) || \"(no output)\"\n",
    new: "\t\t\tcontent: textOnly(result.content) || \"(no output)\"\n"
  },
  // 9. api proxy: 纯文本模型发送图片不再被拒绝
  {
    rel: "dsh-host-apiproxy/lib/index.js",
    marker: "durablePromptContent(ctx, content),",
    anchor: "\t\t\t\t\t\tconst message = createUserMessage({",
    old: "\t\t\t\t\t\tif (hasImage) {\n\t\t\t\t\t\t\tconst current = selectionFor(agent).current;\n\t\t\t\t\t\t\tconst modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);\n\t\t\t\t\t\t\tif (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes(\"image\")) return err(request, {\n\t\t\t\t\t\t\t\tcode: \"attachment-error\",\n\t\t\t\t\t\t\t\tmessage: `Model \"${current.model}\" does not support image input.`,\n\t\t\t\t\t\t\t\tdetails: { reason: \"MODEL_DOES_NOT_SUPPORT_IMAGES\" }\n\t\t\t\t\t\t\t});\n\t\t\t\t\t\t}\n",
    new: ""
  },
  // 10. api proxy: 会话已有图片时允许切到纯文本模型
  {
    rel: "dsh-host-apiproxy/lib/index.js",
    marker: "const selected = {",
    anchor: "\t\t\t\t\t\tconst selected = {",
    old: "\t\t\t\t\t\tif ([...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep].some((message) => contentHasImage(message.content)) || messagesHaveImage(found.agent.session.deriveMessages())) {\n\t\t\t\t\t\t\tconst info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model);\n\t\t\t\t\t\t\tif (info.inputModalities !== void 0 && !info.inputModalities.includes(\"image\")) return err(request, {\n\t\t\t\t\t\t\t\tcode: \"model-unavailable\",\n\t\t\t\t\t\t\t\tmessage: `Model \"${resolved.model}\" does not accept image input, but this session already contains images; select an image-capable model.`,\n\t\t\t\t\t\t\t\tdetails: {\n\t\t\t\t\t\t\t\t\tprovider,\n\t\t\t\t\t\t\t\t\tmodel\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t});\n\t\t\t\t\t\t}\n",
    new: ""
  }
];

const TOUCHED_PACKAGES = ["dsh-attachment", "dsh-attachment-local", "dsh-llm-pi-ai", "dsh-llm-deepseek", "dsh-host-apiproxy"];

/**
 * 对一个或多个 @deepseek-ai 目录执行幂等补丁 + 语法自校验。
 * @param roots - @deepseek-ai 目录列表。
 * @param options - { log?: (line: string) => void }
 * @returns { ok, patched, skipped, failed, logs: string[] }
 */
function applyPatch(roots, options = {}) {
  const logs = [];
  const log = options.log ?? ((line) => logs.push(line));
  const summary = { ok: false, patched: 0, skipped: 0, failed: 0, logs };
  let failed = false;
  for (const op of OPS) {
    for (const root of roots) {
      const file = path.join(root, op.rel);
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (error) {
        log(`READ FAIL: ${file}: ${error.message}`);
        summary.failed++;
        failed = true;
        continue;
      }
      const count = text.split(op.old).length - 1;
      if (count === 0) {
        if (text.includes(op.marker)) {
          log(`SKIP: ${file}`);
          summary.skipped++;
        } else {
          log(`MISS: ${file}`);
          summary.failed++;
          failed = true;
        }
        continue;
      }
      if (count > 1) {
        log(`AMBIGUOUS: ${file}`);
        summary.failed++;
        failed = true;
        continue;
      }
      fs.writeFileSync(file, text.replace(op.old, op.new), "utf8");
      log(`PATCHED: ${file}`);
      summary.patched++;
    }
  }
  for (const root of roots) {
    for (const pkg of TOUCHED_PACKAGES) {
      const file = path.join(root, pkg, "lib", "index.js");
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        log(`SYNTAX OK: ${file}`);
      } catch {
        log(`SYNTAX FAIL: ${file}`);
        summary.failed++;
        failed = true;
      }
    }
  }
  summary.ok = !failed;
  return summary;
}

if (require.main === module) {
  const roots = findRoots();
  if (roots.length === 0) {
    console.error("未找到可修补的 dsh profile（$DSH_HOME/profiles/*/node_modules/@deepseek-ai 且含 dsh-host-apiproxy）。请检查 DSH_HOME。");
    process.exit(1);
  }
  console.log(`目标目录: ${roots.join(", ")}`);
  const summary = applyPatch(roots);
  for (const line of summary.logs) console.log(line);
  console.log(summary.ok ? `RESULT: OK — ${summary.patched} patched, ${summary.skipped} skipped` : `RESULT: FAILED — ${summary.patched} patched, ${summary.skipped} skipped, ${summary.failed} errors`);
  process.exit(summary.ok ? 0 : 1);
}

module.exports = { applyPatch, findRoots, dshHome, OPS };
