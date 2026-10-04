#Requires -Version 5.1
# Read-only screen capture. Stream mode samples either the calibrated 132x12
# strip or the strict 132x144 carrier-probe region at five frames/sec, and
# refuses frames unless WowB owns the foreground window.
param(
    [ValidateSet('Stream', 'Once')][string]$Mode = 'Stream',
    [ValidateRange(-32768, 32768)][int]$X = 0,
    [ValidateRange(-32768, 32768)][int]$Y = 0,
    [ValidateRange(1, 32768)][int]$Width = 132,
    [ValidateRange(1, 32768)][int]$Height = 12,
    [switch]$Calibration
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Record([object]$Record) {
    [Console]::WriteLine(($Record | ConvertTo-Json -Compress -Depth 3))
    [Console]::Out.Flush()
}

try {
    if ($Calibration -and $Mode -ne 'Once') { throw 'Calibration is a single capture, never a stream.' }
    Add-Type -AssemblyName System.Drawing
    Add-Type -ReferencedAssemblies System.Drawing.dll -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class WitchcraftReadOnlyCapture {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int metric);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    public static void UsePhysicalPixels() { SetProcessDPIAware(); }
    public static int[] Desktop() {
        return new int[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) };
    }
    public static bool ForegroundIsWow() {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return false;
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        try {
            using (Process process = Process.GetProcessById((int)processId)) {
                return String.Equals(process.ProcessName, "WowB", StringComparison.OrdinalIgnoreCase);
            }
        } catch (ArgumentException) { return false; }
          catch (InvalidOperationException) { return false; }
          catch (System.ComponentModel.Win32Exception) { return false; }
    }
    public static string ReadPixelsBase64(int x, int y, int width, int height) {
        if (width <= 0 || height <= 0 || (long)width * height > 16000000) throw new ArgumentOutOfRangeException("capture dimensions");
        byte[] rgba = new byte[checked(width * height * 4)];
        using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (Graphics graphics = Graphics.FromImage(bitmap)) {
                graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            BitmapData locked = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try {
                for (int row = 0; row < height; row++) {
                    IntPtr source = IntPtr.Add(locked.Scan0, row * locked.Stride);
                    Marshal.Copy(source, rgba, row * width * 4, width * 4);
                }
            } finally { bitmap.UnlockBits(locked); }
        }
        for (int index = 0; index < rgba.Length; index += 4) {
            byte blue = rgba[index]; rgba[index] = rgba[index + 2]; rgba[index + 2] = blue; rgba[index + 3] = 255;
        }
        return Convert.ToBase64String(rgba);
    }
}
'@
    [WitchcraftReadOnlyCapture]::UsePhysicalPixels()
    $captureX = $X; $captureY = $Y; $captureWidth = $Width; $captureHeight = $Height
    $desktop = [WitchcraftReadOnlyCapture]::Desktop()
    if ($Calibration) {
        $captureX = $desktop[0]; $captureY = $desktop[1]; $captureWidth = $desktop[2]; $captureHeight = $desktop[3]
    }
    if ($captureWidth -le 0 -or $captureHeight -le 0 -or $captureWidth -gt 32768 -or $captureHeight -gt 32768 -or
        ([long]$captureWidth * $captureHeight) -gt 16000000 -or [Math]::Abs($captureX) -gt 32768 -or [Math]::Abs($captureY) -gt 32768) {
        throw 'Capture exceeds the bounded desktop dimensions (sixteen million pixels).'
    }
    if ($captureX -lt $desktop[0] -or $captureY -lt $desktop[1] -or
        ($captureX + $captureWidth) -gt ($desktop[0] + $desktop[2]) -or
        ($captureY + $captureHeight) -gt ($desktop[1] + $desktop[3])) { throw 'The calibrated strip is outside the current virtual desktop. Calibrate again.' }
    do {
        $cycle = [System.Diagnostics.Stopwatch]::StartNew()
        $foregroundBefore = [WitchcraftReadOnlyCapture]::ForegroundIsWow()
        if ($Mode -eq 'Stream' -and -not $foregroundBefore) {
            Write-Record @{ protocol = 1; type = 'idle'; foreground = $false }
        } else {
            $watch = [System.Diagnostics.Stopwatch]::StartNew()
            $encodedPixels = [WitchcraftReadOnlyCapture]::ReadPixelsBase64($captureX, $captureY, $captureWidth, $captureHeight)
            $watch.Stop()
            $foregroundAfter = [WitchcraftReadOnlyCapture]::ForegroundIsWow()
            $foreground = $foregroundBefore -and $foregroundAfter
            if ($Mode -eq 'Stream' -and -not $foreground) {
                Write-Record @{ protocol = 1; type = 'idle'; foreground = $false }
            } else {
                Write-Record @{ protocol = 1; type = 'frame'; x = $captureX; y = $captureY;
                    width = $captureWidth; height = $captureHeight; captureMs = $watch.Elapsed.TotalMilliseconds;
                    foreground = [bool]$foreground; rgba = $encodedPixels }
            }
        }
        if ($Mode -eq 'Once') { break }
        $remaining = [Math]::Max(1, 200 - [int]$cycle.ElapsedMilliseconds)
        [System.Threading.Thread]::Sleep($remaining)
    } while ($true)
} catch {
    Write-Record @{ protocol = 1; type = 'error'; message = $_.Exception.Message }
    exit 1
}
