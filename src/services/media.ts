import {
  controlSystemMediaSession,
  store,
  systemMediaSessions,
  type ExternalMediaSession,
  type SystemMediaSessionAction,
} from "@tarve/core";
import { basename } from "node:path";
import { itemStrings, PKEY, programOfAppId } from "../native/shell-item";
import { desktop, focusWindow, launch } from "./windows";
import { iconFor } from "./icons";

/** One app's media session, as the Windows media flyout pages through them. */
export interface MediaSource {
  appId: string;
  title: string;
  artist: string;
  playing: boolean;
  /** The session Windows routes media keys to. */
  current: boolean;
}

export const media = store({
  active: false,
  title: "",
  artist: "",
  album: "",
  app: "",
  playing: false,
  position: 0,
  duration: 0,
  /** When position was sampled, to extrapolate progress between updates. */
  sampledAt: 0,
  /** Artwork as a data URL (the session's thumbnail), or "". */
  art: "",
  /** Every app with a media session, in the order Windows lists them. */
  sources: [] as MediaSource[],
});

let timer: ReturnType<typeof setTimeout> | undefined;
let users = 0;
let polling = false;
let lastArtwork: string | undefined;
let lastSources = "";
/** A session the user picked (flyout or menu); followed until it goes away. */
let chosen = "";

/** The session to show: the one picked, else the one media keys reach, else one playing, else the first. */
function pick(sessions: ExternalMediaSession[]) {
  return (
    (chosen ? sessions.find((s) => s.appId === chosen) : undefined) ??
    sessions.find((s) => s.current) ??
    sessions.find((s) => s.playing) ??
    sessions[0]
  );
}

function artUrl(base64: string | undefined) {
  if (!base64) return "";
  const type = base64.startsWith("/9j/") ? "image/jpeg" : "image/png";
  return `data:${type};base64,${base64}`;
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const sessions = await systemMediaSessions();
    if (chosen && !sessions.some((s) => s.appId === chosen)) chosen = "";
    const sources = sessions.map((s) => ({ appId: s.appId, title: s.title ?? "", artist: s.artist ?? "", playing: s.playing, current: s.current }));
    const signature = JSON.stringify(sources);
    if (signature !== lastSources) {
      lastSources = signature;
      media.sources = sources;
    }
    const session = pick(sessions);
    if (!session) {
      if (media.active || media.title || media.app)
        Object.assign(media, { active: false, title: "", artist: "", album: "", app: "", playing: false, position: 0, duration: 0, art: "" });
      lastArtwork = undefined;
      return;
    }
    const next = {
      active: true,
      title: session.title ?? "",
      artist: session.artist ?? "",
      album: session.album ?? "",
      app: session.appId,
      playing: session.playing,
      position: session.position ?? 0,
      duration: session.duration ?? 0,
      sampledAt: Date.now(),
    };
    // Only rebuild the data URL when the artwork changed, so the image is not re-decoded each poll.
    if (session.artwork !== lastArtwork) {
      lastArtwork = session.artwork;
      Object.assign(next, { art: artUrl(session.artwork) });
    }
    // The position is extrapolated between polls (mediaPosition): keep the old sample while it
    // still predicts the session's position, so a poll that changes nothing renders nothing.
    const same = next.app === media.app && next.title === media.title && next.playing === media.playing && next.duration === media.duration;
    if (same && Math.abs(next.position - mediaPosition()) < 1.5) {
      next.position = media.position;
      next.sampledAt = media.sampledAt;
    }
    for (const [key, value] of Object.entries(next)) {
      if ((media as Record<string, unknown>)[key] !== value) (media as Record<string, unknown>)[key] = value;
    }
  } catch (error) {
    console.error("[media]", error);
  } finally {
    polling = false;
    syncClock();
  }
}

/** Each poll asks Windows for every media session (~8 ms): every second while playing, else every 2 s. */
let generation = 0;
function schedule() {
  const run = generation;
  timer = setTimeout(async () => {
    await poll();
    if (users && run === generation) schedule();
  }, media.playing ? 1000 : 2000);
}

