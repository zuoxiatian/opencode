@echo off
set "RUNTIME_DIR=%~dp0.."
set "PYTHONHOME=%RUNTIME_DIR%\python"
set "PYTHONPATH="
set "PYTHONNOUSERSITE=1"
"%RUNTIME_DIR%\python\python.exe" -m pip %*
