export const winApiSource = `
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
public delegate bool EnumWindowsProc(System.IntPtr handle, System.IntPtr state);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc callback, System.IntPtr state);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr handle, out RECT rect);
[System.Runtime.InteropServices.DllImport("dwmapi.dll")]
private static extern int DwmGetWindowAttribute(System.IntPtr handle, uint attribute, out RECT value, int size);
public static bool GetVisualWindowRect(System.IntPtr handle, out RECT rect) {
try {
if(DwmGetWindowAttribute(handle,9,out rect,System.Runtime.InteropServices.Marshal.SizeOf(typeof(RECT)))==0
&& rect.Right>rect.Left && rect.Bottom>rect.Top)return true;
} catch {}
return GetWindowRect(handle,out rect);
}
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsIconic(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindow(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowTextLength(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowText(System.IntPtr handle, System.Text.StringBuilder text, int count);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetCursorPos(out POINT point);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr WindowFromPoint(POINT point);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetAncestor(System.IntPtr handle, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr handle, int command);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool BringWindowToTop(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SetActiveWindow(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SetFocus(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool MoveWindow(System.IntPtr handle, int x, int y, int width, int height, bool repaint);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PostMessage(System.IntPtr handle, uint message, System.IntPtr wParam, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr handle, out uint processId);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool AttachThreadInput(uint attach, uint attachTo, bool state);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public System.UIntPtr extraInfo; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public System.UIntPtr extraInfo; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct HARDWAREINPUT { public uint message; public ushort low; public ushort high; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit)]
public struct INPUTUNION {
[System.Runtime.InteropServices.FieldOffset(0)] public MOUSEINPUT mouse;
[System.Runtime.InteropServices.FieldOffset(0)] public KEYBDINPUT keyboard;
[System.Runtime.InteropServices.FieldOffset(0)] public HARDWAREINPUT hardware;
}
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUTUNION data; }
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
private static extern uint SendInput(uint count, INPUT[] inputs, int size);
public static void PulseAlt() {
INPUT down=new INPUT();down.type=1;down.data.keyboard.virtualKey=0x12;
INPUT up=new INPUT();up.type=1;up.data.keyboard.virtualKey=0x12;up.data.keyboard.flags=2;
INPUT[] inputs=new INPUT[]{down,up};
if(SendInput(2,inputs,System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT))) != 2)
throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
}
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr MonitorFromPoint(POINT point, uint flags);
[System.Runtime.InteropServices.DllImport("shcore.dll")]
public static extern int GetDpiForMonitor(System.IntPtr monitor, int type, out uint dpiX, out uint dpiY);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public struct POINT { public int X; public int Y; }
`;
