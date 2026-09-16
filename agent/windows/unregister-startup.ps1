$ErrorActionPreference = 'Stop'
$taskName = 'PrintFlow Printer Agent'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Write-Output 'PrintFlow Printer Agent startup registration removed.'
