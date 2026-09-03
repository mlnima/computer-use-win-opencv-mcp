import { nativeInputMemberSource } from './nativeSource';

export const nativeInputSourceBase64 = Buffer.from(nativeInputMemberSource, 'utf8').toString('base64');

export const inputWorkerScript = String.raw`
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:COMPUTER_USE_NATIVE_INPUT_SOURCE))
Add-Type -MemberDefinition $source -Language CSharp -Name NativeInput -Namespace InputBridge -UsingNamespace System.ComponentModel
[InputBridge.NativeInput]::Initialize()
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
$heldButtons = @{}
$heldKeys = @{}
try {
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $command = $line | ConvertFrom-Json
    $data = $null
    switch ($command.op) {
      'probe' {
        $cursor = [InputBridge.NativeInput]::Cursor()
        $screen = [InputBridge.NativeInput]::VirtualScreen()
        $data = @{ x = $cursor[0]; y = $cursor[1]; windowHandle = ([InputBridge.NativeInput]::WindowAtCursor()).ToString(); screen = @{ left = $screen[0]; top = $screen[1]; width = $screen[2]; height = $screen[3] } }
      }
      'moveAbsolute' { [InputBridge.NativeInput]::MoveAbsolute([int]$command.x, [int]$command.y) }
      'moveRelative' { [InputBridge.NativeInput]::MoveRelative([int]$command.x, [int]$command.y) }
      'button' {
        [InputBridge.NativeInput]::Button([string]$command.button, [bool]$command.down)
        if ([bool]$command.down) { $heldButtons[[string]$command.button] = $true } else { [void]$heldButtons.Remove([string]$command.button) }
      }
      'wheel' { [InputBridge.NativeInput]::Wheel([int]$command.deltaX, [int]$command.deltaY) }
      'virtualKey' {
        [InputBridge.NativeInput]::VirtualKey([int]$command.key, [bool]$command.down, [bool]$command.extended)
        $identity = "virtualKey:$($command.key):$($command.extended)"
        if ([bool]$command.down) { $heldKeys[$identity] = $command } else { [void]$heldKeys.Remove($identity) }
      }
      'scanCode' {
        [InputBridge.NativeInput]::ScanCode([int]$command.scan, [bool]$command.down, [bool]$command.extended)
        $identity = "scanCode:$($command.scan):$($command.extended)"
        if ([bool]$command.down) { $heldKeys[$identity] = $command } else { [void]$heldKeys.Remove($identity) }
      }
      'mappedScanCode' {
        [InputBridge.NativeInput]::ScanFromVirtualKey([int]$command.key, [bool]$command.down, [bool]$command.extended)
        $identity = "mappedScanCode:$($command.key):$($command.extended)"
        if ([bool]$command.down) { $heldKeys[$identity] = $command } else { [void]$heldKeys.Remove($identity) }
      }
      'text' { [InputBridge.NativeInput]::UnicodeText([string]$command.text) }
      'releaseAll' {
        $buttonCount = 0
        $keyCount = 0
        $releaseErrors = [System.Collections.Generic.List[string]]::new()
        foreach ($button in @($heldButtons.Keys)) {
          try {
            [InputBridge.NativeInput]::Button([string]$button, $false)
            [void]$heldButtons.Remove([string]$button)
            $buttonCount += 1
          } catch { $releaseErrors.Add("mouse $($button): $($_.Exception.Message)") }
        }
        foreach ($identity in @($heldKeys.Keys)) {
          $key = $heldKeys[$identity]
          try {
            if ($key.op -eq 'virtualKey') { [InputBridge.NativeInput]::VirtualKey([int]$key.key, $false, [bool]$key.extended) }
            elseif ($key.op -eq 'scanCode') { [InputBridge.NativeInput]::ScanCode([int]$key.scan, $false, [bool]$key.extended) }
            else { [InputBridge.NativeInput]::ScanFromVirtualKey([int]$key.key, $false, [bool]$key.extended) }
            [void]$heldKeys.Remove([string]$identity)
            $keyCount += 1
          } catch { $releaseErrors.Add("key $($identity): $($_.Exception.Message)") }
        }
        if ($releaseErrors.Count -gt 0) { throw "Native input release failed: $($releaseErrors -join '; ')" }
        $data = @{ buttons = $buttonCount; keys = $keyCount }
      }
      'close' { $data = @{ closing = $true } }
      default { throw "Unsupported input operation" }
    }
    @{ id = [string]$command.id; ok = $true; data = $data } | ConvertTo-Json -Compress -Depth 6 | ForEach-Object { [Console]::Out.WriteLine($_) }
    [Console]::Out.Flush()
    if ($command.op -eq 'close') { break }
  } catch {
    @{ id = [string]$command.id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 4 | ForEach-Object { [Console]::Out.WriteLine($_) }
    [Console]::Out.Flush()
  }
}
} finally {
  foreach ($button in @($heldButtons.Keys)) { try { [InputBridge.NativeInput]::Button([string]$button, $false) } catch { } }
  foreach ($key in @($heldKeys.Values)) {
    try {
      if ($key.op -eq 'virtualKey') { [InputBridge.NativeInput]::VirtualKey([int]$key.key, $false, [bool]$key.extended) }
      elseif ($key.op -eq 'scanCode') { [InputBridge.NativeInput]::ScanCode([int]$key.scan, $false, [bool]$key.extended) }
      else { [InputBridge.NativeInput]::ScanFromVirtualKey([int]$key.key, $false, [bool]$key.extended) }
    } catch { }
  }
}
`;
