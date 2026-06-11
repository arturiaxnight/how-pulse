const flashStage = document.getElementById("flashStage");
const statusText = document.getElementById("statusText");
const beatText = document.getElementById("beatText");
const bpmText = document.getElementById("bpmText");
const soundUnlockPanel = document.getElementById("soundUnlockPanel");
const soundUnlockHint = document.getElementById("soundUnlockHint");
const enableSoundBtn = document.getElementById("enableSoundBtn");

const adminPanel = document.getElementById("adminPanel");
const bpmSlider = document.getElementById("bpmSlider");
const bpmValue = document.getElementById("bpmValue");
const bpmMinusBtn = document.getElementById("bpmMinusBtn");
const bpmPlusBtn = document.getElementById("bpmPlusBtn");
const bpmLockHint = document.getElementById("bpmLockHint");
const soundModeSelect = document.getElementById("soundModeSelect");
const connectedClients = document.getElementById("connectedClients");
const readyClients = document.getElementById("readyClients");
const recommendedDelay = document.getElementById("recommendedDelay");
const localSyncQuality = document.getElementById("localSyncQuality");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const params = new URLSearchParams(window.location.search);
const isAdmin = params.get("role") === "admin";
if (isAdmin) {
  adminPanel.classList.remove("hidden");
}

const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const isLocalDevHost =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const wsUrl = isLocalDevHost
  ? `${wsProtocol}://${window.location.hostname}:8000/ws`
  : `${wsProtocol}://${window.location.host}/ws`;

let worker = null;
let fallbackTimer = null;
try {
  worker = new Worker("./timer-worker.js");
  worker.postMessage({ type: "setIntervalMs", intervalMs: 10 });
} catch (error) {
  console.warn("Worker unavailable, fallback to main thread timer", error);
}

let socket = null;
let reconnectTimer = null;
let syncTimer = null;

let bpm = 120;
let isPlaying = false;
let startTime = null;
let lastBeatIndex = -1;
let soundMode = "B";

const AUDIO_MODES = {
  A: {
    downbeat: "/Metronomes/metronome.mp3",
    upbeat: "/Metronomes/metronome.mp3",
  },
  B: {
    downbeat: "/Metronomes/di.mp3",
    upbeat: "/Metronomes/du.mp3",
  },
};
let audioContext = null;
const modeAudioCache = {};

function updateAudioUnlockUI() {
  if (!soundUnlockPanel) {
    return;
  }
  const isUnlocked = Boolean(audioContext && audioContext.state === "running");
  const shouldShowUnlockPanel = !isAdmin && !isUnlocked;
  soundUnlockPanel.classList.toggle("hidden", !shouldShowUnlockPanel);
  document.body.classList.toggle("overflow-hidden", shouldShowUnlockPanel);
  if (shouldShowUnlockPanel && soundUnlockHint) {
    soundUnlockHint.textContent =
      "進場後請先點一下按鈕，啟用後就會跟著螢幕節拍播放聲音。";
  }
}

function normalizeSoundMode(mode) {
  const normalized = String(mode || "").toUpperCase();
  return AUDIO_MODES[normalized] ? normalized : "B";
}

function getModeAudioState(mode) {
  const normalized = normalizeSoundMode(mode);
  if (!modeAudioCache[normalized]) {
    modeAudioCache[normalized] = {
      promise: null,
      buffers: {
        downbeat: null,
        upbeat: null,
      },
    };
  }
  return modeAudioCache[normalized];
}

function ensureAudioContext() {
  if (audioContext) {
    return audioContext;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }
  audioContext = new AudioContextClass({ latencyHint: "interactive" });
  updateAudioUnlockUI();
  return audioContext;
}

function decodeAudioBuffer(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    ctx.decodeAudioData(arrayBuffer, resolve, reject);
  });
}

