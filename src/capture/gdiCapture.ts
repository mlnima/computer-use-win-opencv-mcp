import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bounds } from '../types/geometry';
import { runPowerShell } from '../windows/powershell';

const dimension = (end: number, start: number) => Math.max(1, Math.round(end - start));

export const captureGdi = async (bounds: Bounds, includeCursor: boolean, signal?: AbortSignal) => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-win-capture-'));
  const file = join(directory, 'frame.png');
  const encodedFile = Buffer.from(file, 'utf8').toString('base64');
  try {
    await runPowerShell(`
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);' -Name DpiApi -Namespace ComputerUse
[ComputerUse.DpiApi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$file=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFile}'))
$bounds=New-Object System.Drawing.Rectangle(${Math.round(bounds.left)},${Math.round(bounds.top)},${dimension(bounds.right, bounds.left)},${dimension(bounds.bottom, bounds.top)})
$bitmap=[System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try {
$graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bounds.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
if(${includeCursor ? '$true' : '$false'}){
$cursor=[System.Windows.Forms.Cursor]::Current;$point=[System.Windows.Forms.Cursor]::Position
if($null -ne $cursor -and $bounds.Contains($point)){
$x=$point.X-$bounds.Left-$cursor.HotSpot.X;$y=$point.Y-$bounds.Top-$cursor.HotSpot.Y
$cursor.Draw($graphics,(New-Object System.Drawing.Rectangle($x,$y,$cursor.Size.Width,$cursor.Size.Height)))
}}
$bitmap.Save($file,[System.Drawing.Imaging.ImageFormat]::Png)
} finally {$graphics.Dispose();$bitmap.Dispose()}`, 20_000, signal);
    return {
      bytes: await readFile(file, signal ? { signal } : undefined),
      width: dimension(bounds.right, bounds.left),
      height: dimension(bounds.bottom, bounds.top),
      bounds,
      backend: 'gdi-copy-from-screen'
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};
