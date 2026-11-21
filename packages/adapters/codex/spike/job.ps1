# 本次探针的 Node 子进程进入 Windows Job 后才接收命令。关闭 Job 会清理它产生的整棵树。
param([Parameter(Mandatory=$true)][string]$NodeExe, [Parameter(Mandatory=$true)][string]$Entry)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ProbeJob {
    [StructLayout(LayoutKind.Sequential)] public struct Basic {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr Min, Max;
        public uint Active;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Io {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Extended {
        public Basic Base;
        public Io Counters;
        public UIntPtr ProcessLimit, JobLimit, PeakProcess, PeakJob;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Create() {
        IntPtr h = CreateJobObject(IntPtr.Zero, null);
        if (h == IntPtr.Zero) throw new Exception();
        Extended info = new Extended();
        info.Base.Flags = 0x2000;
        if (!SetInformationJobObject(h, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) {
            CloseHandle(h); throw new Exception();
        }
        return h;
    }
}
"@
$packet = [Console]::In.ReadToEnd()
$handle = [ProbeJob]::Create()
$child = $null
$exitCode = 2
try {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $NodeExe
    $start.Arguments = '"' + $Entry + '" --job-input'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($start)
    if (-not [ProbeJob]::AssignProcessToJobObject($handle, $child.Handle)) { throw 'Job assignment failed' }
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    $child.StandardInput.Write($packet)
    $child.StandardInput.Close()
    if (-not $child.WaitForExit(110000)) { throw 'Job timed out' }
    [Console]::Out.Write($stdout.Result)
    [Console]::Error.Write($stderr.Result)
    $exitCode = $child.ExitCode
} finally {
    if ($child -and -not $child.HasExited) { $child.Kill() }
    [void][ProbeJob]::CloseHandle($handle)
    if ($child) { $child.Dispose() }
}
exit $exitCode
