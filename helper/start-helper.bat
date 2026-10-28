@echo off
chcp 65001 >nul
title SyncDesk Helper
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ยังไม่พบ Node.js กรุณาติดตั้งจาก https://nodejs.org ก่อน
  pause
  exit /b 1
)

if not exist "..\node_modules\ws" (
  echo กำลังติดตั้งส่วนประกอบครั้งแรก...
  pushd ..
  call npm install --omit=dev
  popd
)

set /p SD_URL=วาง URL ของเซิร์ฟเวอร์ (เช่น https://xxx.onrender.com):
set /p SD_ROOM=Room ID:
set /p SD_SECRET=Secret:

node win-helper.js "%SD_URL%" "%SD_ROOM%" "%SD_SECRET%"
pause
