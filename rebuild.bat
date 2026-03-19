@echo off
cd /d "%~dp0"
echo ============================================================
echo PCM - Project Rebuild Script
echo ============================================================
echo.
echo Installing root dependencies...
call npm install
echo.
echo Rebuilding PCM...
call npm run build
echo.
echo Done! Rebuild complete.
echo.
pause
