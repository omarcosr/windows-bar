import { expect, test } from "bun:test";
import { dlopen, pointerNumber } from "../src/native/ffi";
import { encodeWide, decodeWide } from "../src/native/wide";
import { fileURLToPath } from "node:url";
import { probeTypedArrays } from "./ffi-typed-arrays-probe.ts";

test("UTF-16LE roundtrip does not rely on the txiki Buffer shim", () => {
  const value = "C:\\ação\\😀.exe";
  const bytes = encodeWide(value);
  expect(bytes.length).toBe((value.length + 1) * 2);
  expect(decodeWide(bytes.buffer, 0, bytes.length - 2)).toBe(value);
  expect([...encodeWide("AB")]).toEqual([65, 0, 66, 0, 0, 0]);
  expect(decodeWide(new Uint8Array([0, 65, 0, 66, 0, 0]).buffer, 1, 4)).toBe("AB");
});

test("Win32 sign-extended handles stay exact without allowing unsafe addresses", () => {
  expect(pointerNumber(0xffffffffe1014366n)).toBe(-520010906);
  expect(pointerNumber(0n)).toBeNull();
  expect(pointerNumber(0x123456789abn)).toBe(0x123456789ab);
  expect(() => pointerNumber(0x20000000000001n)).toThrow(RangeError);
});

test("GetDC handles survive a native roundtrip", () => {
  const { symbols } = dlopen("user32.dll", {
    GetDC: { args: ["ptr"], returns: "ptr" },
    ReleaseDC: { args: ["ptr", "ptr"], returns: "i32" },
  });
  for (let i = 0; i < 100; i++) {
    const dc = symbols.GetDC(null);
    expect(dc).not.toBeNull();
    expect(symbols.ReleaseDC(null, dc)).toBe(1);
  }
});

test("exit cleanup uses process events and leaves pack confirmation to Tarve", () => {
  const result = Bun.spawnSync([process.execPath, "-e", `
    import { exitApp, onExit } from './src/services/exit.ts';
    let calls = 0;
    const remove = onExit(() => { throw new Error('removed handler ran'); });
    remove();
    onExit(() => { calls++; });
    Object.defineProperty(globalThis, Symbol.for('tarve.packHost'), {
      get() { throw new Error('application must not inspect pack host'); }
    });
    process.once('exit', code => console.log(JSON.stringify({ code, calls })));
    exitApp(7);
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(7);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({ code: 7, calls: 1 });
});

test("FFI typed arrays alias native output buffers", () => {
  expect(probeTypedArrays().result).toBe("PASS");
});


