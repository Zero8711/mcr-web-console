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
    [string]$WanUrl = '',
    [string]$UpnpInternal = '',
    [bool]$FirewallOk = $false
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
  $upnpSafe = ([string]$UpnpInternal).Replace('\', '\\').Replace('"', '\"')
  $fwJson = if ($FirewallOk) { 'true' } else { 'false' }
  return "{`"port`":$Port,`"urls`":$urlsJson,`"local`":`"$localSafe`",`"wan`":`"$wanSafe`",`"upnpInternal`":`"$upnpSafe`",`"firewall`":$fwJson}"
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

# Higher is better. ipTIME LAN is almost always 192.168; 172.16-31 is often tether/VM.
function Get-LanAdapterScore {
  param(
    [string]$Ip,
    [string]$Name
  )

  if (-not $Ip) {
    return -1
  }
  if ($Ip -like '127.*' -or $Ip -like '169.254.*') {
    return -1
  }
  if (Test-VpnOrVirtualAdapter $Name) {
    return -1
  }
  if (-not (Test-PrivateIPv4 $Ip)) {
    return -1
  }
  if ($Ip -like '192.168.*') {
    return 100
  }
  if ($Ip -like '10.*') {
    return 80
  }
  if ($Ip -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') {
    return 40
  }
  return 10
}

# Router-facing LAN IP. VPN/tether adapters are skipped so UPnP maps the PC the router knows.
function Get-UpnpInternalIPv4 {
  $bestIp = $null
  $bestScore = -1
  $bestName = ''

  try {
    $configs = Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object {
      $_.IPEnabled -and $_.DefaultIPGateway
    }
    foreach ($cfg in $configs) {
      $adapter = Get-CimInstance Win32_NetworkAdapter -Filter "Index=$($cfg.Index)" -ErrorAction SilentlyContinue
      $name = [string]($adapter.NetConnectionID + ' ' + $adapter.Name)
      $ip = @($cfg.IPAddress) | Where-Object {
        $_ -match '^\d+\.\d+\.\d+\.\d+$'
      } | Select-Object -First 1
      $score = Get-LanAdapterScore -Ip ([string]$ip) -Name $name
      if ($score -gt $bestScore) {
        $bestScore = $score
        $bestIp = [string]$ip
        $bestName = $name
      }
    }
  } catch {
    # Fall through to NIC scan
  }

  if (-not $bestIp) {
    foreach ($ip in @(Get-LanIPv4List)) {
      $score = Get-LanAdapterScore -Ip $ip -Name ''
      if ($score -gt $bestScore) {
        $bestScore = $score
        $bestIp = [string]$ip
      }
    }
  }

  if ($bestIp) {
    if ($bestName) {
      Write-Host "UPnP internal IP: $bestIp ($bestName)"
    } else {
      Write-Host "UPnP internal IP: $bestIp"
    }
  }
  return $bestIp
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
    $mappedInternal = $null
    $enabled = $true
    try {
      $item = $maps.Item($Port, 'TCP')
      $ext = Resolve-IPv4String $item.ExternalIPAddress
      $mappedInternal = Resolve-IPv4String $item.InternalClient
      $enabled = [bool]$item.Enabled
    } catch {
      $ext = $null
    }

    if ($mappedInternal -and $mappedInternal -ne $InternalIp) {
      Write-Host "UPnP: router stored $mappedInternal, expected $InternalIp. Re-adding."
      try {
        $maps.Remove($Port, 'TCP')
      } catch {
        # Keep going and Add again
      }
      $maps.Add($Port, 'TCP', $Port, $InternalIp, $true, 'WEB Serial Console')
      $mappedInternal = $InternalIp
    }

    $targetIp = $mappedInternal
    if (-not $targetIp) {
      $targetIp = $InternalIp
    }
    Write-Host "UPnP: TCP $Port -> ${targetIp}:$Port"
    if ($enabled -eq $false) {
      Write-Host "UPnP: mapping is disabled in the router. Enable it, or add a manual TCP $Port forward."
    }
    if (-not $ext -or $ext -like '0.*') {
      Write-Host "UPnP: mapping added, but WAN IP was empty. Check the router WAN address."
      return $null
    }

    Write-Host "UPnP: WAN $ext"
    Write-Host "UPnP: PCs on this Wi-Fi must use http://${targetIp}:$Port/  (WAN times out from inside the router)."
    Write-Host "UPnP: other subnets: if Chrome times out on ${ext}:$Port, check the router forward list and Windows firewall."
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

function Get-FirewallRuleName {
  param([int]$Port)

  return "WEB Serial Console $Port"
}

function Test-InboundFirewallRule {
  param([int]$Port)

  $ruleName = Get-FirewallRuleName -Port $Port
  netsh advfirewall firewall show rule name="$ruleName" 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# Other-band PCs time out if Windows drops inbound TCP. Adding a rule needs Administrator.
function Add-InboundFirewallRule {
  param([int]$Port)

  $ruleName = Get-FirewallRuleName -Port $Port
  if (Test-InboundFirewallRule -Port $Port) {
    Write-Host "Firewall: inbound TCP $Port already allowed."
    return $true
  }

  if (-not (Test-IsAdmin)) {
    Write-Host "Firewall: no inbound rule for TCP $Port."
    Write-Host "Firewall: other-band PCs will time out until you run mcr_console.bat as Administrator once."
    return $false
  }

  netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$Port profile=any | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Firewall: added inbound TCP $Port ($ruleName)."
    return $true
  }

  Write-Host "Firewall: could not add the inbound rule."
  return $false
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
Write-Host "Closing this window stops the local server and tries to undo UPnP."
Write-Host "See README.txt for how to share with remote users."

$firewallOk = Add-InboundFirewallRule -Port $port

Start-Process $loopbackUrl

$apiJson = Get-ApiInfoJson -Port $port -LanUrls @($lanUrls.ToArray()) -LocalUrl $loopbackUrl.TrimEnd('/') -WanUrl $wanUrl -UpnpInternal ([string]$upnpInternalIp) -FirewallOk $firewallOk

try {
  [ShareHttpServer]::Run($root, $port, $apiJson)
} catch {
  Write-Host "Cannot open port $port. Close the other relay window and try again."
  Write-Host $_.Exception.Message
} finally {
  Remove-UpnpPortMapping -Port $port
}
