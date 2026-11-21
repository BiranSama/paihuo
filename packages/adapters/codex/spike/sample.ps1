# Only the named process and its descendants are sampled. No command lines are queried.
$ErrorActionPreference = 'Stop'
$pending = [Collections.Generic.Queue[int]]::new()
$pending.Enqueue([int]$env:PAIHUO_SAMPLE_ROOT)
$seen = @{}
[long]$workingSet = 0
while ($pending.Count) {
    $current = $pending.Dequeue()
    if ($seen.ContainsKey($current)) { continue }
    $process = Get-Process -Id $current -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $seen[$current] = $true
    $workingSet += $process.WorkingSet64
    $children = Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId='+$current) -Property ProcessId
    foreach ($child in $children) { $pending.Enqueue([int]$child.ProcessId) }
}
[Console]::Write((@{pids=@($seen.Keys);bytes=$workingSet} | ConvertTo-Json -Compress))
