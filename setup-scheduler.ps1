# GeekOnCloud — Setup Windows Task Scheduler
# Run this once as Administrator in PowerShell
# It creates a daily task that posts a new blog article at 8:00 AM

# ── Config (edit this path if needed) ──
$ProjectPath = "C:\Project\geekoncloud\project1\geekoncloud"
$BatchFile   = "$ProjectPath\agent\run-daily.bat"
$TaskName    = "GeekOnCloud Daily Post"
$RunTime     = "08:00"   # 24h format — change to when you want it to run

# ── Create the scheduled task ──
$Action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatchFile`""
$Trigger = New-ScheduledTaskTrigger -Daily -At $RunTime
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable   # runs at next opportunity if PC was off at scheduled time

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -RunLevel Highest `
    -Force

Write-Host ""
Write-Host "✓ Task '$TaskName' created successfully!" -ForegroundColor Green
Write-Host "  Runs daily at $RunTime"
Write-Host "  Batch file: $BatchFile"
Write-Host ""
Write-Host "To run it RIGHT NOW (test):"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Cyan
Write-Host ""
Write-Host "To remove it:"
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false" -ForegroundColor Yellow
