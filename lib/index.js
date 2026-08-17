/**
 * @dsh-user/dsh-vision-solution — DSH 视觉增强方案（host 半边）
 *
 * 职责：把本包携带的两个技能注册进 ctx.skills：
 *   1. `ds-vision-skill` — 图片理解 / OCR / 文档解析的统一路由技能
 *      （vision-router.ps1 → 免费竞速池 → custom-1/2/3 → local → Windows OCR / MinerU）。
 *   2. `vision-patch` — 幂等宿主补丁技能：为「纯文本模型 + 图片」场景重打 DSH 宿主补丁。
 *
 * 技能本体（scripts / SKILL.md / patch-vision.js）全部随包分发，运行时由
 * ctx.skills.register 注册到 DSH 技能系统，resourceBase 指向包内技能目录。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 技能目录 → 注册名（目录名即技能名）。 */
const SKILL_DIRS = {
  "ds-vision-skill": join(PKG_ROOT, "skills", "ds-vision-skill"),
  "vision-patch": join(PKG_ROOT, "skills", "vision-patch"),
};

/** 从 SKILL.md frontmatter 读取 name / description。 */
function readFrontmatter(markdown) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  return meta;
}

/** 从 SKILL.md 剥掉 frontmatter 只留正文。 */
function stripFrontmatter(markdown) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  return m ? markdown.slice(m[0].length) : markdown;
}

function registerSkill(ctx, name, dir) {
  const file = join(dir, "SKILL.md");
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-vision] 读取技能文件失败：${file}（${error?.message ?? error}）`);
    raw = `# ${name}\n\n技能文件缺失：${file}`;
  }
  const meta = readFrontmatter(raw);
  const description =
    meta.description ||
    (name === "ds-vision-skill"
      ? "为纯文本推理模型补充视觉能力：图片/截图/PDF/OCR 的统一路由识别，输出标准 JSON。"
      : '重新应用或检查 DSH 的"纯文本模型可收图片"宿主补丁。');

  ctx.skills.register({
    name,
    description,
    whenToUse:
      name === "ds-vision-skill"
        ? "用户提供图片、截图、照片、图表、UI 截图、代码截图、数学题图片、扫描件、PDF 或文档，并要求描述、理解、推理、阅读、OCR、提取文字、解析图表或分析内容时。"
        : '发送图片再次被"当前模型不支持图片"拦截、或 dsh 升级/重装后需要重新打宿主补丁时。',
    source: stripFrontmatter(raw),
    resourceBase: { kind: "directory", path: dir },
    metadata: { version: "0.1.0", repository: "https://github.com/br1nosense/dsh-vision-solution" },
  });
}

export default function dshVisionSolution(ctx) {
  for (const [name, dir] of Object.entries(SKILL_DIRS)) {
    registerSkill(ctx, name, dir);
  }
  ctx.logger?.info?.(
    `[dsh-vision] 已注册技能 ${Object.keys(SKILL_DIRS).join(", ")}（目录 ${PKG_ROOT}\\skills）`
  );
  return {
    dispose() {
      // 技能注册由 ctx.skills 管理，无需额外清理。
    },
  };
}
