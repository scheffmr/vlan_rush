@echo off
echo Starte VLAN-Rush Server...

start "" cmd /c "node server.js"
timeout 2 >nul

echo Ermittele lokale IP Adressen...

(
echo ^<!DOCTYPE html^>
echo ^<html lang="de"^>
echo ^<head^>
echo ^<meta charset="UTF-8"^>
echo ^<title^>VLAN-Rush Server^</title^>
echo ^</head^>
echo ^<body style="font-family: sans-serif;"^>
echo ^<h2^>VLAN-Rush – Wähle die IP-Adresse^</h2^>
echo ^<ul^>
) > start.html

for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr "IPv4"') do (
    for /f "tokens=* delims= " %%B in ("%%A") do (
        echo   ^<li^>^<a href="http://%%B:3000" target="_blank"^>http://%%B:3000^</a^>^</li^> >> start.html
        echo   ^<li^>^<a href="https://%%B:3443" target="_blank"^>https://%%B:3443^</a^>^</li^> >> start.html
    )
)

(
echo ^</ul^>
echo ^</body^>
echo ^</html^>
) >> start.html

start start.html