async function loadMetronomeSounds(targetMode = soundMode) {
  const normalizedMode = normalizeSoundMode(targetMode);
  const modeAudioState = getModeAudioState(normalizedMode);
  if (modeAudioState.promise) {
    return modeAudioState.promise;
  }
  const ctx = ensureAudioContext();
  if (!ctx) {
    return null;
  }
  const paths = AUDIO_MODES[normalizedMode];

  modeAudioState.promise = (async () => {
    const [downbeatResp, upbeatResp] = await Promise.all([
      fetch(paths.downbeat, { cache: "force-cache" }),
      fetch(paths.upbeat, { cache: "force-cache" }),
    ]);
    if (!downbeatResp.ok || !upbeatResp.ok) {
      throw new Error("Failed to load metronome sound files.");
    }
    const [downbeatArrayBuffer, upbeatArrayBuffer] = await Promise.all([
      downbeatResp.arrayBuffer(),
      upbeatResp.arrayBuffer(),
    ]);
    const [downbeatBuffer, upbeatBuffer] = await Promise.all([
      decodeAudioBuffer(ctx, downbeatArrayBuffer),
      decodeAudioBuffer(ctx, upbeatArrayBuffer),
    ]);
    modeAudioState.buffers.downbeat = downbeatBuffer;
    modeAudioState.buffers.upbeat = upbeatBuffer;
    return modeAudioState.buffers;
  })().catch((error) => {
    console.warn("Metronome sounds unavailable:", error);
    modeAudioState.promise = null;
    return null;
  });

  return modeAudioState.promise;
}

function preloadAllSounds() {
  // Preload both modes so the first beat never gets swallowed by decode time.
  loadMetronomeSounds("A");
  loadMetronomeSounds("B");
}

function unlockAudio() {
  const ctx = ensureAudioContext();
  if (!ctx) {
    return;
  }
  const resumePromise =
    ctx.state === "suspended"
      ? ctx.resume().catch((error) => {
          console.warn("Failed to resume audio context:", error);
          return null;
        })
      : Promise.resolve();
  resumePromise.then(() => {
    updateAudioUnlockUI();
    preloadAllSounds();
    // Wake lock requests are most likely to be granted inside a user gesture
    // (the start command arrives via WebSocket, which is not a gesture).
    if (isPlaying) {
      acquireWakeLock();
    }
  });
}

// ---------------------------------------------------------------------------
// Timebase
//
// Local time uses performance.now() (monotonic) instead of Date.now().
// Date.now() is wall-clock time: the OS can step it at any moment (NTP
// adjustment), which instantly shifts the beat phase on that device only.
// serverOffsetSec maps monotonic local seconds -> server epoch seconds.
// ---------------------------------------------------------------------------

let serverOffsetSec = 0;
let hasEverAcquiredOffset = false; // true once any real sync sample was accepted this page session
let syncSampleCount = 0;
let lastRttMs = Number.NaN;
let jitterMs = 0;
let syncStatus = null;

const SYNC_INTERVAL_STABLE_MS = 2000; // steady-state: only fights clock drift
const SYNC_INTERVAL_FAST_MS = 500; // before reliable sync: converge quickly
const SYNC_WARMUP_REQUESTS = 10;
const SYNC_SAMPLE_WINDOW = 10; // sliding window of recent sync samples
const SYNC_ACQUIRE_SAMPLES = 5; // jump directly to target during acquisition
const CLOCK_STEP_THRESHOLD_SEC = 0.3; // beyond this, treat as clock step and jump
const SLEW_MAX_STEP_SEC = 0.03; // max correction per accepted sample while playing
const RELIABLE_RTT_MS = 200; // window-min RTT must be below this to count as synced
const MIN_BPM = 40;
const MAX_BPM = 180;

const syncSamples = []; // { rttMs, offset } — recent window

function perfNowSec() {
  return performance.now() / 1000;
}

function nowServerEpochSec() {
  return perfNowSec() + serverOffsetSec;
}

