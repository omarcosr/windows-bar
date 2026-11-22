import { dirname, join, resolve } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dlopen } from "../native/ffi";
import { decodeWide, encodeWide } from "../native/wide";
import { output } from "../runtime/proc";

/**
 * "Start with Windows" through a Task Scheduler task with a logon trigger, chosen over the
 * per-user Run key: Explorer starts the Run key's apps one after another, throttled, long after
 * logon (measured: 78 s after Explorer, behind Discord, Docker, Kiri and Edge), while a logon task
 * starts the dock as the session starts. The cost: the dock is no longer listed under Settings >
 * Apps > Startup or Task Manager's startup apps; the task can be turned off in Task Scheduler,
 * and this switch follows that (the task's Enabled flag).
 *
 * The old Run entry (and its StartupApproved switch) is removed whenever the task is written, and
 * migrated once at start (migrateAutostart) for docks installed before this change.
 */
const advapi32 = dlopen("advapi32.dll", {
  RegGetValueW: { args: ["u64", "ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
  RegDeleteKeyValueW: { args: ["u64", "ptr", "ptr"], returns: "i32" },
});
const A = advapi32.symbols;

const HKCU = 0xffffffff80000001n;
const RUN = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const NAME = "WindowsBar";
const SCHTASKS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");

function user() {
  const domain = process.env.USERDOMAIN;
  const name = process.env.USERNAME ?? "";
  return domain ? `${domain}\\${name}` : name;
}
/** One task per user: Task Scheduler's root folder is shared by every account on the PC. */
const taskName = () => `WindowsBar (${process.env.USERNAME ?? "user"})`;

/** The built exe starts itself; under bun (development) the script is passed too. */
function command(): { exe: string; args: string; dir: string } {
  const exe = process.execPath;
  const dev = /\\(?:bun|node|tjs)(\.exe)?$/i.test(exe) && process.argv[1];
  // A task starts in System32; under bun the project's folder holds its tsconfig (the JSX runtime).
  return dev ? { exe, args: `"${resolve(process.argv[1]!)}"`, dir: process.cwd() } : { exe, args: "", dir: dirname(exe) };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The task: at this user's logon, no delay, as the user (no elevation), on battery too, never
 * stopped for running long, normal priority (a task's default, 7, is below normal for CPU and I/O),
 * one dock at a time.
 */
function taskXml() {
  const { exe, args, dir } = command();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts WindowsBar when you sign in.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user())}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user())}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(exe)}</Command>${args ? `<Arguments>${xml(args)}</Arguments>` : ""}<WorkingDirectory>${xml(dir)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

function removeRunEntry() {
  A.RegDeleteKeyValueW(HKCU, encodeWide(RUN), encodeWide(NAME));
  A.RegDeleteKeyValueW(HKCU, encodeWide(APPROVED), encodeWide(NAME));
}

export async function setAutostart(on: boolean): Promise<void> {
  removeRunEntry();
  if (!on) {
    await output([SCHTASKS, "/Delete", "/TN", taskName(), "/F"]);
    return;
  }
  // schtasks reads the definition from a UTF-16 file.
  const file = join(tmpdir(), `windowsbar-task-${process.pid}.xml`);
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(), "utf16le")]));
  try {
    const { code } = await output([SCHTASKS, "/Create", "/TN", taskName(), "/XML", file, "/F"]);
    if (code !== 0) console.error("[autostart] schtasks /Create failed:", code);
  } finally {
    rmSync(file, { force: true });
  }
}

/** On when the logon task exists and is enabled (it can be turned off in Task Scheduler). */
export async function readAutostart(): Promise<boolean> {
  const { code, stdout } = await output([SCHTASKS, "/Query", "/TN", taskName(), "/XML"]).catch(() => ({ code: -1, stdout: "" }));
  if (code !== 0) return false;
  // The task's own <Enabled> is the last one, in <Settings>; the trigger's comes first.
  const flags = [...stdout.matchAll(/<Enabled>(true|false)<\/Enabled>/g)].map((m) => m[1]);
  return flags.length === 0 || flags[flags.length - 1] === "true";
}

/** A dock installed with the Run key: its entry becomes the logon task (only if it was on). */
export async function migrateAutostart(): Promise<void> {
  const text = new Uint16Array(1024);
  const size = new Uint32Array([text.byteLength]);
  if (A.RegGetValueW(HKCU, encodeWide(RUN), encodeWide(NAME), 0x2 /* RRF_RT_REG_SZ */, null, new Uint8Array(text.buffer), new Uint8Array(size.buffer)) !== 0) return;
  if (!decodeWide(text.buffer, 0, Math.max(0, size[0]! - 2))) return removeRunEntry();
  const approved = new Uint8Array(12);
  const approvedSize = new Uint32Array([approved.byteLength]);
  const status = A.RegGetValueW(HKCU, encodeWide(APPROVED), encodeWide(NAME), 0x8 /* RRF_RT_REG_BINARY */, null, approved, new Uint8Array(approvedSize.buffer));
  // No StartupApproved entry means enabled; an odd first byte (3) means the user turned it off.
  const on = status !== 0 || (approved[0]! & 1) === 0;
  if (on) await setAutostart(true);
  else removeRunEntry();
}
