@echo off
cd /d "%~dp0"
echo.
echo Keep this window open on the PC with the serial cable.
echo Chrome opens http://127.0.0.1:8765/  - pick COM, then click Share.
echo Send the share link to remote users. Details: README.txt
echo.
echo The script tries UPnP to forward TCP 8765 on the local router.
echo Same-router PCs must use the 192.168 link. The UPnP WAN link times out from inside.
echo If other-subnet PCs time out, run this file as Administrator once, and check ipTIME TCP 8765.
echo If UPnP is off (company/hotel), forward the port yourself. See README.txt
echo.
echo If other PCs cannot open the page, allow inbound TCP 8765:
echo   netsh advfirewall firewall add rule name="WEB Serial Console 8765" dir=in action=allow protocol=TCP localport=8765
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
