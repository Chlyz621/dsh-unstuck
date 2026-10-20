#Requires -Version 7.0
<#
.SYNOPSIS
    把 dsh-unstuck 从 profile 里卸掉。

.DESCRIPTION
    撤销 install.ps1 做的三件事（备份 package.json）：
      1. 从 dsh.profile.bundles 移除 dsh-unstuck
      2. 从 dependencies 移除 dsh-unstuck
      3. 删掉 node_modules 里的联接
    插件本体留在 plugins 目录，加 -Purge 才一起删。

.EXAMPLE
    pwsh -File .\uninstall.ps1
    pwsh -File .\uninstall.ps1 -Purge
#>
[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$Profile = 'tauri',
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'
$dst = Join-Path $DshHome 'plugins\dsh-unstuck'

if (-not (Test-Path $pkgPath)) {
    throw "找不到 $pkgPath。"
}

Write-Step "从 profile 里移除"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-uninstall-$stamp" -Force
Write-Ok "备份 package.json → package.json.bak-uninstall-$stamp"

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json

if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
    $bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne 'dsh-unstuck' }
    $pkg.dsh.profile.bundles = @($bundles)
    Write-Ok "bundles 里剩 $($bundles.Count) 个"
}
if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties['dsh-unstuck']) {
    $pkg.dependencies.PSObject.Properties.Remove('dsh-unstuck')
    Write-Ok "依赖已移除"
}

$pkg | ConvertTo-Json -Depth 40 | Set-Content -Path $pkgPath -Encoding utf8 -NoNewline
Write-Ok "已写回 $pkgPath"

Write-Step "删除联接"
$link = Join-Path $profileDir 'node_modules\dsh-unstuck'
if (Test-Path $link) {
    $info = Get-Item $link -Force
    if ($info.LinkType -in @('Junction', 'SymbolicLink')) {
        Remove-Item $link -Force
        Write-Ok "已删除 $link"
    }
    else {
        Write-Warn2 "$link 不是联接，没动它（可能是 pnpm 装的，用 pnpm remove 处理）。"
    }
}
else {
    Write-Ok "没有联接，跳过"
}

if ($Purge) {
    Write-Step "删除插件文件"
    if (Test-Path $dst) {
        Remove-Item $dst -Recurse -Force
        Write-Ok "已删除 $dst"
    }
    $cfg = Join-Path $DshHome 'unstuck\config.json'
    if (Test-Path $cfg) {
        Write-Warn2 "配置和日志保留在 $(Join-Path $DshHome 'unstuck')，要清就自己删。"
    }
}

Write-Step "完成"
Write-Host "    完全退出并重开 DeepSeek Harness 生效。" -ForegroundColor Gray
