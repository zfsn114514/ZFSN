# ZFVoice local media backend launcher (PowerShell 5.1 compatible, ASCII-only).
# Chinese output comes from voice-media-server.mjs; full docs are in README.md.
param(
    [ValidateSet('run', 'setup', 'doctor', 'print', 'stop')]
    [string] $Command = 'run'
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
Write-Host ''
Write-Host '  ZF Voice - local media backend (account data stays on Cloudflare Worker)'
Write-Host ''
& node --no-warnings tools/livekit/voice-media-server.mjs $Command
