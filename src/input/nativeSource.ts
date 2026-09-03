export const nativeInputMemberSource = String.raw`
[StructLayout(LayoutKind.Sequential)]
public struct POINT
{
    public int X;
    public int Y;
}

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT
{
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT
{
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct HARDWAREINPUT
{
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
}

[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION
{
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
}

[StructLayout(LayoutKind.Sequential)]
public struct INPUT
{
    public uint type;
    public INPUTUNION U;
}

[DllImport("user32.dll", SetLastError = true)]
private static extern uint SendInput(uint count, INPUT[] inputs, int size);

[DllImport("user32.dll", SetLastError = true)]
private static extern bool GetPhysicalCursorPos(out POINT point);

[DllImport("user32.dll", SetLastError = true)]
private static extern bool GetCursorPos(out POINT point);

[DllImport("user32.dll")]
private static extern int GetSystemMetrics(int index);

[DllImport("user32.dll")]
private static extern IntPtr WindowFromPoint(POINT point);

[DllImport("user32.dll")]
private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

[DllImport("user32.dll")]
private static extern uint MapVirtualKey(uint code, uint mapType);

private const uint INPUT_MOUSE = 0;
private const uint INPUT_KEYBOARD = 1;
private const uint MOUSEEVENTF_MOVE = 0x0001;
private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
private const uint MOUSEEVENTF_LEFTUP = 0x0004;
private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
private const uint MOUSEEVENTF_XDOWN = 0x0080;
private const uint MOUSEEVENTF_XUP = 0x0100;
private const uint MOUSEEVENTF_WHEEL = 0x0800;
private const uint MOUSEEVENTF_HWHEEL = 0x1000;
private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
private const uint KEYEVENTF_KEYUP = 0x0002;
private const uint KEYEVENTF_UNICODE = 0x0004;
private const uint KEYEVENTF_SCANCODE = 0x0008;

private static void Submit(INPUT input)
{
    SubmitMany(new INPUT[] { input });
}

private static void SubmitMany(INPUT[] inputs)
{
    uint count = unchecked((uint)inputs.Length);
    uint sent = SendInput(count, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != count) throw new Win32Exception(Marshal.GetLastWin32Error());
}

private static INPUT MouseInput(int x, int y, uint data, uint flags)
{
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.U.mi.dx = x;
    input.U.mi.dy = y;
    input.U.mi.mouseData = data;
    input.U.mi.dwFlags = flags;
    return input;
}

private static INPUT KeyboardInput(ushort key, ushort scan, uint flags)
{
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.U.ki.wVk = key;
    input.U.ki.wScan = scan;
    input.U.ki.dwFlags = flags;
    return input;
}

public static void Initialize()
{
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
}

public static int[] Cursor()
{
    POINT point;
    if (!GetPhysicalCursorPos(out point) && !GetCursorPos(out point))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    return new int[] { point.X, point.Y };
}

public static long WindowAtCursor()
{
    int[] position = Cursor();
    POINT point = new POINT();
    point.X = position[0];
    point.Y = position[1];
    return WindowFromPoint(point).ToInt64();
}

public static int[] VirtualScreen()
{
    return new int[] {
        GetSystemMetrics(76), GetSystemMetrics(77),
        GetSystemMetrics(78), GetSystemMetrics(79)
    };
}

public static void MoveAbsolute(int x, int y)
{
    int left = GetSystemMetrics(76);
    int top = GetSystemMetrics(77);
    int width = Math.Max(1, GetSystemMetrics(78));
    int height = Math.Max(1, GetSystemMetrics(79));
    int clampedX = Math.Max(left, Math.Min(left + width - 1, x));
    int clampedY = Math.Max(top, Math.Min(top + height - 1, y));
    int normalizedX = width == 1 ? 0 : (int)Math.Round((clampedX - left) * 65535.0 / (width - 1));
    int normalizedY = height == 1 ? 0 : (int)Math.Round((clampedY - top) * 65535.0 / (height - 1));
    Submit(MouseInput(normalizedX, normalizedY, 0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
}

public static void MoveRelative(int x, int y)
{
    Submit(MouseInput(x, y, 0, MOUSEEVENTF_MOVE));
}

public static void Button(string button, bool down)
{
    uint flags;
    uint data = 0;
    switch (button)
    {
        case "left": flags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
        case "right": flags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
        case "middle": flags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
        case "x1": flags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP; data = 1; break;
        case "x2": flags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP; data = 2; break;
        default: throw new ArgumentException("Unsupported mouse button");
    }
    Submit(MouseInput(0, 0, data, flags));
}

public static void Wheel(int deltaX, int deltaY)
{
    if (deltaY != 0) Submit(MouseInput(0, 0, unchecked((uint)deltaY), MOUSEEVENTF_WHEEL));
    if (deltaX != 0) Submit(MouseInput(0, 0, unchecked((uint)deltaX), MOUSEEVENTF_HWHEEL));
}

public static void VirtualKey(int key, bool down, bool extended)
{
    uint flags = down ? 0 : KEYEVENTF_KEYUP;
    if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
    Submit(KeyboardInput(unchecked((ushort)key), 0, flags));
}

public static void ScanCode(int scan, bool down, bool extended)
{
    uint flags = KEYEVENTF_SCANCODE | (down ? 0 : KEYEVENTF_KEYUP);
    if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
    Submit(KeyboardInput(0, unchecked((ushort)scan), flags));
}

public static void ScanFromVirtualKey(int key, bool down, bool extended)
{
    uint scan = MapVirtualKey(unchecked((uint)key), 0);
    if (scan == 0) throw new ArgumentException("Virtual key has no scan code mapping");
    ScanCode(unchecked((int)scan), down, extended);
}

public static void UnicodeText(string text)
{
    const int chunkSize = 256;
    for (int offset = 0; offset < text.Length; offset += chunkSize)
    {
        int length = Math.Min(chunkSize, text.Length - offset);
        INPUT[] inputs = new INPUT[length * 2];
        for (int index = 0; index < length; index++)
        {
            char value = text[offset + index];
            inputs[index * 2] = KeyboardInput(0, value, KEYEVENTF_UNICODE);
            inputs[index * 2 + 1] = KeyboardInput(0, value, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        }
        SubmitMany(inputs);
    }
}
`;
