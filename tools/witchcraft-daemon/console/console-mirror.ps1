# Witchcraft console mirror.
#
# Attaches to a console owned by another process and speaks JSON lines over stdio, so the daemon
# can show that console in game and type into it. A process may be attached to only one console,
# so the daemon runs one of these per mirrored console.
#
#   stdin   {"type":"text","text":"..."}      characters, as if typed
#           {"type":"key","name":"enter"}     a named key
#           {"type":"frame"}                  resend the screen even if unchanged
#           {"type":"stop"}                   exit
#   stdout  {"type":"ready",...}              once, after attaching
#           {"type":"frame",...}              a screen, when it changes
#           {"type":"error","message":"..."}  attach or read failure; the process then exits
#
# Colour note: the console API publishes only the legacy 16-colour attribute word, so truecolour
# written by an application is not readable here. Attributes come back as that word and the daemon
# maps its low four bits to an ANSI palette index.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$TargetPid,
    [int]$HistoryRows = 200,
    [int]$IntervalMs = 250
)

$ErrorActionPreference = 'Stop'

# A literal here-string: the C# below is passed through verbatim, with no PowerShell interpolation.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
[StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct CONSOLE_SCREEN_BUFFER_INFO {
  public COORD dwSize; public COORD dwCursorPosition; public ushort wAttributes;
  public SMALL_RECT srWindow; public COORD dwMaximumWindowSize;
}
[StructLayout(LayoutKind.Sequential)] public struct CHAR_INFO { public ushort UnicodeChar; public ushort Attributes; }
[StructLayout(LayoutKind.Explicit)] public struct INPUT_RECORD {
  [FieldOffset(0)]  public ushort EventType;
  [FieldOffset(4)]  public int    bKeyDown;
  [FieldOffset(8)]  public ushort wRepeatCount;
  [FieldOffset(10)] public ushort wVirtualKeyCode;
  [FieldOffset(12)] public ushort wVirtualScanCode;
  [FieldOffset(14)] public ushort UnicodeChar;
  [FieldOffset(16)] public uint   dwControlKeyState;
}

public static class Mirror {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  // Without the Unicode charset the device name is marshalled as ANSI and the W call rejects it.
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(
     string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(
     IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadConsoleOutputW(
     IntPtr h, [Out] CHAR_INFO[] buffer, COORD size, COORD coord, ref SMALL_RECT region);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteConsoleInputW(
     IntPtr h, INPUT_RECORD[] buffer, uint length, out uint written);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);

  const uint READ_WRITE = 0xC0000000, SHARE_RW = 3, OPEN_EXISTING = 3;
  static IntPtr output = IntPtr.Zero, input = IntPtr.Zero;

  public static string Attach(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "cannot attach to the console of process " + pid;
    output = CreateFileW("CONOUT$", READ_WRITE, SHARE_RW, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    input = CreateFileW("CONIN$", READ_WRITE, SHARE_RW, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (output == new IntPtr(-1)) return "attached but the console output buffer refused to open";
    if (input == new IntPtr(-1)) return "attached but the console input buffer refused to open";
    return null;
  }

  static void Escape(StringBuilder into, string value) {
    into.Append('"');
    foreach (char ch in value) {
      if (ch == '"' || ch == '\\') { into.Append('\\').Append(ch); }
      else if (ch < 0x20 || ch == 0x7f) { into.Append("\\u").Append(((int)ch).ToString("x4")); }
      else into.Append(ch);
    }
    into.Append('"');
  }

  // One row as runs of equal attribute, [[attr,"text"],...], with trailing blanks dropped.
  static void Row(StringBuilder into, CHAR_INFO[] cells, int offset, int width) {
    int last = -1;
    for (int x = 0; x < width; x++) {
      char ch = (char)cells[offset + x].UnicodeChar;
      if (ch != ' ' && ch != '\0') last = x;
    }
    into.Append('[');
    int start = 0;
    bool first = true;
    while (start <= last) {
      ushort attr = cells[offset + start].Attributes;
      int end = start;
      while (end + 1 <= last && cells[offset + end + 1].Attributes == attr) end++;
      var text = new StringBuilder();
      for (int x = start; x <= end; x++) {
        char ch = (char)cells[offset + x].UnicodeChar;
        text.Append(ch == '\0' ? ' ' : ch);
      }
      if (!first) into.Append(',');
      first = false;
      into.Append('[').Append(attr).Append(',');
      Escape(into, text.ToString());
      into.Append(']');
      start = end + 1;
    }
    into.Append(']');
  }

  // Read rows [top,bottom] in blocks, because one call is bounded by the buffer it can fill.
  static bool Region(StringBuilder into, int top, int bottom, int width) {
    into.Append('[');
    bool first = true;
    for (int start = top; start <= bottom; start += 64) {
      int height = Math.Min(64, bottom - start + 1);
      var cells = new CHAR_INFO[width * height];
      var size = new COORD(); size.X = (short)width; size.Y = (short)height;
      var origin = new COORD(); origin.X = 0; origin.Y = 0;
      var region = new SMALL_RECT();
      region.Left = 0; region.Top = (short)start;
      region.Right = (short)(width - 1); region.Bottom = (short)(start + height - 1);
      if (!ReadConsoleOutputW(output, cells, size, origin, ref region)) return false;
      for (int y = 0; y < height; y++) {
        if (!first) into.Append(',');
        first = false;
        Row(into, cells, y * width, width);
      }
    }
    into.Append(']');
    return true;
  }

  public static string Frame(int historyRows) {
    CONSOLE_SCREEN_BUFFER_INFO info;
    if (!GetConsoleScreenBufferInfo(output, out info)) return null;
    int width = info.dwSize.X;
    int windowTop = info.srWindow.Top, windowBottom = info.srWindow.Bottom;
    int historyTop = Math.Max(0, windowTop - historyRows);
    var json = new StringBuilder();
    json.Append("{\"type\":\"frame\",\"cols\":").Append(width);
    json.Append(",\"rows\":").Append(windowBottom - windowTop + 1);
    json.Append(",\"bufferRows\":").Append(info.dwSize.Y);
    // The console's own default attribute: cells carrying it are ordinary text, not a colour.
    json.Append(",\"default\":").Append(info.wAttributes);
    json.Append(",\"cursor\":[").Append(info.dwCursorPosition.X).Append(',').Append(info.dwCursorPosition.Y).Append(']');
    // Rows that have left the top of the window: the anchor a reader scrolled into history needs.
    json.Append(",\"scrolled\":").Append(windowTop);
    json.Append(",\"lines\":");
    if (!Region(json, windowTop, windowBottom, width)) return null;
    json.Append(",\"history\":");
    if (historyTop < windowTop) { if (!Region(json, historyTop, windowTop - 1, width)) return null; }
    else json.Append("[]");
    json.Append('}');
    return json.ToString();
  }

  static void Key(List<INPUT_RECORD> into, char ch, ushort vk, uint control) {
    for (int down = 1; down >= 0; down--) {
      var record = new INPUT_RECORD();
      record.EventType = 1;
      record.bKeyDown = down;
      record.wRepeatCount = 1;
      record.wVirtualKeyCode = vk;
      record.wVirtualScanCode = 0;
      record.UnicodeChar = ch;
      record.dwControlKeyState = control;
      into.Add(record);
    }
  }

  public static bool SendText(string text) {
    var records = new List<INPUT_RECORD>();
    foreach (char ch in text) Key(records, ch, (ushort)(VkKeyScanW(ch) & 0xFF), 0);
    return Write(records);
  }

  public static bool SendKey(string name) {
    var records = new List<INPUT_RECORD>();
    switch (name) {
      case "enter":     Key(records, '\r', 0x0D, 0); break;
      case "escape":    Key(records, (char)27, 0x1B, 0); break;
      case "up":        Key(records, '\0', 0x26, 0); break;
      case "down":      Key(records, '\0', 0x28, 0); break;
      case "left":      Key(records, '\0', 0x25, 0); break;
      case "right":     Key(records, '\0', 0x27, 0); break;
      case "pageup":    Key(records, '\0', 0x21, 0); break;
      case "pagedown":  Key(records, '\0', 0x22, 0); break;
      case "backspace": Key(records, '\b', 0x08, 0); break;
      case "tab":       Key(records, '\t', 0x09, 0); break;
      // LEFT_CTRL_PRESSED, so the console raises an interrupt rather than typing a character.
      case "interrupt": Key(records, (char)3, 0x43, 0x0008); break;
      default: return false;
    }
    return Write(records);
  }

  static bool Write(List<INPUT_RECORD> records) {
    if (records.Count == 0) return true;
    uint written;
    var array = records.ToArray();
    return WriteConsoleInputW(input, array, (uint)array.Length, out written) && written == array.Length;
  }
}
'@

# Everything below runs with no console of its own, so nothing may go to the host: the protocol
# uses the raw standard streams, which keep working after the detach.
$writer = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object Text.UTF8Encoding($false)))
$writer.AutoFlush = $true
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding($false)))

