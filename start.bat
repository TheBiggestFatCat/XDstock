@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在启动 汐灯证券 …
start "" http://localhost:8971
node server.js
pause
