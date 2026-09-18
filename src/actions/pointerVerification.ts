import type { PreparedPointer } from '../types/input';
import { pointInBounds } from '../types/geometry';
import { getAccessibilityElement } from '../windows/accessibility';
import { getWindow, windowFromPoint } from '../windows/windows';
import { psLiteral } from '../windows/powershell';
import { accessibilityHitScript } from '../windows/accessibilityScripts';

const sameBounds = (first: NonNullable<PreparedPointer['windowBounds']>, second: NonNullable<PreparedPointer['windowBounds']>) =>
  first.left === second.left && first.top === second.top && first.right === second.right && first.bottom === second.bottom;

const boundsNear = (first: NonNullable<PreparedPointer['elementScreenBounds']>, second: NonNullable<PreparedPointer['elementScreenBounds']>, tolerance = 3) =>
  Math.max(
    Math.abs(first.left - second.left),
    Math.abs(first.top - second.top),
    Math.abs(first.right - second.right),
    Math.abs(first.bottom - second.bottom)
  ) <= tolerance;

const semantic = (value?: string) => (value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

export const verifyPointerWindow = async (prepared: PreparedPointer, signal?: AbortSignal) => {
  if (!prepared.windowHandle || !prepared.windowBounds) return;
  const current = await getWindow(prepared.windowHandle, signal);
  if (!current || !sameBounds(current.bounds, prepared.windowBounds)) throw new Error('Target window moved, resized, or closed after pointer preparation.');
  if (prepared.observation.window && current.processId !== prepared.observation.window.processId) throw new Error('Target window was replaced after pointer preparation.');
};

export const verifyPointerElement = async (prepared: PreparedPointer, signal?: AbortSignal) => {
  if (!prepared.windowHandle || !prepared.uiaRuntimeId || !prepared.elementScreenBounds) return;
  const current = await getAccessibilityElement(prepared.windowHandle, prepared.uiaRuntimeId, signal, prepared.target);
  if (!current || !current.enabled || current.offscreen) throw new Error('Prepared UI Automation element is stale, disabled, or offscreen.');
  if (!boundsNear(current.bounds, prepared.elementScreenBounds) || !pointInBounds(prepared.target, current.bounds)) {
    throw new Error('Prepared UI Automation element moved or changed geometry.');
  }
  if (semantic(current.role) !== semantic(prepared.uiaRole) || semantic(current.name) !== semantic(prepared.uiaName)
    || semantic(current.value) !== semantic(prepared.uiaValue)) {
    throw new Error('Prepared UI Automation element identity changed.');
  }
  if (!current.pointerAncestors?.includes(prepared.uiaRuntimeId)) {
    throw new Error('Prepared point no longer resolves to the intended UI Automation element.');
  }
};

export const verifyPointerHit = async (prepared: Pick<PreparedPointer, 'windowHandle' | 'target'>, signal?: AbortSignal) => {
  const hit = await windowFromPoint(prepared.target, signal);
  if (!prepared.windowHandle) return hit;
  if (!hit) throw new Error('The target window could not be verified at the prepared point.');
  if (hit.handle !== prepared.windowHandle) throw new Error(`Prepared point is occluded by ${hit.title || hit.handle}.`);
  return hit;
};

export const pointerGuardScript = (prepared: PreparedPointer) => {
  const bounds = prepared.windowBounds;
  const elementBounds = prepared.elementScreenBounds;
  return `
if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge ${Date.parse(prepared.expiresAt)}){throw 'Prepared pointer expired before native input.'}
$targetHandle=[IntPtr]([Int64]'${prepared.windowHandle || '0'}')
${prepared.uiaRuntimeId && elementBounds ? `
if(-not ('System.Windows.Automation.AutomationElement' -as [type])){
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
}
$wanted='${psLiteral(prepared.uiaRuntimeId)}'
${accessibilityHitScript(prepared.target)}
$element=$pointElement;$walker=$pointWalker;$found=$false;$visited=0
while($null -ne $element -and $visited -lt 128){
$visited++
if(($element.GetRuntimeId() -join '.') -eq $wanted){$found=$true;break}
$hitType=$element.Current.ControlType
if($hitType -ne [System.Windows.Automation.ControlType]::Text -and $hitType -ne [System.Windows.Automation.ControlType]::Image){
if($element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty) -or
$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty) -or
$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)){break}
}
$element=$walker.GetParent($element)
}
if(-not $found){throw 'Native hit test no longer resolves to the prepared control.'}
$current=$element.Current;$rect=$current.BoundingRectangle
if(-not $current.IsEnabled -or $current.IsOffscreen){throw 'Prepared control is unavailable.'}
if([Math]::Abs($rect.Left-${elementBounds.left}) -gt 3 -or [Math]::Abs($rect.Top-${elementBounds.top}) -gt 3 -or
[Math]::Abs($rect.Right-${elementBounds.right}) -gt 3 -or [Math]::Abs($rect.Bottom-${elementBounds.bottom}) -gt 3){throw 'Prepared control geometry changed.'}
$value='';$pattern=$null
if($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$value=[string]$pattern.Current.Value}
if($current.ControlType.ProgrammaticName.Replace('ControlType.','') -cne '${psLiteral(prepared.uiaRole || '')}' -or
[string]$current.Name -cne '${psLiteral(prepared.uiaName || '')}' -or $value -cne '${psLiteral(prepared.uiaValue || '')}'){
throw 'Prepared control identity changed before native input.'
}` : ''}
${bounds ? `
$rect=New-Object ComputerUse.WindowApi+RECT
if(-not [ComputerUse.WindowApi]::GetVisualWindowRect($targetHandle,[ref]$rect) -or
$rect.Left -ne ${bounds.left} -or $rect.Top -ne ${bounds.top} -or $rect.Right -ne ${bounds.right} -or $rect.Bottom -ne ${bounds.bottom}){
throw 'Prepared window geometry changed before native input.'
}
if([ComputerUse.WindowApi]::IsIconic($targetHandle) -or -not [ComputerUse.WindowApi]::IsWindowVisible($targetHandle)){throw 'Prepared window is unavailable.'}
$targetProcess=[uint32]0
[ComputerUse.WindowApi]::GetWindowThreadProcessId($targetHandle,[ref]$targetProcess) | Out-Null
if($targetProcess -ne ${prepared.windowProcessId || 0}){throw 'Prepared window process changed.'}` : ''}
$cursor=[InputBridge.NativeInput]::Cursor()
if([Math]::Abs($cursor[0]-${prepared.target.x}) -gt 2 -or [Math]::Abs($cursor[1]-${prepared.target.y}) -gt 2){throw 'Pointer moved before native input.'}
$hitHandle=[IntPtr]([InputBridge.NativeInput]::WindowAtCursor())
if([ComputerUse.WindowApi]::GetAncestor($hitHandle,2) -ne $targetHandle){throw 'Prepared point is occluded before native input.'}
if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge ${Date.parse(prepared.expiresAt)}){throw 'Prepared pointer expired during native verification.'}`;
};