export function useMedia(): () => void {
  if (users++ === 0) {
    void poll();
    schedule();
  }
  return () => {
    if (--users === 0) {
      generation++;
      clearTimeout(timer);
      syncClock();
      timer = undefined;
    }
  };
}

async function control(action: SystemMediaSessionAction) {
  if (!media.app) return;
  await controlSystemMediaSession(media.app, action);
  // Pick up the new state sooner than the next poll.
  setTimeout(poll, 250);
}

export const mediaControls = {
  // The button shows what the session reports (re-read 250 ms after the command), as the Windows flyout.
  playPause: () => control("toggle"),
  next: () => control("next"),
  previous: () => control("previous"),
};

/** Seconds played now, extrapolated from the last sample while playing. */
/** Ticks once a second only while something plays, so progress bars move between polls. */
export const mediaClock = store({ tick: 0 });
let clockTimer: ReturnType<typeof setInterval> | undefined;

function syncClock() {
  if (media.playing && users) clockTimer ??= setInterval(() => mediaClock.tick++, 1000);
  else {
    clearInterval(clockTimer);
    clockTimer = undefined;
  }
}

export function mediaPosition() {
  void mediaClock.tick; // a render that shows the position follows the clock
  if (!media.duration) return 0;
  const elapsed = media.playing ? (Date.now() - media.sampledAt) / 1000 : 0;
  return Math.min(media.duration, media.position + elapsed);
}

/** Shows another app's session (the flyout's arrows, the menu's player list). */
export function selectSource(appId: string) {
  chosen = appId;
  void poll();
}

/** Steps through the sessions, as the arrows of the Windows media flyout. */
export function cycleSource(step: 1 | -1) {
  const list = media.sources;
  if (list.length < 2) return;
  const index = list.findIndex((s) => s.appId === media.app);
  selectSource(list[(index + step + list.length) % list.length]!.appId);
}

const names = new Map<string, string>();

/** The player's name as Start lists it ("Spotify", "Google Chrome"), else its running app or exe name. */
export function sourceName(appId: string): string {
  const cached = names.get(appId);
  if (cached !== undefined) return cached;
  let name = "";
  try {
    name = itemStrings(`shell:AppsFolder\\${appId}`, [PKEY.displayName])[0] ?? "";
  } catch {}
  if (!name) name = runningApp(appId)?.name ?? "";
  if (!name) name = basename(appId.replace(/\\/g, "/")).replace(/\.exe$/i, "").replace(/^.*!/, "");
  names.set(appId, name);
  return name;
}

/** The program behind a session's AppUserModelID, lower-cased; "" when the shell knows none. */
function programOf(appId: string) {
  return /\.exe$/i.test(appId) ? programOfAppId(appId.replace(/^.*\\/, "")) || appId.toLowerCase() : programOfAppId(appId);
}

function runningApp(appId: string) {
  const key = `shell:appsfolder\\${appId}`.toLowerCase();
  const byKey = desktop.apps.find((a) => a.key === key);
  if (byKey) return byKey;
  const exe = basename((programOf(appId) || appId).replace(/\\/g, "/")).toLowerCase();
  return desktop.apps.find((a) => basename(a.program.replace(/\\/g, "/")) === exe);
}

/** Brings the player forward (the Windows flyout's title click), or starts it if no window is open. */
export function openPlayer(appId = media.app) {
  if (!appId) return;
  const app = runningApp(appId);
  const target = app?.recent[0];
  if (target) return focusWindow(target);
  const program = programOf(appId);
  launch(/\.exe$/i.test(appId) && program ? program : `shell:AppsFolder\\${appId}`);
}

/** The player's own icon, as the Windows media flyout shows beside its name and when a track has no artwork. */
export function playerIcon(appId: string, size: number): ReturnType<typeof iconFor> {
  if (!appId) return undefined;
  if (/\.exe$/i.test(appId)) return iconFor(programOf(appId) || appId, size);
  return iconFor(`shell:AppsFolder\\${appId}`, size);
}
