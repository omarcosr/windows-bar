import { store } from "@tarve/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config";
import { tapKey, VK } from "../native/win32";
import mediaScript from "../../scripts/media.ps1" with { type: "text" };

export const media = store({
  active: false,
  title: "",
  artist: "",
  app: "",
  playing: false,
  position: 0,
  duration: 0,
  /** When position was sampled, to extrapolate progress between updates. */
  sampledAt: 0,
  art: "",
});

let proc: ReturnType<typeof Bun.spawn> | undefined;
let users = 0;

async function start() {
  const dir = join(configDir, "media");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "media.ps1");
  writeFileSync(script, mediaScript);
  proc = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, dir], {
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        const data = JSON.parse(line);
        Object.assign(media, {
          active: !!data.active,
          title: data.title ?? "",
          artist: data.artist ?? "",
          app: data.app ?? "",
          playing: !!data.playing,
          position: Number(data.position) || 0,
          duration: Number(data.duration) || 0,
          art: data.art ?? "",
          sampledAt: Date.now(),
        });
      } catch {}
    }
  }
}

export function useMedia(): () => void {
  if (users++ === 0) start().catch((error) => console.error("[media]", error));
  return () => {
    if (--users === 0) {
      proc?.kill();
      proc = undefined;
    }
  };
}

export const mediaControls = {
  playPause() {
    tapKey(VK.MEDIA_PLAY_PAUSE);
    media.playing = !media.playing;
  },
  next: () => tapKey(VK.MEDIA_NEXT),
  previous: () => tapKey(VK.MEDIA_PREV),
};

process.on("exit", () => proc?.kill());
