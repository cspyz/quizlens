@echo off
chcp 65001 >nul
title 综合练习卷 - 本地服务
cd /d "%~dp0"

echo ============================================================
echo   综合练习卷 本地服务
echo ============================================================
echo.
echo   服务目录: %CD%
echo   访问地址: http://localhost:8080
echo.
echo   保持这个窗口开着；关掉窗口 = 服务停止。
echo   停止服务也可以按 Ctrl+C。
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 python，请先安装 Python 并加入 PATH。
  echo        或者手动用别的静态服务器托管本目录。
  pause
  exit /b 1
)

REM 端口被占用时直接提示，避免"服务没起来但用户以为起来了"。
REM 注意：不能写 findstr /r /c:"LISTENING.*:8080 " ——
REM netstat 的输出里 LISTENING 在**端口之后**（"TCP  0.0.0.0:8080  0.0.0.0:0  LISTENING"），
REM 那个正则永远匹配不到，整段检查等于死代码（实测踩过）。
REM 这里改成先找含 ":8080" 且含 "LISTENING" 的行，用两段 findstr 串起来。
netstat -ano | findstr ":8080" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [提示] 8080 端口已经被占用 —— 可能服务已经在跑了。
  echo        直接用浏览器打开 http://localhost:8080 试试；
  echo        如果打开的不是本练习页，先关掉占用 8080 的程序。
  echo.
  start "" http://localhost:8080
  pause
  exit /b 0
)

REM 起服务后自动打开浏览器。延时 2 秒等服务器就绪，否则会打开一个"无法连接"的页面。
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:8080"

echo 正在启动 http.server（按 Ctrl+C 停止）...
echo.
python -m http.server 8080

echo.
echo 服务已停止。
pause
