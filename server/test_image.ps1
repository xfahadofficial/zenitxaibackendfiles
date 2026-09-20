$prompt = if ($args.Count -gt 0) { $args -join " " } else { "A glowing cyberpunk crystal in a dark forest, 8k resolution" }
Write-Host "Generating image for: $prompt" -ForegroundColor Cyan

$body = @{ prompt = $prompt } | ConvertTo-Json
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/generate-image" -Method Post -ContentType "application/json" -Body $body
    Write-Host "Success: $($response.success)" -ForegroundColor Green
    
    $base64 = $response.image_url -replace '^data:image/[^;]+;base64,', ''
    $outputPath = Join-Path $PSScriptRoot "generated_image.png"
    [System.IO.File]::WriteAllBytes($outputPath, [System.Convert]::FromBase64String($base64))
    Write-Host "Image successfully saved to: $outputPath" -ForegroundColor Green
    Start-Process $outputPath
} catch {
    Write-Host "Request failed: $_" -ForegroundColor Red
    if ($_.Exception.Response) {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        Write-Host "Server Response: $($reader.ReadToEnd())" -ForegroundColor Red
    }
}
