$url = if ($args.Count -gt 0) { $args[0] } else { "https://example.com" }
$prompt = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] -join " " } else { "Summarize this page in 2 bullet points." }

Write-Host "Analyzing Link: $url" -ForegroundColor Cyan
Write-Host "Prompt: $prompt" -ForegroundColor Cyan

$body = @{
    url = $url
    prompt = $prompt
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/analyze-link" -Method Post -ContentType "application/json" -Body $body
    Write-Host "`n--- Analysis Result ---" -ForegroundColor Green
    Write-Host $response.response
    Write-Host "-----------------------`n" -ForegroundColor Green
} catch {
    Write-Host "Request failed: $_" -ForegroundColor Red
    if ($_.Exception.Response) {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        Write-Host "Server Response: $($reader.ReadToEnd())" -ForegroundColor Red
    }
}