function windowMinRttMs() {
  if (syncSamples.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let min = syncSamples[0].rttMs;
  for (const sample of syncSamples) {
    if (sample.rttMs < min) {
      min = sample.rttMs;
    }
  }
  return min;
}

function hasReliableSync() {
  return syncSamples.length >= 3 && syncSampleCount >= SYNC_ACQUIRE_SAMPLES
    ? windowMinRttMs() < RELIABLE_RTT_MS
    : false;
}

// ---------------------------------------------------------------------------
// Audio scheduler
//
// Beats are scheduled ahead of time on the AudioContext hardware clock via
// source.start(when) instead of being fired "now" from a 10ms polling tick.
// This removes tick granularity / event-loop lag from the audible beat and
// makes devices converge to the shared server timeline.
// Output latency (device DAC/buffer delay) is compensated so sound leaves
// the speaker on the beat, not "enters the audio pipeline" on the beat.
// ---------------------------------------------------------------------------

const LOOKAHEAD_SEC = 0.3; // schedule beats this far ahead; tolerates tick throttling
const LATE_TOLERANCE_SEC = 0.05; // beats later than this are skipped, not played off-grid

let schedulerNextBeat = null; // next beat index to schedule (null = recompute)
let scheduledSources = [];

function outputLatencySec(ctx) {
  const latency = Number(ctx.outputLatency) || Number(ctx.baseLatency) || 0;
  return Number.isFinite(latency) && latency >= 0 && latency < 0.5 ? latency : 0;
}

function clearScheduledAudio() {
  for (const item of scheduledSources) {
    try {
      item.source.onended = null;
      item.source.stop();
    } catch (error) {
      // Source may have already ended; ignore.
    }
  }
  scheduledSources = [];
  schedulerNextBeat = null;
}

function scheduleBeatsAhead() {
  if (!isPlaying || startTime === null) {
    return;
  }
  const ctx = audioContext;
  if (!ctx || ctx.state !== "running") {
    return;
  }
  const buffers = getModeAudioState(soundMode).buffers;
  if (!buffers.downbeat || !buffers.upbeat) {
    loadMetronomeSounds(soundMode);
    return;
  }

  const beatDuration = 60 / bpm;
  const serverNow = nowServerEpochSec();

  if (schedulerNextBeat === null) {
    const elapsed = serverNow - startTime;
    schedulerNextBeat = elapsed <= 0 ? 0 : Math.floor(elapsed / beatDuration) + 1;
  }

  const horizon = serverNow + LOOKAHEAD_SEC;
  while (startTime + schedulerNextBeat * beatDuration <= horizon) {
    const beatIndex = schedulerNextBeat;
    schedulerNextBeat += 1;

    const beatServerTime = startTime + beatIndex * beatDuration;
    const when =
      ctx.currentTime + (beatServerTime - nowServerEpochSec()) - outputLatencySec(ctx);

    if (when < ctx.currentTime - LATE_TOLERANCE_SEC) {
      continue; // too late (e.g. resumed from background) — skip instead of playing off-grid
    }

    const isFirstBeat = ((beatIndex % 4) + 4) % 4 === 0;
    const source = ctx.createBufferSource();
    source.buffer = isFirstBeat ? buffers.downbeat : buffers.upbeat;
    source.connect(ctx.destination);
    source.start(Math.max(when, ctx.currentTime));

    const entry = { source, beatIndex };
    scheduledSources.push(entry);
    source.onended = () => {
      const idx = scheduledSources.indexOf(entry);
      if (idx !== -1) {
        scheduledSources.splice(idx, 1);
      }
    };
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function updateBpmLockUI() {
  const locked = isPlaying;
  bpmSlider.disabled = locked;
  bpmSlider.classList.toggle("opacity-50", locked);
  bpmSlider.classList.toggle("cursor-not-allowed", locked);
  if (bpmMinusBtn) {
    bpmMinusBtn.disabled = locked;
    bpmMinusBtn.classList.toggle("opacity-50", locked);
    bpmMinusBtn.classList.toggle("cursor-not-allowed", locked);
  }
  if (bpmPlusBtn) {
    bpmPlusBtn.disabled = locked;
    bpmPlusBtn.classList.toggle("opacity-50", locked);
    bpmPlusBtn.classList.toggle("cursor-not-allowed", locked);
  }
  if (bpmLockHint) {
    bpmLockHint.classList.toggle("text-amber-300", locked);
    bpmLockHint.classList.toggle("text-neutral-500", !locked);
  }
  if (soundModeSelect) {
    soundModeSelect.disabled = locked;
    soundModeSelect.classList.toggle("opacity-50", locked);
    soundModeSelect.classList.toggle("cursor-not-allowed", locked);
  }
}

function updateSyncStatusUI() {
  if (!isAdmin) {
    return;
  }
  if (syncStatus) {
    connectedClients.textContent = String(syncStatus.connected_clients ?? "-");
    readyClients.textContent = String(syncStatus.ready_clients ?? "-");
    const delay = Number(syncStatus.recommended_delay_sec);
    recommendedDelay.textContent = Number.isFinite(delay) ? `${delay.toFixed(2)}s` : "-";
  } else {
    connectedClients.textContent = "-";
    readyClients.textContent = "-";
    recommendedDelay.textContent = "-";
  }

  if (hasReliableSync()) {
    localSyncQuality.textContent = `${windowMinRttMs().toFixed(0)}ms / ${jitterMs.toFixed(0)}ms`;
  } else {
    localSyncQuality.textContent = "syncing...";
  }
}

function updateInfoUI() {
  bpmText.textContent = `BPM ${bpm}`;
  bpmValue.textContent = String(bpm);
  bpmSlider.value = String(bpm);

  const countdownSec = startTime === null ? 0 : startTime - nowServerEpochSec();
  if (isPlaying && countdownSec > 0) {
    statusText.textContent = `STARTING IN ${countdownSec.toFixed(1)}S`;
    statusText.className = "text-sm uppercase tracking-[0.2em] text-amber-300";
  } else if (isPlaying) {
    statusText.textContent = "PLAYING";
    statusText.className = "text-sm uppercase tracking-[0.2em] text-emerald-300";
  } else {
    statusText.textContent = "STOPPED";
    statusText.className = "text-sm uppercase tracking-[0.2em] text-neutral-400";
  }

  updateBpmLockUI();
  updateSyncStatusUI();
}

let lastShownCountdown = null;

function maybeUpdateCountdownUI() {
  const countdownSec = startTime === null ? 0 : startTime - nowServerEpochSec();
  const shown = Math.max(0, countdownSec).toFixed(1);
  if (shown !== lastShownCountdown) {
    lastShownCountdown = shown;
    updateInfoUI();
  }
}

function sendBpm(nextBpm) {
  const clamped = Math.max(MIN_BPM, Math.min(MAX_BPM, Number(nextBpm)));
  sendMessage({ type: "set_bpm", bpm: clamped });
}

function resetStageVisual() {
  flashStage.classList.remove("bg-yellow-400");
  flashStage.classList.add("bg-neutral-900");
}

// All beats flash the same yellow; downbeat is still distinguished by sound
// (mode B) and the beat number display.
function flashBeat() {
  flashStage.classList.remove("bg-neutral-900");
  flashStage.classList.add("bg-yellow-400");

  setTimeout(() => {
    if (!isPlaying) {
      resetStageVisual();
      return;
    }
    flashStage.classList.remove("bg-yellow-400");
    flashStage.classList.add("bg-neutral-900");
  }, 120);
}

// ---------------------------------------------------------------------------
// Tick loop: drives the visual flash and tops up the audio schedule.
// Audio timing no longer depends on tick punctuality — a throttled tick only
// delays the *visual*, while already-scheduled audio keeps playing on time.
// ---------------------------------------------------------------------------

function onTick() {
  if (!isPlaying || startTime === null) {
    return;
  }

  scheduleBeatsAhead();

  const elapsed = nowServerEpochSec() - startTime;
  if (elapsed < 0) {
    beatText.textContent = "-";
    maybeUpdateCountdownUI();
    return;
  }

  const beatDuration = 60 / bpm;
  const beatIndex = Math.floor(elapsed / beatDuration);
  if (beatIndex === lastBeatIndex) {
    return;
  }

  lastBeatIndex = beatIndex;
  const beatInBar = ((beatIndex % 4) + 4) % 4;
  beatText.textContent = String(beatInBar + 1);
  flashBeat();
  updateInfoUI();
}

function startTickLoop() {
  if (worker) {
    worker.postMessage({ type: "start" });
    return;
  }
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
  }
  fallbackTimer = setInterval(onTick, 10);
}

function stopTickLoop() {
  if (worker) {
    worker.postMessage({ type: "stop" });
  }
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Screen wake lock: prevents mobile screens from dimming/locking mid-set,
// which would throttle timers and suspend the AudioContext.
// ---------------------------------------------------------------------------

let wakeLock = null;

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) {
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    // Permission denied or not allowed without user activation; non-fatal.
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    return;
  }
  if (isPlaying) {
    acquireWakeLock();
  }
  // iOS suspends the AudioContext on screen lock / background. Surface the
  // unlock panel again so the member knows to tap once to restore sound.
  if (audioContext && audioContext.state === "suspended") {
    updateAudioUnlockUI();
  }
});

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

