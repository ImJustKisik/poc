# ============================================================
# PCM — Project Rebuild Script (PowerShell)
# ============================================================

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
Write-Host "`n🚀 Rebuilding PCM Project...`n" -ForegroundColor Cyan

# 1. Root dependencies (if missing)
if (-not (Test-Path "node_modules")) {
    Write-Host "📦 Installing root dependencies..." -ForegroundColor Yellow
    npm install
}

# 2. Rebuild SHARED (Crucial for types!)
Write-Host "`n🔨 [1/3] Building SHARED package..." -ForegroundColor Yellow
npm run build -w shared

# 3. Rebuild SERVER
Write-Host "`n🔨 [2/3] Building SERVER..." -ForegroundColor Yellow
npm run build -w server

# 4. Rebuild CLIENT
Write-Host "`n🔨 [3/3] Building CLIENT (frontend)..." -ForegroundColor Yellow
npm run build -w client

Write-Host "`n✅ PCM Rebuild Complete!`n" -ForegroundColor Green
Write-Host "To start the project, use:" -ForegroundColor White
Write-Host "  npm run dev:server" -ForegroundColor Cyan
Write-Host "  npm run dev:client" -ForegroundColor Cyan
