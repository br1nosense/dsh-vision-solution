# install.ps1 - dsh-vision-solution 一键安装脚本
# 用法: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# ASCII-only 源码。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$skillsDir = Join-Path $dshHome 'skills'

Write-Output "== dsh-vision-solution installer =="
Write-Output ("DSH home: {0}" -f $dshHome)

# 1. 复制技能目录
$skillPairs = @(
    @{ src = Join-Path $repoRoot 'skills\ds-vision-skill'; name = 'ds-vision-skill' },
    @{ src = Join-Path $repoRoot 'skills\vision-patch';   name = 'vision-patch' }
)
foreach ($p in $skillPairs) {
    $dest = Join-Path $skillsDir $p.name
    if (-not (Test-Path -LiteralPath $p.src)) {
        Write-Output ("SKIP: 源目录不存在 {0}" -f $p.src)
        continue
    }
    if (Test-Path -LiteralPath $dest) {
        Write-Output ("SKIP: 已存在 {0}（如需覆盖请先手动删除）" -f $dest)
        continue
    }
    New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null
    Copy-Item -LiteralPath $p.src -Destination $dest -Recurse
    Write-Output ("INSTALLED: {0}" -f $dest)
}

# 2. 执行宿主补丁（幂等）
$patchScript = Join-Path $skillsDir 'vision-patch\patch-vision.js'
if (Test-Path -LiteralPath $patchScript) {
    Write-Output ''
    Write-Output '== 执行宿主补丁 (patch-vision.js) =='
    node $patchScript
    if ($LASTEXITCODE -ne 0) {
        Write-Output '!! 补丁未完整应用，请把上方输出贴到仓库 Issue 排查。'
        exit $LASTEXITCODE
    }
} else {
    Write-Output '!! 未找到补丁脚本 vision-patch/patch-vision.js，跳过补丁步骤。'
}

# 3. 后续指引
Write-Output ''
Write-Output '== 安装完成 =='
Write-Output '1. 重启 dsh web 使补丁生效：在启动终端 Ctrl+C 停止后，再运行  dsh web --port 3080'
Write-Output '2. 配置视觉通道（火山方舟 doubao）：'
Write-Output ("   cd {0}" -f (Join-Path $skillsDir 'ds-vision-skill'))
Write-Output '   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -SetCustom -Slot 1 -BaseUrl "https://ark.cn-beijing.volces.com/api/coding/v3" -Key "你的ARK_KEY" -Model "doubao-seed-2.0-lite"'
Write-Output '3. 验证通道：setup.ps1 -Verify -Channel custom-1'
Write-Output '4. 之后直接向模型发图即可。'

exit 0