function applyStateFromServer(payload) {
  const state = payload.state || {};
  const prevIsPlaying = isPlaying;
  const prevStartTime = startTime;
  bpm = Number(state.bpm) || 120;
  isPlaying = Boolean(state.is_playing);
  startTime = typeof state.start_time === "number" ? state.start_time : null;
  soundMode = normalizeSoundMode(state.sound_mode);
  if (soundModeSelect) {
    soundModeSelect.value = soundMode;
  }
  syncStatus = payload.sync_status || null;
  loadMetronomeSounds(soundMode);
  updateAudioUnlockUI();

  // Coarse fallback offset, only if this page has never completed a real sync.
  // (Not latency-compensated — must never overwrite a measured offset, e.g.
  // right after a reconnect while playing, or the phase would jump audibly.)
  if (typeof payload.server_time === "number" && !hasEverAcquiredOffset) {
    serverOffsetSec = payload.server_time - perfNowSec();
  }

  const startTimeChanged =
    prevStartTime === null || startTime === null
      ? prevStartTime !== startTime
      : Math.abs(prevStartTime - startTime) > 0.001;
  const shouldResetBeats = !prevIsPlaying || startTimeChanged;

  if (!isPlaying) {
    lastBeatIndex = -1;
    beatText.textContent = "-";
    stopTickLoop();
    clearScheduledAudio();
    releaseWakeLock();
    resetStageVisual();
  } else if (shouldResetBeats) {
    lastBeatIndex = -1;
    clearScheduledAudio();
    startTickLoop();
    acquireWakeLock();
    syncBurst(); // refine offset during the 2~5s countdown before the first beat
  }

  updateInfoUI();
}

