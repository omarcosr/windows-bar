import {
  controlSystemMediaSession,
  store,
  systemMediaSessions,
  type ExternalMediaSession,
  type SystemMediaSessionAction,
} from "@tarve/core";

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
  /** Artwork as a data URL (the session's thumbnail), or "". */
  art: "",
});

let timer: ReturnType<typeof setInterval> | undefined;
let users = 0;
let polling = false;
let lastArtwork: string | undefined;

/** The session to show: the one media keys reach, else one that is playing, else the first. */
function pick(sessions: ExternalMediaSession[]) {
  return sessions.find((s) => s.current) ?? sessions.find((s) => s.playing) ?? sessions[0];
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
    const session = pick(await systemMediaSessions());
    if (!session) {
      Object.assign(media, { active: false, title: "", artist: "", app: "", playing: false, position: 0, duration: 0, art: "" });
      lastArtwork = undefined;
      return;
    }
    const next = {
      active: true,
      title: session.title ?? "",
      artist: session.artist ?? "",
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
    Object.assign(media, next);
  } catch (error) {
    console.error("[media]", error);
  } finally {
    polling = false;
  }
}

export function useMedia(): () => void {
  if (users++ === 0) {
    poll();
    timer = setInterval(poll, 1000);
  }
  return () => {
    if (--users === 0) {
      clearInterval(timer);
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
  playPause() {
    if (!media.app) return;
    media.playing = !media.playing;
    control("toggle");
  },
  next: () => control("next"),
  previous: () => control("previous"),
};
