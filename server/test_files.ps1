param(
    [string[]]$Files = @("package.json", "test_code.py"),
    [string]$Prompt = "Analyze the provided files and describe what they do."
)

Write-Host "Multi-File Analysis Test" -ForegroundColor Cyan
Write-Host "Files: $($Files -join ', ')" -ForegroundColor Cyan
Write-Host "Prompt: $Prompt" -ForegroundColor Cyan

$curlArgs = @("-s", "-F", "prompt=$Prompt")
foreach ($f in $Files) {
    if (Test-Path $f) {
        $curlArgs += "-F"
        $curlArgs += "files=@$f"
    } else {
        Write-Host "Warning: File not found: $f" -ForegroundColor Yellow
    }
}
$curlArgs += "http://localhost:3000/api/v1/analyze-files"

Write-Host "`nSending request to http://localhost:3000/api/v1/analyze-files..." -ForegroundColor Cyan
$raw = & curl.exe @curlArgs

try {
    $json = $raw | ConvertFrom-Json
    if ($json.success) {
        Write-Host "`n--- Analysis Result (Files Processed: $($json.files_processed)) ---" -ForegroundColor Green
        Write-Host $json.response
        Write-Host "--------------------------------------------------------`n" -ForegroundColor Green
    } else {
        Write-Host "`nError from server: $($json.error)" -ForegroundColor Red
    }
} catch {
    Write-Host "Failed to parse response:" -ForegroundColor Red
    Write-Host $raw
}
