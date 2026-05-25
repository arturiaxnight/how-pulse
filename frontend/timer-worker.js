let timerId = null;
let intervalMs = 25;

function stopTimer() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

function startTimer() {
  stopTimer();
  timerId = setInterval(() => {
    self.postMessage({ type: "tick" });
  }, intervalMs);
}

self.onmessage = (event) => {
  const data = event.data || {};
  const type = data.type;

  if (type === "setIntervalMs") {
    const next = Number(data.intervalMs);
    if (Number.isFinite(next) && next >= 10) {
      intervalMs = next;
      if (timerId !== null) {
        startTimer();
      }
    }
    return;
  }

  if (type === "start") {
    startTimer();
    return;
  }

  if (type === "stop") {
    stopTimer();
  }
};
