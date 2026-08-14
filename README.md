# dsh-vision-solution

**让 DeepSeek Harness (DSH) 里的纯文本模型（如 DeepSeek）也能发送并识别图片。**

本项目把两个东西整合成一个自包含方案：

1. **识图技能** — [ds-vision-skill](https://github.com/Sorwcyra/ds-vision-skill)（v0.5.1，MIT）：图片/截图/PDF/OCR 的统一路由与识别，输出标准 JSON 交给主模型继续推理。
2. **宿主补丁** — [vision-patch](https://github.com/Gingerate/dsh-vision-skill)（幂等补丁引擎）：移除 DSH 对"纯文本模型 + 图片"的拦截，让图片消息能送达到模型侧。

装上即用：**纯文本模型发图不再被拒，图片自动交给视觉 API 识别。**

---

## 为什么需要它

很多编码/推理 Agent 是纯文本模型（例如通过火山方舟托管的 DeepSeek 系列）。它们本身没有视觉能力，而且 DSH 会在两处直接拒绝图片消息：

- 发送图片时：`Model "xxx" does not support image input.`
- 切换到纯文本模型但会话已含图片时：`does not accept image input...`

本项目通过**宿主补丁**移除这两处拒绝，并把图片以"带本地路径的占位文本"（`[图片附件：xxx，本地路径：...]`）送给模型；模型据此调用识图技能里的 `vision-router.ps1`，把图片交给**火山方舟 doubao-seed-2.0-lite**（或任意 OpenAI 兼容视觉 API）识别，拿回结构化结果继续推理。

## 工作原理

```
用户发图/拖入图片/粘贴图片
        │
        ▼
DSH host (打补丁后不再拒绝)
        │  图片 → "[图片附件：xxx，本地路径：<path>]" 占位文本
        ▼
主模型（纯文本）收到路径占位
        │  调用 ds-vision-skill → scripts/vision-router.ps1
        ▼
vision-router 自动路由
  ├─ 图片理解：竞速池(agnes/glm) → custom-1/2/3 → local
  ├─ OCR：百度OCR → Windows OCR → 视觉推理
  └─ 文档解析：MinerU
        │
        ▼
视觉 API（本项目默认：火山方舟 doubao-seed-2.0-lite）
        │
        ▼
标准 JSON 信封 → 主模型阅读 result 并继续推理
```

### 降级链

```
image reasoning: race(agnes-2.5-flash, agnes-2.0-flash, glm, glm-thinking) -> custom-1 -> custom-2 -> custom-3 -> local
ocr:             baidu-ocr -> windows-ocr -> vision reasoning
document:        mineru flash -> mineru extract
```

## 特性

- ✅ 纯文本模型（DeepSeek 等）发送图片不再被"当前模型不支持图片"拦截
- ✅ 图片自动降级为本地路径占位文本，配合识图技能完成视觉理解
- ✅ 多模态模型行为完全不变，图片照常直传
- ✅ 支持火山方舟 / 任意 OpenAI 兼容视觉 API
- ✅ 宿主补丁**幂等**：可安全重复执行，每次自动 `node --check` 自校验
- ✅ 无密钥入库：API Key 通过环境变量提供

## 目录结构

```
dsh-vision-solution/
├── README.md                  # 本文档
├── LICENSE                    # MIT
├── install.ps1                # 一键安装脚本
├── skills/
│   ├── ds-vision-skill/       # 识图技能（来自 Sorwcyra/ds-vision-skill）
│   │   ├── SKILL.md           #   技能定义
│   │   ├── scripts/           #   vision-router / setup / 各通道脚本
│   │   └── references/        #   通道与基准文档
│   └── vision-patch/          # 宿主补丁技能
│       ├── SKILL.md           #   补丁检修说明
│       └── patch-vision.js    #   幂等补丁引擎
```

## 前置要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness (DSH) | `0.1.0-rc.6`（补丁锚点针对该版本） |
| Node.js | ≥ 20 |
| 操作系统 | Windows / macOS（脚本跨平台） |
| 视觉 API Key | 火山方舟（或任意 OpenAI 兼容视觉 API） |

## 快速安装

### 方式一：一键脚本（推荐）

```powershell
# 在本仓库根目录执行
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `skills/ds-vision-skill`、`skills/vision-patch` 复制到 `~/.dsh/skills/`；
2. 自动执行 `patch-vision.js` 修补 DSH 宿主；
3. 打印后续配置指引。

### 方式二：手动

```powershell
# 1. 复制技能目录
Copy-Item -Recurse .\skills\ds-vision-skill $HOME\.dsh\skills\
Copy-Item -Recurse .\skills\vision-patch  $HOME\.dsh\skills\

# 2. 执行宿主补丁（幂等，可重复）
node "$HOME\.dsh\skills\vision-patch\patch-vision.js"
```

### 重启生效

补丁需**重启 `dsh web`** 才生效：

```bash
# 在启动 dsh web 的终端按 Ctrl+C 停止，再运行：
dsh web --port 3080
```

重启后刷新页面，从会话列表恢复会话即可。

> 提示：如果以后 dsh 升级/重装导致图片拦截复现，直接对模型说 **"执行 vision-patch"**，即可重打补丁。

## 配置：火山方舟（doubao-seed-2.0-lite）

本方案默认把视觉识别交给火山方舟。按以下步骤配置 `custom-1` 通道：

```powershell
# 进入技能目录
cd $HOME\.dsh\skills\ds-vision-skill

# 配置 custom-1 通道（BaseUrl 末尾会自动补 /chat/completions）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -SetCustom `
  -Slot 1 `
  -BaseUrl "https://ark.cn-beijing.volces.com/api/coding/v3" `
  -Key "ark-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" `
  -Model "doubao-seed-2.0-lite"
```

写入的用户级环境变量：

| 变量 | 值 |
|---|---|
| `VISION_CUSTOM_1_BASE_URL` | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| `VISION_CUSTOM_1_API_KEY` | 你的火山 ark key |
| `VISION_CUSTOM_1_MODEL` | `doubao-seed-2.0-lite` |

检查状态：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -Status
# 期望看到 custom-1 [third-party slot]: configured
```

验证通道（生成测试图片并调用 doubao 识别）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -Verify -Channel custom-1
```

### 其他视觉 API（可选）

`custom-1` 是 OpenAI 兼容插槽，可指向任意视觉端点：

```powershell
scripts\setup.ps1 -SetCustom -Slot 1 -BaseUrl "https://你的服务/v1/chat/completions" -Key "KEY" -Model "视觉模型名"
```

## 使用

### 在 DSH 对话中发图

- 直接**拖入图片** / **粘贴截图** / **发送图片 URL** 均可。
- 纯文本模型会收到图片的本地路径占位，自动调用识图技能分析。

### 命令行（供技能内部使用）

```powershell
# 统一路由（推荐）
scripts\vision-router.ps1 -Path "path\to\image.png" -Prompt "分析这张图" -Intent auto -Json

# 显式 OCR
scripts\vision-router.ps1 -Path "path\to\scan.png" -Intent ocr -Json

# 文档/PDF 解析
scripts\vision-router.ps1 -Path "path\to\report.pdf" -Intent document -Json
```

### JSON 输出契约

所有脚本在 `-Json` 模式下输出同一结构：

```json
{
  "task_type": "image_reasoning | document_parsing | ocr",
  "tool_used": "custom-1:doubao-seed-2.0-lite",
  "confidence": "high | medium | low",
  "result": "识别/解析/理解的内容",
  "metadata": {}
}
```

## 验证

```powershell
# 端到端：生成测试图片并识别
$img = "$env:TEMP\test.png"
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900, 300
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.DrawString("DS Vision 测试 12345", (New-Object System.Drawing.Font("Microsoft YaHei", 48)), [System.Drawing.Brushes]::Black, 30, 90)
$g.Dispose(); $bmp.Save($img); $bmp.Dispose()

scripts\vision-router.ps1 -Path $img -Prompt "这张图里写了什么？" -Intent reason -Json
```

## 故障排查

| 现象 | 处理 |
|---|---|
| 发送图片仍被拒 | 运行 `vision-patch` 技能重打补丁，检查日志；确认已重启 `dsh web` |
| 补丁输出 `MISS` / `AMBIGUOUS` / `SYNTAX FAIL` | 当前 DSH 版本与补丁锚点（rc.6）不一致，把完整输出贴到 Issue，不要手动改文件 |
| 识图报"模型不存在 / 401" | 检查 `VISION_CUSTOM_1_API_KEY`、模型名是否正确，或换用其他视觉 API |
| 本地没网络无法调云端 | 配置 local 通道（Ollama/LM Studio/llama.cpp）或 Windows OCR |

## 兼容性 / 已知限制

- 实测环境：DSH `0.1.0-rc.6`、Node ≥ 20、Windows。
- 补丁锚点针对 rc.6 源码形态，其他版本可能出现 `MISS`（脚本只告警、绝不硬改）。
- 子智能体会话暂不支持图片（DSH 原有设计，本项目不改变）。
- 纯文本模型收到的历史图片显示为 `[image attachment ...]` 占位文本。
- 云端通道会把图片内容发送给对应服务商，敏感内容请优先用本地通道。

## 隐私与安全

- 本仓库**不含任何 API Key**；密钥一律通过环境变量提供。
- 请勿把 `.env` 或真实 key 提交到任何仓库。
- 若怀疑 Key 泄露，请立即到对应平台吊销并更换。

## 许可与致谢

- 识图技能 [Sorwcyra/ds-vision-skill](https://github.com/Sorwcyra/ds-vision-skill)（MIT）
- 宿主补丁灵感与引擎 [Gingerate/dsh-vision-skill](https://github.com/Gingerate/dsh-vision-skill)（MIT）
- 本项目整体以 **MIT** 许可发布，见 [LICENSE](./LICENSE)。