// ---------------------------------------------------------------------------
// Clock sync
//
// Offset selection: keep a sliding window of recent samples and follow the
// offset of the lowest-RTT sample in the window. The old logic compared
// against the all-time best RTT, so after one lucky sample nearly every
// later sample was rejected and the offset froze (drift never corrected).
// A windowed minimum adapts as network conditions change, while still
// preferring low-latency (most accurate) samples.
// ---------------------------------------------------------------------------

function updateOffsetWithSync(payload) {
  const serverTime = Number(payload.server_time);
  const clientSentAt = Number(payload.client_sent_at);
  const clientReceivedAt = perfNowSec();

  if (!Number.isFinite(serverTime) || !Number.isFinite(clientSentAt)) {
    return;
  }

  const rttMs = (clientReceivedAt - clientSentAt) * 1000;
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 2000) {
    return;
  }

  syncSampleCount += 1;
  if (Number.isFinite(lastRttMs)) {
    const delta = Math.abs(rttMs - lastRttMs);
    jitterMs = jitterMs === 0 ? delta : jitterMs * 0.85 + delta * 0.15;
  }
  lastRttMs = rttMs;

  const midpoint = (clientSentAt + clientReceivedAt) / 2;
  const candidateOffset = serverTime - midpoint;

  hasEverAcquiredOffset = true;
  syncSamples.push({ rttMs, offset: candidateOffset });
  if (syncSamples.length > SYNC_SAMPLE_WINDOW) {
    syncSamples.shift();
  }

  let best = syncSamples[0];
  for (const sample of syncSamples) {
    if (sample.rttMs < best.rttMs) {
      best = sample;
    }
  }
  const targetOffset = best.offset;
  const offsetDelta = targetOffset - serverOffsetSec;

  if (syncSampleCount <= SYNC_ACQUIRE_SAMPLES || Math.abs(offsetDelta) > CLOCK_STEP_THRESHOLD_SEC) {
    // Acquisition phase, or a genuine clock step: jump and re-align audio.
    serverOffsetSec = targetOffset;
    if (isPlaying) {
      clearScheduledAudio(); // scheduled beats were on the old timeline
    }
  } else if (Math.abs(offsetDelta) > SLEW_MAX_STEP_SEC) {
    serverOffsetSec += Math.sign(offsetDelta) * SLEW_MAX_STEP_SEC;
  } else {
    serverOffsetSec += offsetDelta * 0.3; // gentle convergence, no audible phase jump
  }

  sendMessage({
    type: "sync_report",
    rtt_ms: rttMs,
    offset_ms: serverOffsetSec * 1000,
    jitter_ms: jitterMs,
    synced: hasReliableSync(),
    sample_count: syncSampleCount,
  });
}

function requestSync() {
  sendMessage({
    type: "sync",
    client_sent_at: perfNowSec(),
  });
}

// Adaptive interval: sync fast (500ms) until the offset is reliable, then
// back off to 2s — steady-state only needs to counter clock drift (~us/sec),
// so a shorter stable interval adds traffic without audible benefit.
function scheduleNextSync() {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  const interval = hasReliableSync() ? SYNC_INTERVAL_STABLE_MS : SYNC_INTERVAL_FAST_MS;
  syncTimer = setTimeout(() => {
    requestSync();
    scheduleNextSync();
  }, interval);
}

