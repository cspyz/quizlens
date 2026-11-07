@echo off
cd /d "%~dp0"
REM 优先用 PATH 里的 node；也可以先把 NODE_EXE 设成自己的 node 路径
if not defined NODE_EXE set NODE_EXE=node
"%NODE_EXE%" run-all.js
echo.
pause
