@echo off
rem Manual front end for the Redmine read-only server. Same code path as the MCP tools.
rem Usage:  ticket check | ticket issue 1234 [--json] [--no-journals] | ticket attachment 567
setlocal
chcp 65001 >nul
set "NODE=%APPDATA%\nvm\v24.21.0\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0dist\cli.js" %*
endlocal & exit /b %ERRORLEVEL%