function startSyncLoop() {
  // Warm-up samples right after connect to quickly stabilize offset.
  for (let i = 0; i < SYNC_WARMUP_REQUESTS; i += 1) {
    setTimeout(requestSync, i * 80);
  }
  scheduleNextSync();
}

// Extra burst of samples, fired during the start countdown so every device
// enters the first beat with a freshly corrected offset.
function syncBurst(count = 6, spacingMs = 100) {
  for (let i = 0; i < count; i += 1) {
    setTimeout(requestSync, i * spacingMs);
  }
}

function sendMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

// Watchdog: a half-open connection (Wi-Fi roam, dead AP) can sit for tens of
// seconds without firing "close", leaving this device on a stale offset and
// deaf to start/stop. Sync responses normally arrive every <=2s, so a long
// silence means the link is dead — force a reconnect.
const SYNC_WATCHDOG_TIMEOUT_SEC = 8;
let lastSyncResponseAt = 0;

setInterval(() => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (perfNowSec() - lastSyncResponseAt > SYNC_WATCHDOG_TIMEOUT_SEC) {
    console.warn("Sync watchdog: no sync response, forcing reconnect.");
    const stale = socket;
    try {
      stale.close();
    } catch (error) {
      // Transport already dead; ignore.
    }
    connectWebSocket(); // stale socket's late "close" is ignored by the guard below
  }
}, 2000);

function connectWebSocket() {
  const ws = new WebSocket(wsUrl);
  socket = ws;

  ws.addEventListener("open", () => {
    if (ws !== socket) {
      try {
        ws.close();
      } catch (error) {
        // ignore
      }
      return;
    }
    lastSyncResponseAt = perfNowSec();
    syncSamples.length = 0;
    syncSampleCount = 0;
    lastRttMs = Number.NaN;
    jitterMs = 0;
    sendMessage({ type: "request_state" });
    startSyncLoop();
  });

  ws.addEventListener("message", (event) => {
    if (ws !== socket) {
      return;
    }
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "state") {
        applyStateFromServer(payload);
      } else if (payload.type === "sync_status") {
        syncStatus = payload.sync_status || null;
        updateInfoUI();
      } else if (payload.type === "sync") {
        lastSyncResponseAt = perfNowSec();
        updateOffsetWithSync(payload);
        updateInfoUI();
      } else if (payload.type === "error") {
        console.warn(payload.message);
      }
    } catch (error) {
      console.error("Failed to parse message", error);
    }
  });

  ws.addEventListener("close", () => {
    if (ws !== socket) {
      return; // stale socket replaced by the watchdog; new connection already live
    }
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    syncStatus = null;
    reconnectTimer = setTimeout(connectWebSocket, 1000);
  });
}

if (worker) {
  worker.onmessage = (event) => {
    if (event.data?.type === "tick") {
      onTick();
    }
  };
}

if (isAdmin) {
  bpmSlider.addEventListener("input", () => {
    if (isPlaying) {
      bpmSlider.value = String(bpm);
      return;
    }
    const next = Number(bpmSlider.value);
    bpmValue.textContent = String(next);
    sendBpm(next);
  });

  if (bpmMinusBtn) {
    bpmMinusBtn.addEventListener("click", () => {
      if (isPlaying) {
        return;
      }
      sendBpm(bpm - 1);
    });
  }

  if (bpmPlusBtn) {
    bpmPlusBtn.addEventListener("click", () => {
      if (isPlaying) {
        return;
      }
      sendBpm(bpm + 1);
    });
  }

  if (soundModeSelect) {
    soundModeSelect.addEventListener("change", () => {
      if (isPlaying) {
        soundModeSelect.value = soundMode;
        return;
      }
      sendMessage({ type: "set_sound_mode", sound_mode: normalizeSoundMode(soundModeSelect.value) });
    });
  }

  startBtn.addEventListener("click", () => {
    sendMessage({ type: "start" });
  });

  stopBtn.addEventListener("click", () => {
    sendMessage({ type: "stop" });
  });
}

updateInfoUI();
resetStageVisual();
updateAudioUnlockUI();
window.addEventListener("pointerdown", unlockAudio);
window.addEventListener("keydown", unlockAudio);
window.addEventListener("touchstart", unlockAudio, { passive: true });
if (enableSoundBtn) {
  enableSoundBtn.addEventListener("click", unlockAudio);
}
connectWebSocket();
