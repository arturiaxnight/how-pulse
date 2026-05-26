const flashStage = document.getElementById("flashStage");
const statusText = document.getElementById("statusText");
const beatText = document.getElementById("beatText");
const bpmText = document.getElementById("bpmText");

const adminPanel = document.getElementById("adminPanel");
const bpmSlider = document.getElementById("bpmSlider");
const bpmValue = document.getElementById("bpmValue");
const bpmMinusBtn = document.getElementById("bpmMinusBtn");
const bpmPlusBtn = document.getElementById("bpmPlusBtn");
const bpmLockHint = document.getElementById("bpmLockHint");
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

const AUDIO_PATHS = {
  downbeat: "/Metronomes/Synth_Sine_C_hi.wav",
  upbeat: "/Metronomes/Synth_Sine_C_lo.wav",
};
let audioContext = null;
let audioLoadPromise = null;
const audioBuffers = {
  downbeat: null,
  upbeat: null,
};

function ensureAudioContext() {
  if (audioContext) {
    return audioContext;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }
  audioContext = new AudioContextClass();
  return audioContext;
}

function decodeAudioBuffer(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    ctx.decodeAudioData(arrayBuffer, resolve, reject);
  });
}

async function loadMetronomeSounds() {
  if (audioLoadPromise) {
    return audioLoadPromise;
  }
  const ctx = ensureAudioContext();
  if (!ctx) {
    return null;
  }

  audioLoadPromise = (async () => {
    const [downbeatResp, upbeatResp] = await Promise.all([
      fetch(AUDIO_PATHS.downbeat, { cache: "force-cache" }),
      fetch(AUDIO_PATHS.upbeat, { cache: "force-cache" }),
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
    audioBuffers.downbeat = downbeatBuffer;
    audioBuffers.upbeat = upbeatBuffer;
    return audioBuffers;
  })().catch((error) => {
    console.warn("Metronome sounds unavailable:", error);
    audioLoadPromise = null;
    return null;
  });

  return audioLoadPromise;
}

function unlockAudio() {
  const ctx = ensureAudioContext();
  if (!ctx) {
    return;
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch((error) => {
      console.warn("Failed to resume audio context:", error);
    });
  }
  loadMetronomeSounds();
}

function playBeatSound(isFirstBeat) {
  const ctx = ensureAudioContext();
  if (!ctx || ctx.state !== "running") {
    return;
  }
  const buffer = isFirstBeat ? audioBuffers.downbeat : audioBuffers.upbeat;
  if (!buffer) {
    return;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
}

// serverOffsetSec = serverEpoch - localEpoch
let serverOffsetSec = 0;
let bestSyncRttMs = Number.POSITIVE_INFINITY;
let syncSampleCount = 0;
let lastRttMs = Number.POSITIVE_INFINITY;
let jitterMs = 0;
let syncStatus = null;
const SYNC_INTERVAL_MS = 2000;
const SYNC_WARMUP_REQUESTS = 10;
const MIN_BPM = 40;
const MAX_BPM = 180;

function hasReliableSync() {
  return Number.isFinite(bestSyncRttMs) && bestSyncRttMs < 700 && syncSampleCount >= 3;
}

function nowServerEpochSec() {
  return Date.now() / 1000 + serverOffsetSec;
}

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
    localSyncQuality.textContent = `${bestSyncRttMs.toFixed(0)}ms / ${jitterMs.toFixed(0)}ms`;
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

function sendBpm(nextBpm) {
  const clamped = Math.max(MIN_BPM, Math.min(MAX_BPM, Number(nextBpm)));
  sendMessage({ type: "set_bpm", bpm: clamped });
}

function resetStageVisual() {
  flashStage.classList.remove("bg-red-500", "bg-white");
  flashStage.classList.add("bg-neutral-900");
}

function flashBeat(isFirstBeat) {
  flashStage.classList.remove("bg-neutral-900", "bg-red-500", "bg-white");
  flashStage.classList.add(isFirstBeat ? "bg-red-500" : "bg-white");
  playBeatSound(isFirstBeat);

  setTimeout(() => {
    if (!isPlaying) {
      resetStageVisual();
      return;
    }
    flashStage.classList.remove("bg-red-500", "bg-white");
    flashStage.classList.add("bg-neutral-900");
  }, 120);
}

function onTick() {
  if (!isPlaying || startTime === null) {
    return;
  }

  const elapsed = nowServerEpochSec() - startTime;
  if (elapsed < 0) {
    beatText.textContent = "-";
    updateInfoUI();
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
  flashBeat(beatInBar === 0);
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

function applyStateFromServer(payload) {
  const state = payload.state || {};
  const prevIsPlaying = isPlaying;
  const prevStartTime = startTime;
  bpm = Number(state.bpm) || 120;
  isPlaying = Boolean(state.is_playing);
  startTime = typeof state.start_time === "number" ? state.start_time : null;
  syncStatus = payload.sync_status || null;

  // Fallback offset before sync responses arrive.
  if (typeof payload.server_time === "number" && !hasReliableSync()) {
    const receivedAtLocalEpoch = Date.now() / 1000;
    serverOffsetSec = payload.server_time - receivedAtLocalEpoch;
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
    resetStageVisual();
  } else if (shouldResetBeats) {
    lastBeatIndex = -1;
    startTickLoop();
  }

  updateInfoUI();
}

function updateOffsetWithSync(payload) {
  const serverTime = Number(payload.server_time);
  const clientSentAt = Number(payload.client_sent_at);
  const clientReceivedAt = Date.now() / 1000;

  if (!Number.isFinite(serverTime) || !Number.isFinite(clientSentAt)) {
    return;
  }

  const rttMs = (clientReceivedAt - clientSentAt) * 1000;
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 1000) {
    return;
  }
  syncSampleCount += 1;
  if (Number.isFinite(lastRttMs)) {
    const delta = Math.abs(rttMs - lastRttMs);
    jitterMs = jitterMs === 0 ? delta : jitterMs * 0.85 + delta * 0.15;
  }
  lastRttMs = rttMs;

  const midpointEpoch = (clientSentAt + clientReceivedAt) / 2;
  const candidateOffset = serverTime - midpointEpoch;
  const previousOffset = serverOffsetSec;
  const offsetDelta = candidateOffset - previousOffset;

  if (rttMs <= bestSyncRttMs) {
    bestSyncRttMs = rttMs;
  }

  if (!hasReliableSync()) {
    serverOffsetSec = candidateOffset;
  } else if (rttMs <= bestSyncRttMs + 8) {
    // Slew the clock to avoid visible phase jumps.
    const maxStep = 0.012;
    if (Math.abs(offsetDelta) > maxStep) {
      serverOffsetSec = previousOffset + Math.sign(offsetDelta) * maxStep;
    } else {
      serverOffsetSec = previousOffset * 0.85 + candidateOffset * 0.15;
    }
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
    client_sent_at: Date.now() / 1000,
  });
}

function startSyncLoop() {
  if (syncTimer) {
    clearInterval(syncTimer);
  }
  syncTimer = setInterval(requestSync, SYNC_INTERVAL_MS);

  // Warm-up samples right after connect to quickly stabilize offset.
  for (let i = 0; i < SYNC_WARMUP_REQUESTS; i += 1) {
    setTimeout(requestSync, i * 80);
  }
}

function sendMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function connectWebSocket() {
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    bestSyncRttMs = Number.POSITIVE_INFINITY;
    syncSampleCount = 0;
    lastRttMs = Number.POSITIVE_INFINITY;
    jitterMs = 0;
    sendMessage({ type: "request_state" });
    startSyncLoop();
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "state") {
        applyStateFromServer(payload);
      } else if (payload.type === "sync_status") {
        syncStatus = payload.sync_status || null;
        updateInfoUI();
      } else if (payload.type === "sync") {
        updateOffsetWithSync(payload);
        updateInfoUI();
      } else if (payload.type === "error") {
        console.warn(payload.message);
      }
    } catch (error) {
      console.error("Failed to parse message", error);
    }
  });

  socket.addEventListener("close", () => {
    if (syncTimer) {
      clearInterval(syncTimer);
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

  startBtn.addEventListener("click", () => {
    sendMessage({ type: "start" });
  });

  stopBtn.addEventListener("click", () => {
    sendMessage({ type: "stop" });
  });
}

updateInfoUI();
resetStageVisual();
window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });
window.addEventListener("touchstart", unlockAudio, { once: true, passive: true });
connectWebSocket();
