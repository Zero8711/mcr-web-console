# Local HTTP + WebSocket relay.
# Chrome cannot open COM on file:// so we serve http://127.0.0.1:8765/

$root = $PSScriptRoot
$port = 8765
$loopbackUrl = "http://127.0.0.1:$port/"

function Get-LanIPv4List {
  $ips = New-Object System.Collections.Generic.List[string]

  try {
    $nics = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
    foreach ($nic in $nics) {
      if ($nic.OperationalStatus -ne 'Up') {
        continue
      }
      if ($nic.NetworkInterfaceType -eq 'Loopback') {
        continue
      }

      foreach ($addr in $nic.GetIPProperties().UnicastAddresses) {
        if ($addr.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
          continue
        }
        $ip = $addr.Address.ToString()
        if ($ip -like '127.*' -or $ip -like '169.254.*') {
          continue
        }
        if (-not $ips.Contains($ip)) {
          $ips.Add($ip)
        }
      }
    }
  } catch {
    # Skip this NIC if address lookup fails
  }

  return $ips
}

function Stop-OldRelay {
  $myPid = $PID
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'powershell.exe' -or $_.Name -eq 'pwsh.exe'
  }

  foreach ($proc in $procs) {
    if ($proc.ProcessId -eq $myPid) {
      continue
    }
    $cmd = [string]$proc.CommandLine
    if ($cmd -notlike '*start-local.ps1*') {
      continue
    }
    Write-Host "Stopping previous local server (PID $($proc.ProcessId)) and restarting."
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Milliseconds 1200
}

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ApiInfoJson {
  param(
    [int]$Port,
    [string[]]$LanUrls,
    [string]$LocalUrl,
    [string]$WanUrl = ''
  )

  if (-not $LanUrls) {
    $LanUrls = @()
  }

  $escaped = New-Object System.Collections.Generic.List[string]
  foreach ($url in $LanUrls) {
    $safe = $url.Replace('\', '\\').Replace('"', '\"')
    [void]$escaped.Add('"' + $safe + '"')
  }

  $urlsJson = '[' + ($escaped -join ',') + ']'
  $localSafe = $LocalUrl.Replace('\', '\\').Replace('"', '\"')
  $wanSafe = ([string]$WanUrl).Replace('\', '\\').Replace('"', '\"')
  return "{`"port`":$Port,`"urls`":$urlsJson,`"local`":`"$localSafe`",`"wan`":`"$wanSafe`"}"
}

function Test-VpnOrVirtualAdapter {
  param([string]$Name)

  $text = ([string]$Name).ToLowerInvariant()
  return $text -match 'vpn|wintun|wireguard|tap-windows|cisco|anyconnect|globalprotect|zerotier|tailscale|hamachi|virtualbox|vmware|hyper-v|vethernet|docker'
}

function Test-PrivateIPv4 {
  param([string]$Ip)

  if ($Ip -like '10.*' -or $Ip -like '192.168.*' -or $Ip -like '127.*' -or $Ip -like '169.254.*') {
    return $true
  }
  return $Ip -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.'
}

# HNetCfg COM often unwraps ExternalIPAddress as (ComObject + "1.2.3.4").
# Joining that with [string] becomes "System.__ComObject 1.2.3.4".
function Resolve-IPv4String {
  param($Value)

  foreach ($item in @($Value)) {
    if ($null -eq $item) {
      continue
    }
    $text = ''
    try {
      $text = [string]$item
    } catch {
      continue
    }
    if ($text -match '((?:\d{1,3}\.){3}\d{1,3})') {
      return $Matches[1]
    }
  }
  return $null
}

# Router-facing LAN IP. VPN adapters are skipped so UPnP maps the PC the router knows.
function Get-UpnpInternalIPv4 {
  try {
    $configs = Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object {
      $_.IPEnabled -and $_.DefaultIPGateway
    }
    foreach ($cfg in $configs) {
      $adapter = Get-CimInstance Win32_NetworkAdapter -Filter "Index=$($cfg.Index)" -ErrorAction SilentlyContinue
      $name = [string]($adapter.NetConnectionID + ' ' + $adapter.Name)
      if (Test-VpnOrVirtualAdapter $name) {
        continue
      }

      $ip = @($cfg.IPAddress) | Where-Object {
        $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notlike '127.*' -and $_ -notlike '169.254.*'
      } | Select-Object -First 1
      if ($ip) {
        return [string]$ip
      }
    }
  } catch {
    # Fall through to NIC scan
  }

  foreach ($ip in @(Get-LanIPv4List)) {
    if ($ip -like '192.168.*') {
      return $ip
    }
  }
  $first = @(Get-LanIPv4List) | Select-Object -First 1
  if ($first) {
    return [string]$first
  }
  return $null
}

function Add-UpnpPortMapping {
  param(
    [int]$Port,
    [string]$InternalIp
  )

  if (-not $InternalIp) {
    Write-Host "UPnP: skipped (no LAN IP)."
    return $null
  }

  try {
    $nat = New-Object -ComObject HNetCfg.NATUPnP
    $maps = $nat.StaticPortMappingCollection
    if ($null -eq $maps) {
      Write-Host "UPnP: router did not offer port mapping. Enable UPnP, or forward TCP $Port manually."
      return $null
    }

    $script:UpnpMaps = $maps
    try {
      $maps.Remove($Port, 'TCP')
    } catch {
      # No previous mapping
    }

    $maps.Add($Port, 'TCP', $Port, $InternalIp, $true, 'WEB Serial Console')
    $script:UpnpAdded = $true

    $ext = $null
    try {
      $ext = Resolve-IPv4String $maps.Item($Port, 'TCP').ExternalIPAddress
    } catch {
      $ext = $null
    }

    Write-Host "UPnP: TCP $Port -> ${InternalIp}:$Port"
    if (-not $ext -or $ext -like '0.*') {
      Write-Host "UPnP: mapping added, but WAN IP was empty. Check the router WAN address."
      return $null
    }

    Write-Host "UPnP: WAN $ext"
    if (-not (Test-PrivateIPv4 $ext)) {
      Write-Host "UPnP: this WAN address looks public. The share link may be reachable outside the company LAN."
    }
    return $ext
  } catch {
    Write-Host "UPnP: skipped. $($_.Exception.Message)"
    Write-Host "UPnP: company/hotel networks often block this. Use VPN or a manual port forward."
    return $null
  }
}

function Remove-UpnpPortMapping {
  param([int]$Port)

  if (-not $script:UpnpAdded -or -not $script:UpnpMaps) {
    return
  }

  try {
    $script:UpnpMaps.Remove($Port, 'TCP')
    Write-Host "UPnP: removed TCP $Port mapping."
  } catch {
    Write-Host "UPnP: could not remove mapping. Remove TCP $Port in the router if it stays open."
  }

  $script:UpnpAdded = $false
}

function Initialize-ShareRelay {
  if ('ShareHttpServer' -as [type]) {
    return
  }

  $csPath = Join-Path $root 'src\ShareRelay.cs'
  $frameworkDir = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
  if (-not (Test-Path -LiteralPath $frameworkDir)) {
    $frameworkDir = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
  }

  $refs = @(
    'System.dll',
    'System.Core.dll',
    (Join-Path $frameworkDir 'System.Xml.dll'),
    (Join-Path $frameworkDir 'System.Runtime.Serialization.dll')
  )

  $savedLib = $env:LIB
  $env:LIB = ''
  try {
    Add-Type -Path $csPath -ReferencedAssemblies $refs -ErrorAction Stop
  } catch {
    Write-Host "Failed to load the relay module."
    Write-Host $_.Exception.Message
    throw
  } finally {
    $env:LIB = $savedLib
  }
}

Stop-OldRelay
Initialize-ShareRelay

$lanIps = @(Get-LanIPv4List) | Sort-Object {
  if ($_ -like '192.168.*') { '0' }
  elseif ($_ -like '10.*') { '1' }
  else { '2' }
}, { $_ }
$lanUrls = New-Object System.Collections.Generic.List[string]
foreach ($ip in $lanIps) {
  [void]$lanUrls.Add("http://${ip}:${port}")
}

Write-Host "WEB Serial Console (this PC, COM): $loopbackUrl"
if ($lanUrls.Count -gt 0) {
  Write-Host "Other PC URLs:"
  foreach ($url in $lanUrls) {
    Write-Host "  $url/"
    Write-Host "  remote link example: $url/join.html?room=..."
  }
} else {
  Write-Host "No LAN IP found. This PC only."
}

Write-Host ""
$script:UpnpMaps = $null
$script:UpnpAdded = $false
$upnpInternalIp = Get-UpnpInternalIPv4
$upnpWanIp = Add-UpnpPortMapping -Port $port -InternalIp $upnpInternalIp
$wanUrl = ''
if ($upnpWanIp) {
  $wanUrl = "http://${upnpWanIp}:${port}"
  Write-Host "UPnP share example: $wanUrl/join.html?room=..."
}

Write-Host ""
Write-Host "If the firewall blocks other PCs, run as Administrator:"
Write-Host "  netsh advfirewall firewall add rule name=`"WEB Serial Console $port`" dir=in action=allow protocol=TCP localport=$port"
Write-Host ""
Write-Host "Closing this window stops the local server and tries to undo UPnP."
Write-Host "See README.txt for how to share with remote users."

if (Test-IsAdmin) {
  $ruleName = "WEB Serial Console $port"
  netsh advfirewall firewall show rule name="$ruleName" 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$port | Out-Null
    Write-Host "Added firewall rule '$ruleName'."
  }
}

Start-Process $loopbackUrl

$apiJson = Get-ApiInfoJson -Port $port -LanUrls @($lanUrls.ToArray()) -LocalUrl $loopbackUrl.TrimEnd('/') -WanUrl $wanUrl

try {
  [ShareHttpServer]::Run($root, $port, $apiJson)
} catch {
  Write-Host "Cannot open port $port. Close the other relay window and try again."
  Write-Host $_.Exception.Message
} finally {
  Remove-UpnpPortMapping -Port $port
}
