# Copy the files a lab PC needs into office-dist.
# GitHub Pages still uses the repo root. Do not run this on the lab PC.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dest = Join-Path $root 'office-dist'

function Copy-RootFile {
  param([string]$Name)

  $from = Join-Path $root $Name
  if (-not (Test-Path -LiteralPath $from)) {
    throw "Missing $Name"
  }
  Copy-Item -LiteralPath $from -Destination (Join-Path $dest $Name) -Force
}

function Copy-RuntimeFolder {
  param([string]$Name)

  $from = Join-Path $root $Name
  if (-not (Test-Path -LiteralPath $from)) {
    throw "Missing $Name"
  }
  Copy-Item -LiteralPath $from -Destination (Join-Path $dest $Name) -Recurse -Force
}

if (Test-Path -LiteralPath $dest) {
  Remove-Item -LiteralPath $dest -Recurse -Force
}
New-Item -ItemType Directory -Path $dest | Out-Null

Copy-RootFile 'mcr_console.bat'
Copy-RootFile 'start-local.ps1'
Copy-RootFile 'index.html'
Copy-RootFile 'join.html'
Copy-RootFile 'README.txt'
Copy-RuntimeFolder 'src'
Copy-RuntimeFolder 'vendor'

$guideFrom = Join-Path $root 'pack-office-guide.txt'
if (-not (Test-Path -LiteralPath $guideFrom)) {
  throw 'Missing pack-office-guide.txt'
}
Copy-Item -LiteralPath $guideFrom -Destination (Join-Path $dest 'HOW-TO.txt') -Force

Write-Host "Packed: $dest"
Write-Host "Copy the office-dist folder to the lab PC, then run mcr_console.bat."
