---
name: vision-patch
description: 重新应用或检查 DSH 的"纯文本模型可收图片"宿主补丁。当发送图片再次被"当前模型不支持图片"拦截、或 dsh 升级/重装后需要重新打补丁时使用。运行本技能资源目录下的幂等脚本 patch-vision.js 并验证结果。
---

# DSH 识图补丁（vision-patch）

这个技能修补 DSH 宿主端，让**纯文本模型**（如 DeepSeek 纯文本模型）也能接收图片消息：图片以"带本地路径的占位文本"形式送达模型，模型再按已安装的 `ds-vision-skill` 流程（vision-router.ps1 → 视觉 API）完成识图。多模态模型不受影响。

## 执行流程（先检查，再决定，不要臆断）

1. **先检查补丁是否已应用**（不要直接改文件）。DSH 核心包位于 `$DSH_HOME/profiles/node_modules/@deepseek-ai/`（未设置 DSH_HOME 时为 `~/.dsh/profiles/node_modules/@deepseek-ai/`）：
   - 在 `dsh-llm-pi-ai/lib/index.js` 中搜索 `toTextWithImagePathsContext`；
   - 在 `dsh-host-apiproxy/lib/index.js` 中搜索 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
   - **若两处都符合**（已含 `toTextWithImagePathsContext` 且不再含 `MODEL_DOES_NOT_SUPPORT_IMAGES`）：说明补丁已生效，**不要执行任何修改**，直接告诉用户"补丁已是最新状态，无需操作"并结束。

2. **若检查发现补丁未应用**（或用户明确要求重新执行）：运行本技能资源目录（见 `<skill_resources>` 的 Base directory）下的幂等补丁脚本：

   ```bash
   node "<base目录>/patch-vision.js"
   ```

   脚本会自动查找 `$DSH_HOME/profiles/*` 下所有包含 `dsh-host-apiproxy` 的 `@deepseek-ai` 目录，逐个幂等修补并做语法自校验，输出 `PATCHED` / `SKIP` / `SYNTAX OK` 等。**若出现 `MISS` / `AMBIGUOUS` / `SYNTAX FAIL` 且退出码非 0**：把完整输出原样报告给用户，不要手动编辑任何文件，不要强行继续（通常是 dsh 版本与补丁实测版本 0.1.0-rc.6 不一致，需到补丁来源仓库反馈）。

3. **执行后验证**：再次运行第 1 步的两处检查，确认补丁标记已就位。

4. **完成提醒**：补丁需**重启 `dsh web` 才生效**——在启动它的终端按 Ctrl+C 停止，再运行 `dsh web`（如 `dsh web --port 3080`）。重启后从会话列表恢复，即可在纯文本模型下发送图片。

## 规则

- 只通过脚本修改这 5 个包的文件：`dsh-attachment`、`dsh-attachment-local`、`dsh-llm-pi-ai`、`dsh-llm-deepseek`、`dsh-host-apiproxy`，不碰其他任何文件。
- 脚本幂等：无论执行多少次，结果一致；补丁已应用时全部显示 SKIP。
- 一切以脚本输出为准，不要手动编辑 lib 文件。
