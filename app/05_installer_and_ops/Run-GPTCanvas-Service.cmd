@echo off
setlocal
set "APP_ROOT=%~dp0.."
set "GPT_CANVAS_PROJECT_ROOT=%APP_ROOT%\02_bridge_service\runtime\default-project"
set "GPT_CANVAS_RUNTIME_ROOT=%APP_ROOT%\02_bridge_service\runtime"
set "GPT_CANVAS_DIST_ROOT=%APP_ROOT%\01_canvas_app\dist"
set "GPT_CANVAS_PORT=3220"
set "GPT_CANVAS_UI_PORT=3230"
cd /d "%APP_ROOT%\02_bridge_service"
"C:\Program Files\nodejs\node.exe" dist\src\main.js >> runtime\launcher.log 2>&1
