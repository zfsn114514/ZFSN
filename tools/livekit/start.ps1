# LiveKit Server launcher for ZFVoice OPTIONAL self-hosted mode (PowerShell).
# Keep this file ASCII-only for Windows PowerShell 5.1 encoding compatibility.
# Chinese instructions are in README.md.
param(
    [string] $Config = (Join-Path $PSScriptRoot 'livekit.yaml'),
    [string] $Binary = $env:LIVEKIT_BIN
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Config)) {
    Write-Host '[ERROR] livekit.yaml not found. Copy livekit.example.yaml and fill in your API keys.' -ForegroundColor Red
    exit 1
}

$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $i = $line.IndexOf('=')
            $k = $line.Substring(0, $i).Trim()
            $v = $line.Substring($i + 1).Trim()
            if ($k) { [Environment]::SetEnvironmentVariable($k, $v, 'Process') }
        }
    }
}

if (-not $Binary) { $Binary = Join-Path $PSScriptRoot 'livekit-server.exe' }
if (-not (Test-Path $Binary)) {
    Write-Host "[ERROR] livekit-server.exe not found: $Binary" -ForegroundColor Red
    Write-Host '        Put the exe next to this script or set LIVEKIT_BIN in .env' -ForegroundColor Red
    exit 1
}

Write-Host 'Starting LiveKit Server on port 7880 (Ctrl+C to stop) ...' -ForegroundColor Green
Write-Host "Config: $Config"
& $Binary --config $Config
