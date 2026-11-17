import { store } from "@tarve/core";
import { output } from "../runtime/proc";

/**
 * The apps pinned to the Windows taskbar, in the taskbar's order. The dock shows the same pins as
 * Windows: the shortcuts in "User Pinned\TaskBar", ordered as Explorer keeps them in the Taskband
 * Favorites blob, plus Store apps pinned by AppUserModelID (they have no shortcut).
 */
export interface TaskbarPin {
  /** What the taskbar starts: the pinned .lnk (with its arguments and AppUserModelID) or shell:AppsFolder\<AUMID>. */
  path: string;
  /** Lower-cased program the running windows are matched against (the shortcut's target exe). */
  key: string;
  /** Program the icon is read from. */
  exe: string;
  name: string;
}

export const taskbarPins = store({ items: [] as TaskbarPin[], loaded: false });

const TASKBAND = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband";

const SCRIPT = String.raw`$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$dir=Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$b=(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband').Favorites
$hex=if($b){[BitConverter]::ToString($b) -replace '-',''}else{''}
function At($text){$h=[BitConverter]::ToString([Text.Encoding]::Unicode.GetBytes($text)) -replace '-','';$i=$hex.IndexOf($h);while($i -ge 0 -and $i%2){$i=$hex.IndexOf($h,$i+1)};if($i -lt 0){[int]::MaxValue}else{$i/2}}
$sh=New-Object -ComObject WScript.Shell
$out=@()
Get-ChildItem -LiteralPath $dir -Filter *.lnk|%{$out+=[pscustomobject]@{at=(At $_.Name);path=$_.FullName;target=$sh.CreateShortcut($_.FullName).TargetPath;name=$_.BaseName}}
if($b){$apps=$null;$seen=@{};foreach($o in 0,1){$n=$b.Length-$o;$n-=$n%2;$t=[Text.Encoding]::Unicode.GetString($b,$o,$n);foreach($m in [regex]::Matches($t,'[\w.-]+_[a-z0-9]{13}![\w.-]+')){$v=$m.Value;if($seen[$v]){continue};$seen[$v]=1;if($apps -eq $null){$apps=@(Get-StartApps)};$app=$apps|?{$v.EndsWith($_.AppID)}|select -First 1;if($app){$out+=[pscustomobject]@{at=$o+2*$m.Index;path="shell:AppsFolder\$($app.AppID)";target='';name=$app.Name}}}}}
ConvertTo-Json @($out|Sort-Object at|select path,target,name) -Compress`;

function encoded(script: string) {
    // -EncodedCommand takes base64 of UTF-16LE; no quoting of the script survives otherwise.
    let binary = "";
    for (let i = 0; i < script.length; i++) {
      const c = script.charCodeAt(i);
      binary += String.fromCharCode(c & 0xff, c >> 8);
    }
    return btoa(binary);
}

async function readPins(): Promise<TaskbarPin[]> {
  const { stdout } = await output(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(SCRIPT)]);
  const text = stdout.trim();
  if (!text) return [];
  const raw = JSON.parse(text) as { path: string; target: string | null; name: string | null }[];
  return (Array.isArray(raw) ? raw : [raw]).map((p) => {
    const program = p.target || p.path;
    const name = p.name || p.path.replace(/^.*[\\!]/, "");
    return { path: p.path, key: program.toLowerCase(), exe: program, name };
  });
}

/** Explorer bumps FavoritesChanges on every pin, unpin and reorder. */
async function favoritesStamp(): Promise<string> {
  const { stdout } = await output(["reg.exe", "query", TASKBAND, "/v", "FavoritesChanges"]);
  return /FavoritesChanges\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(stdout)?.[1] ?? "";
}

/**
 * "Desafixar da barra de tarefas": Windows' own verb on the pinned shortcut (or Store app), the same
 * entry Explorer shows in its menus. Resolves once Explorer has updated its pinned list.
 */
export async function unpinFromTaskbar(pin: TaskbarPin): Promise<boolean> {
  const packaged = pin.path.startsWith("shell:AppsFolder\\");
  const dir = packaged ? "shell:AppsFolder" : pin.path.replace(/\\[^\\]+$/, "");
  const name = packaged ? pin.path.slice("shell:AppsFolder\\".length) : pin.path.slice(dir.length + 1);
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const script = `$i=(New-Object -ComObject Shell.Application).Namespace(${quote(dir)}).ParseName(${quote(name)});if($i){$i.InvokeVerb('taskbarunpin');'ok'}`;
  const { stdout } = await output(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)]);
  await refreshPins?.();
  return stdout.includes("ok");
}

let refreshPins: (() => Promise<void>) | undefined;
let watching = false;

export function watchTaskbarPins() {
  if (watching) return;
  watching = true;
  let stamp: string | null = null;
  const tick = async () => {
    try {
      const next = await favoritesStamp();
      if (next === stamp && taskbarPins.loaded) return;
      const items = await readPins();
      stamp = next;
      if (JSON.stringify(items) !== JSON.stringify(taskbarPins.items)) taskbarPins.items = items;
      taskbarPins.loaded = true;
    } catch (error) {
      console.error("[taskbar-pins]", error);
    }
  };
  refreshPins = async () => {
    stamp = null;
    taskbarPins.loaded = false;
    await tick();
  };
  void tick();
  setInterval(tick, 3000);
}
