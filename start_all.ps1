$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $scriptPath

$global:PIDs = @()

function Cleanup {
    foreach ($id in $global:PIDs) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    exit
}

[Console]::TreatControlCAsInput = $false
[Console]::CancelKeyPress += {
    $_.Cancel = $true
    Cleanup
}

if (!(Test-Path "backend_logs")) { New-Item -ItemType Directory -Path "backend_logs" | Out-Null }
Remove-Item -Path "backend_logs\*.log" -Force -ErrorAction SilentlyContinue

Set-Location "graph_server\routing-engine"
$proc1 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `" .\`.venv\Scripts\activate && python grpc_server.py > ..\..\backend_logs\routing_engine.log 2>&1 `"" -WindowStyle Hidden -PassThru
$global:PIDs += $proc1.Id
Set-Location "..\.."

Set-Location "graph_server\rescuemind-api\cmd\server"
$proc2 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `" go run main.go > ..\..\..\..\backend_logs\graph_api.log 2>&1 `"" -WindowStyle Hidden -PassThru
$global:PIDs += $proc2.Id
Set-Location "..\..\..\.."

Set-Location "RAG_Server"
$proc3 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `" .\`.venv\Scripts\activate && python api_server.py > ..\backend_logs\rag_server.log 2>&1 `"" -WindowStyle Hidden -PassThru
$global:PIDs += $proc3.Id
Set-Location ".."

Set-Location "main_server"
$proc4 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `" set PORT=6000&& set RAG_SERVER_URL=http://localhost:8000&& set GRAPH_API_URL=http://localhost:8080&& go run main.go > ..\backend_logs\gateway.log 2>&1 `"" -WindowStyle Hidden -PassThru
$global:PIDs += $proc4.Id
Set-Location ".."

Start-Sleep -Seconds 3

Set-Location "RescueMindApp"
npm start

Cleanup
