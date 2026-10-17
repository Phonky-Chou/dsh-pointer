<#
install.ps1 - 把 dsh-pointer（指代器）装进 DeepSeek Harness。

可选脚本：插件管理（插件 -> 添加插件 -> 填 GitHub 地址）是更简单的方式。
本脚本适合想用命令行、或想指定非 desktop profile 的场景。可安全重复运行。

用法：
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall

装完需要重启 DeepSeek Harness：host 与客户端包都在启动时加载。
#>
param(
    # DSH profile 名（桌面版默认 desktop）
    [string]$Profile = 'desktop',
    # 仓库目录（默认：本脚本所在目录）
    [string]$RepoDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
    # 卸载而不是安装
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$PluginName = 'dsh-pointer'

function Write-Step([string]$Message) { Write-Host ('==> ' + $Message) -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host ('    ' + $Message) -ForegroundColor DarkGray }
function Fail([string]$Message) { Write-Host ('[x] ' + $Message) -ForegroundColor Red; exit 1 }

# DSH 安装目录：读卸载注册表键，取 InstallLocation（兜底从 UninstallString 反推）
function Get-DshInstallDir {
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
            if ($key.GetValue('DisplayName') -notlike '*DeepSeek Harness*') { continue }
            $location = $key.GetValue('InstallLocation')
            if (-not $location) {
                $uninstall = [string]$key.GetValue('UninstallString')
                if ($uninstall -match '^"([^"]+)"') { $location = Split-Path -Parent $Matches[1] }
            }
            if ($location -and (Test-Path $location)) { return $location }
        }
    }
    return $null
}

$installDir = Get-DshInstallDir
if (-not $installDir) {
    Fail '未检测到 DeepSeek Harness 桌面版，请先安装并启动一次 DSH 再运行本脚本'
}
Write-Step '已检测到 DeepSeek Harness'
Write-Note ('安装目录: ' + $installDir)

$cli = Join-Path $installDir 'resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path $cli)) {
    Fail ('未找到 DSH 命令行入口: ' + $cli + '，请确认 DSH 版本 >= 0.2.0')
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ('profiles\' + $Profile)
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
    Fail ('未找到 profile "' + $Profile + '"（' + $profileDir + '）。请先启动一次 DeepSeek Harness 让它生成配置，再重跑本脚本。')
}

if ($Uninstall) {
    Write-Step ('正在从 profile "' + $Profile + '" 移除 ' + $PluginName + ' ...')
    & $cli plugin --profile $Profile remove $PluginName
    if ($LASTEXITCODE -ne 0) { Fail '移除失败，请把上面的输出发给开发者' }
    Write-Step '完成。重启 DeepSeek Harness 后生效（仓库文件不会被删除）。'
    exit 0
}

# 前置检查：仓库已包含可直接运行的产物（无需构建、无第三方依赖）
foreach ($file in @('lib\index.js', 'lib\inline.js', 'lib\client.js', 'package.json', 'cordis.patch.yml')) {
    if (-not (Test-Path (Join-Path $RepoDir $file))) {
        Fail ('仓库不完整，缺少 ' + $file + '。请确认是从 git 完整克隆的。')
    }
}

Write-Step '正在安装到 profile...'
& $cli plugin --profile $Profile add $RepoDir
if ($LASTEXITCODE -ne 0) { Fail '安装失败，请把上面的输出发给开发者' }

Write-Step '完成！请重启 DeepSeek Harness，然后：'
Write-Host ''
Write-Host '    1. 在右侧栏用「预览」方式打开任意 .html 文件' -ForegroundColor Green
Write-Host '    2. 点顶部工具栏的「◉ 指代器」' -ForegroundColor Green
Write-Host '    3. 左键点元素 / 右键拖拽框选区域，元素会变成输入框里的 chip' -ForegroundColor Green
Write-Host ''
Write-Note '如果预览头部没有「指代器」按钮，点渲染器下拉把「指代页」选上。'
