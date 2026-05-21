@echo off
for %%I in ("%~dp0..") do set "RUNTIME_DIR=%%~fI"
set "PYTHONHOME=%RUNTIME_DIR%\python"
set "PYTHONPATH="
set "PYTHONNOUSERSITE=1"
"%RUNTIME_DIR%\python\python.exe" %*
