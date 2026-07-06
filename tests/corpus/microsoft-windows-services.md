# Managing Windows services with PowerShell

vendor: Microsoft
product: Windows Server
version: "2022"
doc_type: vendor_doc
visibility: global

## Querying services

`Get-Service` lists all services. Filter by name with
`Get-Service -Name "wuauserv"` or by status with
`Get-Service | Where-Object {$_.Status -eq "Running"}`.

## Controlling services

- `Start-Service -Name "<name>"` starts a service.
- `Stop-Service -Name "<name>"` stops it.
- `Restart-Service -Name "<name>"` restarts it.
- `Set-Service -Name "<name>" -StartupType Automatic` sets it to start at boot.

## Remote management

Use `-ComputerName` with the older `Get-Service` cmdlet, or prefer
`Invoke-Command -ComputerName SRV01 -ScriptBlock { Restart-Service W3SVC }`
over WinRM for full cmdlet support on the remote host.

## Event logs

Check the related events with
`Get-WinEvent -LogName System -MaxEvents 50` and filter by provider to see why
a service failed to start.
