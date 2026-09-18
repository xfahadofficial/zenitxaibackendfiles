$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    $pythonExe = $venvPython
} else {
    $pythonExe = "python"
    $pyWorks = $false
    try {
        $null = & python --version 2>&1
        if ($LASTEXITCODE -eq 0) { $pyWorks = $true }
    } catch {
        $pyWorks = $false
    }

    if (-not $pyWorks) {
        try {
            $uvPy = & uv python find 2>$null
            if ($uvPy -and (Test-Path $uvPy)) {
                $pythonExe = $uvPy.Trim()
            } else {
                $pythonExe = "py"
            }
        } catch {
            $pythonExe = "py"
        }
    }
}

Write-Host "Starting gemini-web2api using: $pythonExe" -ForegroundColor Cyan
& $pythonExe "$PSScriptRoot\gemini_web2api.py" @args
