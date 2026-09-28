/**
 * C# source of the desktop helper: one small console process that owns everything Node cannot reach
 * without a native addon — DXGI output geometry (the same enumeration ffmpeg's ddagrab indexes),
 * SendInput for mouse and keyboard, and the Windows clipboard. It reads one command per stdin line
 * and answers queries with one JSON line on stdout. Compiled with the csc.exe every Windows install
 * ships in the .NET Framework directory, so nothing has to be installed.
 */
export const DESKTOP_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class GgoDesktop {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct DXGI_OUTPUT_DESC {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public int Left; public int Top; public int Right; public int Bottom;
    public int AttachedToDesktop; public int Rotation; public IntPtr Monitor;
  }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumDelegate(IntPtr self, uint index, out IntPtr result);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutputDescDelegate(IntPtr self, out DXGI_OUTPUT_DESC desc);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint ReleaseDelegate(IntPtr self);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004, KEY_SCANCODE = 0x0008;
  static bool blocked;

  [STAThread]
  static void Main() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    string line;
    while ((line = Console.ReadLine()) != null) {
      string[] a = line.Split(' ');
      // A query's id is its second token; for an input command that token matches no waiting query.
      try { Handle(a); }
      catch (Exception e) { Reply("{\"id\":" + Json(a.Length > 1 ? a[1] : "") + ",\"error\":" + Json(e.Message) + "}"); }
    }
  }

  static void Handle(string[] a) {
    switch (a[0]) {
      case "displays": Reply("{\"id\":" + Json(a[1]) + ",\"displays\":" + Displays() + ",\"virtual\":" + VirtualScreen() + ",\"elevated\":" + (Elevated() ? "true" : "false") + "}"); break;
      case "move": Move(int.Parse(a[1]), int.Parse(a[2])); break;
      case "button": Button(a[1], a[2] == "1"); break;
      case "wheel": Wheel(int.Parse(a[1]), int.Parse(a[2])); break;
      case "key": Key(ushort.Parse(a[1]), a[2] == "1", a[3] == "1"); break;
      case "text": Text(Decode(a[1])); break;
      case "clipget": Reply("{\"id\":" + Json(a[1]) + ",\"text\":" + Json(ClipboardText()) + "}"); break;
      case "clipset": SetClipboard(Decode(a[2])); Reply("{\"id\":" + Json(a[1]) + ",\"ok\":true}"); break;
      case "ping": Reply("{\"id\":" + Json(a[1]) + ",\"ok\":true}"); break;
    }
  }

  static string Displays() {
    var parts = new List<string>();
    Guid factoryId = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr factory;
    if (CreateDXGIFactory1(ref factoryId, out factory) < 0) return "[]";
    IntPtr adapter;
    // Adapter 0 is the default adapter, which is the one ffmpeg's ddagrab opens its device on.
    if (Call<EnumDelegate>(factory, 12)(factory, 0, out adapter) >= 0) {
      for (uint i = 0; ; i++) {
        IntPtr output;
        if (Call<EnumDelegate>(adapter, 7)(adapter, i, out output) < 0) break;
        DXGI_OUTPUT_DESC d;
        if (Call<OutputDescDelegate>(output, 7)(output, out d) >= 0) {
          parts.Add("{\"index\":" + i + ",\"name\":" + Json(d.DeviceName) + ",\"x\":" + d.Left + ",\"y\":" + d.Top +
            ",\"width\":" + (d.Right - d.Left) + ",\"height\":" + (d.Bottom - d.Top) +
            ",\"primary\":" + (d.Left == 0 && d.Top == 0 ? "true" : "false") + ",\"rotation\":" + d.Rotation + "}");
        }
        Call<ReleaseDelegate>(output, 2)(output);
      }
      Call<ReleaseDelegate>(adapter, 2)(adapter);
    }
    Call<ReleaseDelegate>(factory, 2)(factory);
    return "[" + string.Join(",", parts) + "]";
  }

  static T Call<T>(IntPtr com, int slot) where T : class {
    IntPtr vtable = Marshal.ReadIntPtr(com);
    return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtable, slot * IntPtr.Size), typeof(T)) as T;
  }

  static string VirtualScreen() {
    return "{\"x\":" + GetSystemMetrics(76) + ",\"y\":" + GetSystemMetrics(77) + ",\"width\":" + GetSystemMetrics(78) + ",\"height\":" + GetSystemMetrics(79) + "}";
  }

  static bool Elevated() {
    return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
  }

  static void Move(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    Mouse(nx, ny, 0, MOVE | ABSOLUTE | VIRTUALDESK);
  }

  static void Button(string which, bool down) {
    switch (which) {
      case "left": Mouse(0, 0, 0, down ? 0x0002u : 0x0004u); break;
      case "right": Mouse(0, 0, 0, down ? 0x0008u : 0x0010u); break;
      case "middle": Mouse(0, 0, 0, down ? 0x0020u : 0x0040u); break;
      case "back": Mouse(0, 0, 1, down ? 0x0080u : 0x0100u); break;
      case "forward": Mouse(0, 0, 2, down ? 0x0080u : 0x0100u); break;
    }
  }

  static void Wheel(int dy, int dx) {
    if (dy != 0) Mouse(0, 0, unchecked((uint)dy), WHEEL);
    if (dx != 0) Mouse(0, 0, unchecked((uint)dx), HWHEEL);
  }

  static void Key(ushort scan, bool extended, bool down) {
    uint flags = KEY_SCANCODE | (extended ? KEY_EXTENDED : 0) | (down ? 0 : KEY_UP);
    Keyboard(0, scan, flags);
  }

  static void Text(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { Key(0x1c, false, true); Key(0x1c, false, false); continue; }
      if (c == '\t') { Key(0x0f, false, true); Key(0x0f, false, false); continue; }
      Keyboard(0, c, KEY_UNICODE);
      Keyboard(0, c, KEY_UNICODE | KEY_UP);
    }
  }

  static void Mouse(int dx, int dy, uint data, uint flags) {
    var input = new INPUT { type = INPUT_MOUSE };
    input.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
    Send(input);
  }

  static void Keyboard(ushort vk, ushort scan, uint flags) {
    var input = new INPUT { type = INPUT_KEYBOARD };
    input.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    Send(input);
  }

  // SendInput answers 0 when the input is refused: an elevated window has focus (UIPI) or the secure
  // desktop (UAC prompt, lock screen) is up. Report the transition once, not every event.
  static void Send(INPUT input) {
    uint sent = SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    bool nowBlocked = sent == 0;
    if (nowBlocked != blocked) {
      blocked = nowBlocked;
      Reply("{\"event\":\"" + (blocked ? "blocked" : "unblocked") + "\"}");
    }
  }

  static string ClipboardText() {
    for (int attempt = 0; attempt < 5; attempt++) {
      try { return Clipboard.ContainsText() ? Clipboard.GetText() : ""; }
      catch (ExternalException) { Thread.Sleep(40); }
    }
    throw new Exception("The PC clipboard is busy in another app.");
  }

  static void SetClipboard(string text) {
    for (int attempt = 0; attempt < 5; attempt++) {
      try { if (text.Length == 0) Clipboard.Clear(); else Clipboard.SetText(text); return; }
      catch (ExternalException) { Thread.Sleep(40); }
    }
    throw new Exception("The PC clipboard is busy in another app.");
  }

  static string Decode(string base64) { return Encoding.UTF8.GetString(Convert.FromBase64String(base64)); }

  static void Reply(string json) { Console.Out.Write(json + "\n"); Console.Out.Flush(); }

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
}
`;
