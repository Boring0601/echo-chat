@echo off
chcp 65001 >nul
setlocal
title 回声 ECHO

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"

if not defined NODE_EXE (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  echo.
  echo 未找到 Node.js。请安装 Node.js 22.8+，或把 node.exe 加入 PATH。
  echo.
  pause
  exit /b 1
)

echo.
echo 正在启动 回声 ECHO ...
echo 关闭此窗口或按 Ctrl+C 停止服务。
echo.

if /I "%NODE_EXE%"=="node" (
  node server.mjs
) else (
  "%NODE_EXE%" server.mjs
)

pause
