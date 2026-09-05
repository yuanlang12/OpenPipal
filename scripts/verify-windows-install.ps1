<#
.SYNOPSIS
  在 Windows 上证明"装机版就是刚打的包"（对应 macOS /release 第 3 步）。

.DESCRIPTION
  版本号相等证明不了任何事——比的是 app.asar 的 SHA-256 与打包时间。
  在装了 OpenPipal 的 Windows 机器上跑（虚拟机走 SSH 也一样）：

    powershell -NoProfile -ExecutionPolicy Bypass -File verify-windows-install.ps1 -ExpectedAsarSha256 <sha>

  <sha> 取自 Mac 上 verify-windows-release / build-windows 打印的 asar 指纹。
  不传 -ExpectedAsarSha256 只打印事实；传了且不一致以 1 退出。
#>
param(
  [string]$ExpectedAsarSha256 = '',
  [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'

if (-not $InstallDir) {
  # electron-builder 的 NSIS 默认按用户安装到 %LOCALAPPDATA%\Programs\<productName>
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\OpenPipal'),
    (Join-Path $env:LOCALAPPDATA 'Programs\openpipal'),
    (Join-Path $env:ProgramFiles 'OpenPipal')
  )
  $InstallDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'resources\app.asar') } | Select-Object -First 1
  if (-not $InstallDir) {
    Write-Output ('{"ok":false,"error":"OpenPipal is not installed in any known location","searched":' + (ConvertTo-Json $candidates -Compress) + '}')
    exit 1
  }
}

$asar = Join-Path $InstallDir 'resources\app.asar'
$exe = Join-Path $InstallDir 'OpenPipal.exe'
$hash = (Get-FileHash -Path $asar -Algorithm SHA256).Hash.ToLower()
$version = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { $null }
$facts = [ordered]@{
  ok = $true
  installDir = $InstallDir
  version = $version
  asarSha256 = $hash
  asarWrittenUtc = (Get-Item $asar).LastWriteTimeUtc.ToString('o')
  matchesExpected = $null
}
if ($ExpectedAsarSha256) {
  $facts.matchesExpected = ($hash -eq $ExpectedAsarSha256.ToLower())
}
Write-Output (ConvertTo-Json $facts -Compress)
if ($ExpectedAsarSha256 -and -not $facts.matchesExpected) { exit 1 }
exit 0
