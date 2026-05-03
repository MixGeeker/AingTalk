@echo off
echo Starting Agent Worker...
set NODE_ENV=production
node "%~dp0..\src\index.js" %*
pause