$failure = [Mirror]::Attach([uint32]$TargetPid)
if ($failure) {
    $writer.WriteLine('{"type":"error","message":"' + $failure.Replace('"', '\"') + '"}')
    exit 2
}
$writer.WriteLine('{"type":"ready","pid":' + $TargetPid + ',"historyRows":' + $HistoryRows + '}')

# Commands are read on their own thread so a blocked read never delays a frame.
$queue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$pump = [PowerShell]::Create()
[void]$pump.AddScript({
    param($source, $sink)
    while ($true) {
        $line = $source.ReadLine()
        if ($null -eq $line) { $sink.Enqueue('{"type":"stop"}'); break }
        if ($line.Trim()) { $sink.Enqueue($line) }
    }
}).AddArgument($reader).AddArgument($queue)
[void]$pump.BeginInvoke()

$running = $true
$previous = ''
while ($running) {
    $line = ''
    while ($queue.TryDequeue([ref]$line)) {
        $command = $null
        try { $command = $line | ConvertFrom-Json } catch { continue }
        switch ($command.type) {
            'text'  { [void][Mirror]::SendText([string]$command.text) }
            'key'   { [void][Mirror]::SendKey([string]$command.name) }
            'frame' { $previous = '' }
            'stop'  { $running = $false }
        }
    }
    if (-not $running) { break }
    $frame = [Mirror]::Frame($HistoryRows)
    if ($null -eq $frame) {
        $writer.WriteLine('{"type":"error","message":"the console could not be read; it has probably closed"}')
        break
    }
    # An unchanged screen is not resent: the daemon already holds it.
    if ($frame -ne $previous) { $writer.WriteLine($frame); $previous = $frame }
    Start-Sleep -Milliseconds $IntervalMs
}
$pump.Stop()
