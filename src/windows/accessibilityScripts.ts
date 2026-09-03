import type { Bounds, Point } from '../types/geometry';
import { psLiteral } from './powershell';

const assemblies = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes`;

export const accessibilityTreeScript = (handle: string, maxNodes: number, bounds?: Bounds) => {
  const target = bounds || {
    left: -2147483648,
    top: -2147483648,
    right: 2147483647,
    bottom: 2147483647
  };
  return `${assemblies}
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Int64]'${handle}'))
if($null -eq $root){throw 'UI Automation root is unavailable.'}
$cache=[System.Windows.Automation.CacheRequest]::new()
$cache.AutomationElementMode=[System.Windows.Automation.AutomationElementMode]::Full
$cache.TreeFilter=[System.Windows.Automation.Automation]::ControlViewCondition
$cache.TreeScope=[System.Windows.Automation.TreeScope]::Element
@(
[System.Windows.Automation.AutomationElement]::RuntimeIdProperty
[System.Windows.Automation.AutomationElement]::BoundingRectangleProperty
[System.Windows.Automation.AutomationElement]::ControlTypeProperty
[System.Windows.Automation.AutomationElement]::NameProperty
[System.Windows.Automation.AutomationElement]::IsEnabledProperty
[System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty
[System.Windows.Automation.AutomationElement]::IsOffscreenProperty
[System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty
[System.Windows.Automation.AutomationElement]::ClickablePointProperty
[System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty
[System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty
[System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty
[System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty
[System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty
[System.Windows.Automation.AutomationElement]::IsScrollItemPatternAvailableProperty
[System.Windows.Automation.ValuePattern]::ValueProperty
) | ForEach-Object {$cache.Add($_)}
function Get-CachedValue($element,$property){
$value=$element.GetCachedPropertyValue($property,$true)
if([object]::ReferenceEquals($value,[System.Windows.Automation.AutomationElement]::NotSupported)){return $null}
return $value
}
$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
$cachedRoot=$root.GetUpdatedCache($cache)
$queue=[System.Collections.Generic.Queue[object]]::new()
$queue.Enqueue([PSCustomObject]@{element=$cachedRoot;depth=0;parentId=''})
$items=[System.Collections.Generic.List[object]]::new()
$visited=0;$visitLimit=${Math.min(100_000, Math.max(maxNodes, maxNodes * 20))}
while($queue.Count -gt 0 -and $items.Count -lt ${maxNodes} -and $visited -lt $visitLimit){
$visited++
$item=$queue.Dequeue();$element=$item.element
try {
$runtimeId=((Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)) -join '.')
$child=$walker.GetFirstChild($element,$cache)
while($null -ne $child -and ($visited+$queue.Count) -lt $visitLimit){
$queue.Enqueue([PSCustomObject]@{element=$child;depth=([int]$item.depth+1);parentId=$runtimeId})
$child=$walker.GetNextSibling($child,$cache)
}
if(-not $runtimeId){continue}
$rect=Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
if($null -eq $rect){continue}
if($rect.IsEmpty -or $rect.Width -lt 1 -or $rect.Height -lt 1){continue}
if($rect.Right -le ${Math.round(target.left)} -or $rect.Left -ge ${Math.round(target.right)} -or $rect.Bottom -le ${Math.round(target.top)} -or $rect.Top -ge ${Math.round(target.bottom)}){continue}
$enabled=[bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsEnabledProperty))
$focusable=[bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty))
$clickable=Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::ClickablePointProperty)
$hasClickable=$null -ne $clickable -and -not [double]::IsNaN($clickable.X) -and -not [double]::IsNaN($clickable.Y) -and -not [double]::IsInfinity($clickable.X) -and -not [double]::IsInfinity($clickable.Y)
$actions=[System.Collections.Generic.List[string]]::new()
if($enabled -and $focusable){$actions.Add('focus')}
if($enabled -and $hasClickable){$actions.Add('click');$actions.Add('doubleClick');$actions.Add('rightClick');$actions.Add('drag')}
if([bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty))){$actions.Add('setValue')}
if([bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty))){$actions.Add('invoke')}
if([bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty))){$actions.Add('toggle')}
if([bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty))){$actions.Add('select')}
if([bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty))){$actions.Add('expand');$actions.Add('collapse')}
if([bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsScrollItemPatternAvailableProperty))){$actions.Add('scroll')}
$controlType=Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
$name=Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::NameProperty)
$value=Get-CachedValue $element ([System.Windows.Automation.ValuePattern]::ValueProperty)
$items.Add([PSCustomObject]@{
runtimeId=$runtimeId;parentId=[string]$item.parentId;depth=[int]$item.depth
role=$(if($null -ne $controlType){$controlType.ProgrammaticName.Replace('ControlType.','')}else{'Control'});name=[string]$name;value=[string]$value
enabled=$enabled;focused=[bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty));offscreen=[bool](Get-CachedValue $element ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty))
bounds=[PSCustomObject]@{left=[int]$rect.Left;top=[int]$rect.Top;right=[int]$rect.Right;bottom=[int]$rect.Bottom}
clickablePoint=$(if($hasClickable){[PSCustomObject]@{x=[int]$clickable.X;y=[int]$clickable.Y}}else{$null})
actions=@($actions)
}) | Out-Null
} catch {}
}
$items.ToArray() | ConvertTo-Json -Depth 6 -Compress`;
};

export const accessibilityElementScript = (handle: string, runtimeId: string, point?: Point) => `${assemblies}
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Int64]'${handle}'))
if($null -eq $root){throw 'UI Automation root is unavailable.'}
$wanted='${psLiteral(runtimeId)}';$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
$queue=[System.Collections.Generic.Queue[object]]::new();$queue.Enqueue($root)
$element=$null;$visited=0
while($queue.Count -gt 0 -and $null -eq $element -and $visited -lt 30000){
$candidate=$queue.Dequeue();$visited++
try {
if(($candidate.GetRuntimeId() -join '.') -eq $wanted){$element=$candidate;break}
$child=$walker.GetFirstChild($candidate)
while($null -ne $child){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
} catch {}
}
if($null -eq $element){return}
$current=$element.Current;$rect=$current.BoundingRectangle
$clickable=New-Object System.Windows.Point;$hasClickable=$element.TryGetClickablePoint([ref]$clickable)
$pattern=$null;$value=''
if($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$value=[string]$pattern.Current.Value}
$pointerAncestors=[System.Collections.Generic.List[string]]::new()
${point ? `$pointElement=[System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new(${Math.round(point.x)},${Math.round(point.y)}))
$pointWalker=[System.Windows.Automation.TreeWalker]::RawViewWalker
$rootId=($root.GetRuntimeId() -join '.');$ancestor=$pointElement;$ancestorCount=0
while($null -ne $ancestor -and $ancestorCount -lt 128){
$ancestorCount++;$ancestorId=($ancestor.GetRuntimeId() -join '.')
if($ancestorId){$pointerAncestors.Add($ancestorId)}
if($ancestorId -eq $wanted -or $ancestorId -eq $rootId){break}
$ancestor=$pointWalker.GetParent($ancestor)
}` : ''}
[PSCustomObject]@{
runtimeId=$wanted;depth=0;role=$current.ControlType.ProgrammaticName.Replace('ControlType.','');name=[string]$current.Name;value=$value
enabled=[bool]$current.IsEnabled;focused=[bool]$current.HasKeyboardFocus;offscreen=[bool]$current.IsOffscreen;actions=@()
bounds=[PSCustomObject]@{left=[int]$rect.Left;top=[int]$rect.Top;right=[int]$rect.Right;bottom=[int]$rect.Bottom}
clickablePoint=$(if($hasClickable){[PSCustomObject]@{x=[int]$clickable.X;y=[int]$clickable.Y}}else{$null})
pointerAncestors=@($pointerAncestors)
} | ConvertTo-Json -Depth 4 -Compress`;

export const accessibilityActionScript = (handle: string, runtimeId: string, action: string, value: string) => {
  const encodedValue = Buffer.from(value, 'utf8').toString('base64');
  return `${assemblies}
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Int64]'${handle}'))
if($null -eq $root){throw 'UI Automation root is unavailable.'}
$wanted='${psLiteral(runtimeId)}';$action='${psLiteral(action)}'
$value=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedValue}'))
$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
$queue=[System.Collections.Generic.Queue[object]]::new();$queue.Enqueue($root)
$element=$null;$visited=0
while($queue.Count -gt 0 -and $null -eq $element -and $visited -lt 30000){
$candidate=$queue.Dequeue();$visited++
try {
if(($candidate.GetRuntimeId() -join '.') -eq $wanted){$element=$candidate;break}
$child=$walker.GetFirstChild($candidate)
while($null -ne $child){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
} catch {}
}
if($null -eq $element){throw 'UI Automation element is stale or unavailable.'}
$pattern=$null;$performed=$false;$used=''
if($action -eq 'focus'){$element.SetFocus();$performed=$true;$used='SetFocus'}
if($action -eq 'setValue'){
if($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$pattern.SetValue($value);$performed=$true;$used='ValuePattern'}
}
if($action -eq 'toggle'){
if($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$pattern.Toggle();$performed=$true;$used='TogglePattern'}
}
if($action -eq 'select'){
if($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$pattern.Select();$performed=$true;$used='SelectionItemPattern'}
}
if($action -eq 'expand' -or $action -eq 'collapse'){
if($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)){
if($action -eq 'expand'){$pattern.Expand()}else{$pattern.Collapse()};$performed=$true;$used='ExpandCollapsePattern'
}}
if($action -eq 'scroll'){
if($element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern,[ref]$pattern)){$pattern.ScrollIntoView();$performed=$true;$used='ScrollItemPattern'}
}
if($action -eq 'invoke' -or $action -eq 'click'){
if($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();$performed=$true;$used='InvokePattern'}
if(-not $performed -and $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$pattern.Select();$performed=$true;$used='SelectionItemPattern'}
if(-not $performed -and $element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$pattern.Toggle();$performed=$true;$used='TogglePattern'}
}
if(-not $performed){throw "UI Automation action '$action' is unavailable on this element."}
[PSCustomObject]@{performed=$true;action=$action;runtimeId=$wanted;pattern=$used} | ConvertTo-Json -Compress`;
};
