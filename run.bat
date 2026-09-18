@echo off
setlocal

if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
) else (
    python --version >nul 2>nul
    if %errorlevel% equ 0 (
        set "PYTHON_EXE=python"
    ) else (
        if exist "C:\Users\Student\AppData\Local\Programs\Python\Python312\python.exe" (
            set "PYTHON_EXE=C:\Users\Student\AppData\Local\Programs\Python\Python312\python.exe"
        ) else (
            set "PYTHON_EXE=py"
        )
    )
)

echo Starting gemini-web2api using: %PYTHON_EXE%
"%PYTHON_EXE%" "%~dp0gemini_web2api.py" %*
