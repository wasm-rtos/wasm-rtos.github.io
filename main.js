const tasks = [];
let runtime = null;
let runtimeStartedAt = 0;
let runtimeFailed = false;
let fuelPerSlice = 10000;
let fuelRatePerMs = 2400;
let resumeFuelRatePerMs = 2400;
let previousScheduledSlices = 0;
let previousFuelSampleAt = 0;
let traceRuntimeSupported = false;
let traceNextSequence = 0;
let traceClockMs = 0;
let traceTaskIdsPointer = 0;
let traceStartsPointer = 0;
let traceDurationsPointer = 0;
let nextTraceColor = 0;
let traceStatusMode = '';
let traceLastSummaryAt = 0;
let traceWindowMs = 10000;

const FUEL_TELEMETRY_WINDOW_MS = 1000;
const TASK_ACTIVITY_PULSE_MS = 1500;
const TRACE_MIN_WINDOW_MS = 10000;
const TRACE_MAX_WINDOW_MS = 60000;
const TRACE_MIN_VISIBLE_SLICES = 4;
const TRACE_VISIBLE_SLICES_PER_TASK = 2;
const TRACE_BATCH_SIZE = 256;
const TRACE_MAX_EVENTS = 4096;
const TRACE_HEADER_HEIGHT = 30;
const TRACE_ROW_HEIGHT = 44;
const TRACE_FOOTER_HEIGHT = 8;
const TRACE_MIN_PULSE_WIDTH = 4;
const TRACE_COLORS = ['#97dba0', '#9fbddf', '#d39cff', '#ffbd69', '#ff8585', '#69d2e7'];

const traceEvents = [];
const traceTaskOwners = new Map();
const traceHitRegions = [];

const OS_STATUS_OK = 0;
const OS_TASK_READY = 0;
const OS_TASK_RUNNING = 1;
const OS_TASK_WAITING = 2;
const OS_TASK_SUSPENDED = 3;
const OS_TASK_SWAPPED = 4;
const OS_TASK_DEAD = 5;

const OS_TASK_EXIT_RETURNED = 1;
const OS_TASK_EXIT_EXPLICIT = 2;
const OS_TASK_EXIT_DELETED = 3;
const OS_TASK_EXIT_WASM_ERROR = 4;

const UINT32_MAX = 0xFFFFFFFF;
const CPU_NODE_ID = 'cpu';

const statusIcons = {
  Running: '▶',
  Ready: '◷',
  Waiting: '◷',
  Paused: 'Ⅱ',
  Swapped: '◇',
  Completed: '✓',
  Failed: '×',
  Stopped: '■'
};

// Parts catalogue. Only the processor is wired to the kernel today.
const PARTS = [
  { category: 'Processor', id: CPU_NODE_ID, name: 'WASM CPU', meta: 'wasm-rtos · wasm3', icon: 'CPU', available: true },
  { category: 'Displays', id: 'gc9a01', name: 'GC9A01', meta: 'Round TFT 240×240 · SPI', icon: 'TFT' },
  { category: 'Displays', id: 'ssd1306', name: 'SSD1306', meta: 'OLED 128×64 · I²C', icon: 'OLD' },
  { category: 'Sensors', id: 'bme280', name: 'BME280', meta: 'Temperature, humidity, pressure · I²C', icon: 'ENV' },
  { category: 'Sensors', id: 'mpu6050', name: 'MPU6050', meta: '6-axis IMU · I²C', icon: 'IMU' },
  { category: 'Input', id: 'button', name: 'Push button', meta: 'GPIO', icon: 'BTN' },
  { category: 'Input', id: 'potentiometer', name: 'Potentiometer', meta: 'Analog', icon: 'POT' },
  { category: 'Output', id: 'led', name: 'LED', meta: 'GPIO', icon: 'LED' },
  { category: 'Output', id: 'neopixel', name: 'RGB LED strip', meta: 'Addressable · GPIO', icon: 'RGB' }
];

const app = document.querySelector('#app');
const taskList = document.querySelector('#taskList');
const activeBadge = document.querySelector('#activeBadge');
const waitingCount = document.querySelector('#waitingCount');
const timerCount = document.querySelector('#timerCount');
const consoleLog = document.querySelector('#consoleLog');
const runtimeStatus = document.querySelector('#runtimeStatus');
const runtimeStatusDetail = document.querySelector('#runtimeStatusDetail');
const memoryValue = document.querySelector('#memoryValue');
const fileInput = document.querySelector('#wasmFile');
const pageDropOverlay = document.querySelector('#pageDropOverlay');
const loadButton = document.querySelector('#loadButton');
const runButton = document.querySelector('#runButton');
const newTaskButton = document.querySelector('#newTaskButton');
const fuelRateSlider = document.querySelector('#fuelRateSlider');
const fuelRateInput = document.querySelector('#fuelRateInput');
const fuelRateActual = document.querySelector('#fuelRateActual');
const lcdClock = document.querySelector('#lcdClock');
const lcdTasks = document.querySelector('#lcdTasks');
const lcdReady = document.querySelector('#lcdReady');
const lcdFuel = document.querySelector('#lcdFuel');
const lcdFuelUnit = document.querySelector('#lcdFuelUnit');
const lcdState = document.querySelector('#lcdState');
const libraryList = document.querySelector('#libraryList');
const librarySearch = document.querySelector('#librarySearch');
const editorPanel = document.querySelector('#editorPanel');
const editorResize = document.querySelector('#editorResize');
const schedulerTimelineCanvas = document.querySelector('#schedulerTimelineCanvas');
const schedulerTimelineShell = document.querySelector('#schedulerTimelineShell');
const schedulerTimelineEmpty = document.querySelector('#schedulerTimelineEmpty');
const schedulerTimelineTooltip = document.querySelector('#schedulerTimelineTooltip');
const schedulerTimelineStatus = document.querySelector('#schedulerTimelineStatus');
const schedulerTimelineWindow = document.querySelector('#schedulerTimelineWindow');
const schedulerTimelineSummary = document.querySelector('#schedulerTimelineSummary');
const schedulerTimelineContext = schedulerTimelineCanvas.getContext('2d');

const fuelNumberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const integerNumberFormat = new Intl.NumberFormat('en-US');

const cpuView = {};

function timeStamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function appendLog(message) {
  const current = consoleLog.textContent.replace(/\n?> _\s*$/, '');
  consoleLog.textContent = `${current}\n[${timeStamp()}] ${message}\n> _`.trimStart();
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

function readCString(pointer) {
  if (!runtime || !pointer) return '';
  const bytes = [];
  for (let index = pointer; runtime.HEAPU8[index] !== 0; index += 1) {
    bytes.push(runtime.HEAPU8[index]);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function runtimeError() {
  if (!runtime) return 'wasm-rtos runtime is not initialized';
  const pointer = runtime.ccall('browser_runtime_get_last_error', 'number', [], []);
  return pointer ? readCString(pointer) : 'unknown runtime error';
}

function callRuntime(name, returnType, argumentTypes = [], argumentsList = []) {
  if (!runtime) throw new Error('wasm-rtos runtime is not initialized');
  return runtime.ccall(name, returnType, argumentTypes, argumentsList);
}

/* ---------- Execution budget ---------- */

function clampFuelRate(value) {
  if (!Number.isFinite(value)) return fuelRatePerMs;
  return Math.min(40000, Math.max(0, Math.round(value)));
}

function formatFuelRate() {
  const megaFuelPerSecond = fuelRatePerMs / 1000;
  const fractionDigits = megaFuelPerSecond < 0.1 ? 3 : megaFuelPerSecond < 10 ? 2 : 1;
  return megaFuelPerSecond.toFixed(fractionDigits);
}

function renderFuelRate() {
  lcdFuel.textContent = fuelRatePerMs === 0 ? '0' : formatFuelRate();
  lcdFuelUnit.textContent = 'MFUEL/S';
  cpuView.fuel.textContent = fuelRatePerMs === 0 ? '0' : formatFuelRate();
  runButton.setAttribute('aria-pressed', String(fuelRatePerMs > 0));
  renderRunState();
}

function setFuelRate(value, updateInput = true) {
  fuelRatePerMs = clampFuelRate(Number(value));
  if (fuelRatePerMs > 0) resumeFuelRatePerMs = fuelRatePerMs;
  fuelRateSlider.value = String(fuelRatePerMs);
  if (updateInput) fuelRateInput.value = String(fuelRatePerMs);
  renderFuelRate();

  if (runtime) {
    callRuntime('browser_runtime_set_fuel_per_ms', null, ['number'], [fuelRatePerMs]);
    resetFuelTelemetry();
  }
}

function toggleRun() {
  setFuelRate(fuelRatePerMs > 0 ? 0 : resumeFuelRatePerMs || 2400);
  appendLog(fuelRatePerMs > 0 ? 'Execution resumed' : 'Execution paused (fuel 0)');
}

function resetFuelTelemetry() {
  previousScheduledSlices = runtime
    ? callRuntime('browser_runtime_get_scheduled_slice_count', 'number') >>> 0
    : 0;
  previousFuelSampleAt = performance.now();
  fuelRateActual.textContent = '0 fuel/ms scheduled';
}

function updateFuelTelemetry() {
  if (!runtime) return;

  const now = performance.now();
  const elapsedMs = now - previousFuelSampleAt;
  if (elapsedMs < FUEL_TELEMETRY_WINDOW_MS) return;

  const scheduledSlices = callRuntime('browser_runtime_get_scheduled_slice_count', 'number') >>> 0;
  const sliceDelta = (scheduledSlices - previousScheduledSlices) >>> 0;
  const scheduledFuelPerMs = sliceDelta * fuelPerSlice / elapsedMs;

  fuelRateActual.textContent = `${fuelNumberFormat.format(scheduledFuelPerMs)} fuel/ms scheduled`;
  previousScheduledSlices = scheduledSlices;
  previousFuelSampleAt = now;
}

function renderRunState() {
  const mode = runtimeFailed ? 'error' : !runtime ? 'load' : fuelRatePerMs === 0 ? 'pause' : 'run';
  const label = { error: 'ERR', load: 'LOAD', pause: 'PAUSE', run: 'RUN' }[mode];
  lcdState.textContent = label;
  lcdState.parentElement.classList.toggle('is-run', mode === 'run');
  lcdState.parentElement.classList.toggle('is-pause', mode === 'pause');
  lcdState.parentElement.classList.toggle('is-error', mode === 'error');
  cpuView.led.className = `chip-led is-${mode}`;
}

/* ---------- Scheduler trace ---------- */

function freeTraceBuffers() {
  if (!runtime) return;
  [traceTaskIdsPointer, traceStartsPointer, traceDurationsPointer].forEach((pointer) => {
    if (pointer) runtime._free(pointer);
  });
  traceTaskIdsPointer = 0;
  traceStartsPointer = 0;
  traceDurationsPointer = 0;
}

function initializeTraceTelemetry() {
  traceEvents.length = 0;
  traceNextSequence = 0;
  traceClockMs = 0;
  traceTaskOwners.clear();

  traceRuntimeSupported = Boolean(
    runtime
    && typeof runtime._browser_trace_get_oldest_sequence === 'function'
    && typeof runtime._browser_trace_get_latest_sequence === 'function'
    && typeof runtime._browser_trace_get_clock_ms === 'function'
    && typeof runtime._browser_trace_read === 'function'
  );

  if (!traceRuntimeSupported) return;

  traceTaskIdsPointer = runtime._malloc(TRACE_BATCH_SIZE * Uint32Array.BYTES_PER_ELEMENT);
  traceStartsPointer = runtime._malloc(TRACE_BATCH_SIZE * Float64Array.BYTES_PER_ELEMENT);
  traceDurationsPointer = runtime._malloc(TRACE_BATCH_SIZE * Float64Array.BYTES_PER_ELEMENT);

  if (!traceTaskIdsPointer || !traceStartsPointer || !traceDurationsPointer) {
    freeTraceBuffers();
    traceRuntimeSupported = false;
    return;
  }

  const oldestSequence = callRuntime('browser_trace_get_oldest_sequence', 'number') >>> 0;
  traceNextSequence = oldestSequence || 1;
}

function pruneTraceEvents() {
  const cutoff = traceClockMs - traceWindowMs - 750;
  let removeCount = 0;

  while (
    removeCount < traceEvents.length
    && traceEvents[removeCount].startedAtMs + traceEvents[removeCount].durationMs < cutoff
  ) {
    removeCount += 1;
  }

  if (removeCount) traceEvents.splice(0, removeCount);
  if (traceEvents.length > TRACE_MAX_EVENTS) {
    traceEvents.splice(0, traceEvents.length - TRACE_MAX_EVENTS);
  }
}

function updateTraceWindow() {
  if (fuelRatePerMs > 0) {
    const targetSlices = Math.max(
      TRACE_MIN_VISIBLE_SLICES,
      tasks.length * TRACE_VISIBLE_SLICES_PER_TASK
    );
    const sliceIntervalMs = fuelPerSlice / fuelRatePerMs;
    const desiredWindowMs = Math.ceil(sliceIntervalMs * targetSlices / 1000) * 1000;
    traceWindowMs = Math.min(
      TRACE_MAX_WINDOW_MS,
      Math.max(TRACE_MIN_WINDOW_MS, desiredWindowMs)
    );
  }

  const label = `${Math.round(traceWindowMs / 1000)} s window`;
  if (schedulerTimelineWindow.textContent !== label) schedulerTimelineWindow.textContent = label;
}

function consumeTraceEvents() {
  if (!traceRuntimeSupported) return;

  traceClockMs = callRuntime('browser_trace_get_clock_ms', 'number');
  const oldestSequence = callRuntime('browser_trace_get_oldest_sequence', 'number') >>> 0;
  const latestSequence = callRuntime('browser_trace_get_latest_sequence', 'number') >>> 0;

  if (!latestSequence) {
    pruneTraceEvents();
    return;
  }

  if (!traceNextSequence || traceNextSequence < oldestSequence) {
    traceNextSequence = oldestSequence;
  }

  if (traceNextSequence <= latestSequence) {
    const requestedCount = Math.min(TRACE_BATCH_SIZE, latestSequence - traceNextSequence + 1);
    const firstSequence = traceNextSequence;
    const copiedCount = callRuntime(
      'browser_trace_read',
      'number',
      ['number', 'number', 'number', 'number', 'number'],
      [firstSequence, requestedCount, traceTaskIdsPointer, traceStartsPointer, traceDurationsPointer]
    ) >>> 0;
    const view = new DataView(runtime.HEAPU8.buffer);

    for (let index = 0; index < copiedCount; index += 1) {
      const taskId = view.getUint32(traceTaskIdsPointer + index * 4, true);
      const localId = traceTaskOwners.get(taskId);
      if (!localId) continue;

      traceEvents.push({
        sequence: firstSequence + index,
        taskId,
        localId,
        startedAtMs: view.getFloat64(traceStartsPointer + index * 8, true),
        durationMs: Math.max(0, view.getFloat64(traceDurationsPointer + index * 8, true))
      });
    }

    traceNextSequence += copiedCount;
    if (!copiedCount) traceNextSequence = latestSequence + 1;
  }

  pruneTraceEvents();
}

function updateTimelineStatus() {
  const mode = !runtime
    ? 'loading'
    : !traceRuntimeSupported
      ? 'unavailable'
      : fuelRatePerMs === 0
        ? 'paused'
        : 'live';

  if (mode === traceStatusMode) return;
  traceStatusMode = mode;

  schedulerTimelineStatus.classList.toggle('is-paused', mode === 'paused');
  schedulerTimelineStatus.classList.toggle('is-unavailable', mode === 'unavailable' || mode === 'loading');

  const dot = document.createElement('i');
  dot.setAttribute('aria-hidden', 'true');
  const label = mode === 'live'
    ? 'Live'
    : mode === 'paused'
      ? 'Paused'
      : mode === 'loading'
        ? 'Loading'
        : 'Trace unavailable';
  schedulerTimelineStatus.replaceChildren(dot, document.createTextNode(` ${label}`));
}

function formatTraceDuration(durationMs) {
  if (durationMs < 0.001) return '<0.001 ms';
  if (durationMs < 0.1) return `${durationMs.toFixed(3)} ms`;
  if (durationMs < 10) return `${durationMs.toFixed(2)} ms`;
  if (durationMs < 1000) return `${durationMs.toFixed(1)} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatTraceAge(ageMs) {
  if (ageMs < 1000) return `${Math.max(0, Math.round(ageMs))} ms ago`;
  return `${(ageMs / 1000).toFixed(2)} s ago`;
}

function truncateCanvasText(context, value, maxWidth) {
  if (context.measureText(value).width <= maxWidth) return value;

  let shortened = value;
  while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened}…`;
}

function mergeTracePulses(pulses) {
  const merged = [];

  [...pulses]
    .sort((left, right) => left.startX - right.startX)
    .forEach((pulse) => {
      const previous = merged[merged.length - 1];
      if (previous && pulse.startX <= previous.endX + 0.5) {
        previous.endX = Math.max(previous.endX, pulse.endX);
        return;
      }
      merged.push({ ...pulse });
    });

  return merged;
}

function drawTraceSignalPath(context, pulses, trackLeft, trackRight, highY, lowY) {
  context.beginPath();
  context.moveTo(trackLeft, pulses[0]?.startsBeforeWindow ? highY : lowY);

  pulses.forEach((pulse, index) => {
    if (index > 0 || !pulse.startsBeforeWindow) {
      context.lineTo(pulse.startX, lowY);
      context.lineTo(pulse.startX, highY);
    }
    context.lineTo(pulse.endX, highY);
    context.lineTo(pulse.endX, lowY);
  });

  context.lineTo(trackRight, lowY);
}

function resizeSchedulerTimeline() {
  const width = Math.max(1, schedulerTimelineShell.clientWidth);
  const height = Math.max(
    schedulerTimelineShell.parentElement.clientHeight,
    TRACE_HEADER_HEIGHT + Math.max(1, tasks.length) * TRACE_ROW_HEIGHT + TRACE_FOOTER_HEIGHT
  );
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.floor(width * scale));
  const pixelHeight = Math.max(1, Math.floor(height * scale));

  schedulerTimelineCanvas.style.height = `${height}px`;
  if (schedulerTimelineCanvas.width !== pixelWidth || schedulerTimelineCanvas.height !== pixelHeight) {
    schedulerTimelineCanvas.width = pixelWidth;
    schedulerTimelineCanvas.height = pixelHeight;
  }
  schedulerTimelineContext.setTransform(scale, 0, 0, scale, 0, 0);

  return { width, height };
}

function calculateTraceTotals(visibleEvents, windowStart) {
  const totals = new Map();

  visibleEvents.forEach((traceEvent) => {
    const eventEnd = traceEvent.startedAtMs + Math.max(traceEvent.durationMs, 0.001);
    const overlap = Math.max(
      0,
      Math.min(eventEnd, traceClockMs) - Math.max(traceEvent.startedAtMs, windowStart)
    );
    totals.set(traceEvent.localId, (totals.get(traceEvent.localId) || 0) + overlap);
  });

  return totals;
}

function updateTimelineEmptyState(hasVisibleEvents) {
  schedulerTimelineEmpty.hidden = hasVisibleEvents;
  if (hasVisibleEvents) return;

  const heading = schedulerTimelineEmpty.querySelector('strong');
  const detail = schedulerTimelineEmpty.querySelector('span');

  if (!tasks.length) {
    heading.textContent = 'No task slices yet';
    detail.textContent = 'Load a .wasm program to see scheduler activity.';
  } else if (!traceRuntimeSupported) {
    heading.textContent = 'Trace runtime unavailable';
    detail.textContent = 'Refresh after the browser runtime finishes updating.';
  } else if (fuelRatePerMs === 0) {
    heading.textContent = 'Execution is paused';
    detail.textContent = 'Press Run or raise fuel above zero to schedule task slices.';
  } else {
    heading.textContent = 'Waiting for a scheduler slice';
    detail.textContent = 'The first execution segment will enter from the right.';
  }
}

function updateTimelineAccessibility(totals, totalDuration, hasVisibleEvents) {
  const now = performance.now();
  if (now - traceLastSummaryAt < 1000) return;
  traceLastSummaryAt = now;

  if (!hasVisibleEvents) {
    schedulerTimelineSummary.textContent = tasks.length
      ? 'No scheduler slices are visible in the current rolling window.'
      : 'No scheduler activity recorded.';
  } else {
    const details = tasks.map((task) => {
      const duration = totals.get(task.localId) || 0;
      const share = totalDuration ? Math.round(duration / totalDuration * 100) : 0;
      return `${task.app}: ${share} percent of traced execution, ${formatTraceDuration(duration)}`;
    });
    schedulerTimelineSummary.textContent = `Live scheduler timeline. ${details.join('; ')}.`;
  }

  schedulerTimelineCanvas.setAttribute('aria-label', schedulerTimelineSummary.textContent);
}

function drawSchedulerTimeline() {
  requestAnimationFrame(drawSchedulerTimeline);
  updateTimelineStatus();
  updateTraceWindow();
  if (traceRuntimeSupported) consumeTraceEvents();
  else traceClockMs = runtimeStartedAt ? performance.now() - runtimeStartedAt : 0;

  // Keep consuming trace events while hidden, but skip drawing.
  if (schedulerTimelineShell.offsetParent === null) return;

  const { width, height } = resizeSchedulerTimeline();
  const context = schedulerTimelineContext;
  const labelWidth = width < 560 ? 116 : Math.min(220, Math.max(170, width * 0.2));
  const trackLeft = labelWidth;
  const trackRight = Math.max(trackLeft + 1, width - 12);
  const trackWidth = Math.max(1, trackRight - trackLeft);
  const windowStart = traceClockMs - traceWindowMs;
  const taskIds = new Set(tasks.map((task) => task.localId));
  const visibleEvents = traceEvents.filter((traceEvent) => (
    taskIds.has(traceEvent.localId)
    && traceEvent.startedAtMs + Math.max(traceEvent.durationMs, 0.001) >= windowStart
    && traceEvent.startedAtMs <= traceClockMs
  ));
  const totals = calculateTraceTotals(visibleEvents, windowStart);
  const totalDuration = [...totals.values()].reduce((sum, duration) => sum + duration, 0);

  traceHitRegions.length = 0;
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#3a3a3a';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#454545';
  context.fillRect(0, 0, labelWidth, height);
  context.fillStyle = '#454545';
  context.fillRect(trackLeft, 0, width - trackLeft, TRACE_HEADER_HEIGHT);

  context.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  context.fillStyle = '#a0a0a0';
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillText(width < 560 ? 'TASK / SHARE' : 'TASK / EXECUTION SHARE', 10, TRACE_HEADER_HEIGHT / 2);

  context.strokeStyle = '#4a4a4a';
  context.lineWidth = 1;
  for (let index = 0; index <= 5; index += 1) {
    const x = trackLeft + trackWidth * index / 5;
    context.beginPath();
    context.moveTo(Math.round(x) + 0.5, TRACE_HEADER_HEIGHT);
    context.lineTo(Math.round(x) + 0.5, height);
    context.stroke();

    const secondsAgo = Math.round(traceWindowMs / 1000 * (1 - index / 5));
    context.fillStyle = index === 5 ? '#f2f2f2' : '#a0a0a0';
    context.textAlign = index === 0 ? 'left' : index === 5 ? 'right' : 'center';
    context.fillText(index === 5 ? 'NOW' : `−${secondsAgo}s`, index === 0 ? x + 6 : x - (index === 5 ? 4 : 0), TRACE_HEADER_HEIGHT / 2);
  }

  context.strokeStyle = '#1c1c1c';
  context.beginPath();
  context.moveTo(0, TRACE_HEADER_HEIGHT - 0.5);
  context.lineTo(width, TRACE_HEADER_HEIGHT - 0.5);
  context.stroke();

  tasks.forEach((task, taskIndex) => {
    const rowTop = TRACE_HEADER_HEIGHT + taskIndex * TRACE_ROW_HEIGHT;
    const rowCenter = rowTop + TRACE_ROW_HEIGHT / 2;
    const taskDuration = totals.get(task.localId) || 0;
    const share = totalDuration ? taskDuration / totalDuration * 100 : 0;

    context.fillStyle = taskIndex % 2 ? 'rgba(255,255,255,.012)' : 'rgba(255,255,255,.025)';
    context.fillRect(0, rowTop, width, TRACE_ROW_HEIGHT);
    context.strokeStyle = '#333333';
    context.beginPath();
    context.moveTo(0, rowTop + TRACE_ROW_HEIGHT - 0.5);
    context.lineTo(width, rowTop + TRACE_ROW_HEIGHT - 0.5);
    context.stroke();

    context.fillStyle = task.traceColor;
    context.beginPath();
    context.arc(14, rowCenter - 7, 3.5, 0, Math.PI * 2);
    context.fill();

    context.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.fillStyle = '#f2f2f2';
    context.textAlign = 'left';
    context.fillText(truncateCanvasText(context, task.app, labelWidth - 34), 24, rowCenter - 7);

    context.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    context.fillStyle = '#a0a0a0';
    const taskDetail = `${task.id} · ${share.toFixed(0)}% · ${formatTraceDuration(taskDuration)}`;
    context.fillText(truncateCanvasText(context, taskDetail, labelWidth - 24), 24, rowCenter + 9);
  });

  context.save();
  context.beginPath();
  context.rect(trackLeft, TRACE_HEADER_HEIGHT, trackWidth, height - TRACE_HEADER_HEIGHT);
  context.clip();

  const signalPulses = new Map(tasks.map((task) => [task.localId, []]));

  visibleEvents.forEach((traceEvent) => {
    const taskIndex = tasks.findIndex((task) => task.localId === traceEvent.localId);
    if (taskIndex < 0) return;

    const task = tasks[taskIndex];
    const rowTop = TRACE_HEADER_HEIGHT + taskIndex * TRACE_ROW_HEIGHT;
    const eventStart = Math.max(windowStart, traceEvent.startedAtMs);
    const eventEnd = Math.min(traceClockMs, traceEvent.startedAtMs + Math.max(traceEvent.durationMs, 0.001));
    const x = trackLeft + (eventStart - windowStart) / traceWindowMs * trackWidth;
    const proportionalWidth = (eventEnd - eventStart) / traceWindowMs * trackWidth;
    const pulseWidth = Math.max(TRACE_MIN_PULSE_WIDTH, proportionalWidth);
    const pulseEndX = Math.min(trackRight, x + pulseWidth);
    const highY = rowTop + 11;
    const lowY = rowTop + TRACE_ROW_HEIGHT - 11;

    signalPulses.get(task.localId).push({
      startX: x,
      endX: pulseEndX,
      startsBeforeWindow: traceEvent.startedAtMs < windowStart
    });

    traceHitRegions.push({
      x: Math.max(trackLeft, x - 4),
      y: highY - 5,
      width: Math.max(10, pulseEndX - x + 8),
      height: lowY - highY + 10,
      traceEvent,
      task
    });
  });

  tasks.forEach((task, taskIndex) => {
    const rowTop = TRACE_HEADER_HEIGHT + taskIndex * TRACE_ROW_HEIGHT;
    const highY = rowTop + 11;
    const lowY = rowTop + TRACE_ROW_HEIGHT - 11;
    const pulses = mergeTracePulses(signalPulses.get(task.localId));

    context.save();
    context.globalAlpha = 0.16;
    context.strokeStyle = task.traceColor;
    context.lineWidth = 5;
    context.lineJoin = 'miter';
    context.lineCap = 'square';
    drawTraceSignalPath(context, pulses, trackLeft, trackRight, highY, lowY);
    context.stroke();
    context.restore();

    context.strokeStyle = task.traceColor;
    context.lineWidth = 1.5;
    context.lineJoin = 'miter';
    context.lineCap = 'square';
    drawTraceSignalPath(context, pulses, trackLeft, trackRight, highY, lowY);
    context.stroke();
  });
  context.restore();

  context.strokeStyle = '#1c1c1c';
  context.beginPath();
  context.moveTo(trackLeft - 0.5, 0);
  context.lineTo(trackLeft - 0.5, height);
  context.stroke();

  // Playhead
  context.strokeStyle = '#f2f2f2';
  context.beginPath();
  context.moveTo(trackRight + 0.5, TRACE_HEADER_HEIGHT);
  context.lineTo(trackRight + 0.5, height);
  context.stroke();

  updateTimelineEmptyState(visibleEvents.length > 0);
  updateTimelineAccessibility(totals, totalDuration, visibleEvents.length > 0);
}

function hideTimelineTooltip() {
  schedulerTimelineTooltip.hidden = true;
}

function showTimelineTooltip(pointerEvent) {
  const canvasRect = schedulerTimelineCanvas.getBoundingClientRect();
  const x = pointerEvent.clientX - canvasRect.left;
  const y = pointerEvent.clientY - canvasRect.top;
  const hit = [...traceHitRegions].reverse().find((region) => (
    x >= region.x
    && x <= region.x + region.width
    && y >= region.y
    && y <= region.y + region.height
  ));

  if (!hit) {
    hideTimelineTooltip();
    return;
  }

  const title = document.createElement('strong');
  const duration = document.createElement('span');
  const age = document.createElement('span');
  title.textContent = hit.task.app;
  duration.textContent = `Slice #${hit.traceEvent.sequence} · ${formatTraceDuration(hit.traceEvent.durationMs)}`;
  age.textContent = formatTraceAge(traceClockMs - hit.traceEvent.startedAtMs - hit.traceEvent.durationMs);
  schedulerTimelineTooltip.replaceChildren(title, duration, document.createElement('br'), age);
  schedulerTimelineTooltip.hidden = false;

  const tooltipWidth = schedulerTimelineTooltip.offsetWidth;
  const tooltipHeight = schedulerTimelineTooltip.offsetHeight;
  const left = Math.min(schedulerTimelineShell.clientWidth - tooltipWidth - 8, Math.max(8, x + 12));
  const top = Math.min(schedulerTimelineShell.clientHeight - tooltipHeight - 8, Math.max(8, y - tooltipHeight - 10));
  schedulerTimelineTooltip.style.left = `${left}px`;
  schedulerTimelineTooltip.style.top = `${top}px`;
}

/* ---------- Tasks ---------- */

async function detectEntryPoint(wasmBytes) {
  const module = await WebAssembly.compile(wasmBytes);
  const exports = WebAssembly.Module.exports(module).map((item) => item.name);
  for (const candidate of ['app_main', '_start', 'main']) {
    if (exports.includes(candidate)) return candidate;
  }
  throw new Error('No supported entry point found. Expected app_main, _start, or main.');
}

function stateToStatus(taskId) {
  const state = callRuntime('browser_task_get_state', 'number', ['number'], [taskId]);
  if (state === OS_TASK_READY) return 'Ready';
  if (state === OS_TASK_RUNNING) return 'Running';
  if (state === OS_TASK_WAITING) return 'Waiting';
  if (state === OS_TASK_SUSPENDED) return 'Paused';
  if (state === OS_TASK_SWAPPED) return 'Swapped';
  if (state !== OS_TASK_DEAD) return 'Failed';

  const reason = callRuntime('browser_task_get_exit_reason', 'number', ['number'], [taskId]);
  if (reason === OS_TASK_EXIT_WASM_ERROR) return 'Failed';
  if (reason === OS_TASK_EXIT_DELETED) return 'Stopped';
  if (reason === OS_TASK_EXIT_RETURNED || reason === OS_TASK_EXIT_EXPLICIT) return 'Completed';
  return 'Completed';
}

function createOsTask(task) {
  task.runCount = 0;
  task.lastRunAt = 0;
  task.activityUntil = 0;

  const wasmPointer = runtime._malloc(task.wasmBytes.length);
  if (!wasmPointer) throw new Error('Unable to allocate memory for the guest module');

  let taskId = 0;
  try {
    runtime.HEAPU8.set(task.wasmBytes, wasmPointer);
    taskId = callRuntime(
      'browser_task_create',
      'number',
      ['number', 'number', 'string', 'string', 'number', 'number'],
      [wasmPointer, task.wasmBytes.length, task.entryPoint, task.app, 64 * 1024, task.priority]
    );
  } finally {
    runtime._free(wasmPointer);
  }

  if (!taskId) throw new Error(runtimeError());
  task.osTaskId = taskId;
  task.id = `task_${taskId}`;
  task.status = 'Ready';
  traceTaskOwners.set(taskId, task.localId);
  appendLog(`Started ${task.app} as ${task.id} using ${task.entryPoint}`);
}

function formatLastRun(lastRunAt, now) {
  if (!lastRunAt) return 'never';

  const elapsedSeconds = Math.max(0, Math.floor((now - lastRunAt) / 1000));
  if (elapsedSeconds < 1) return 'just now';
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  return `${Math.floor(elapsedMinutes / 60)}h ago`;
}

function canSetTaskPriority(task) {
  return Boolean(task.osTaskId) && !['Completed', 'Failed', 'Stopped'].includes(task.status);
}

function createActionButton(task, action, label, symbol) {
  const button = document.createElement('button');
  button.className = 'icon-button';
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = task.localId;
  button.title = label;
  button.setAttribute('aria-label', `${label} ${task.app}`);
  button.textContent = symbol;
  return button;
}

function createTaskActions(task) {
  const actions = document.createElement('div');
  const canPause = task.osTaskId && ['Running', 'Ready', 'Waiting'].includes(task.status);
  const canResume = task.osTaskId && task.status === 'Paused';
  const canStop = Boolean(task.osTaskId) && !['Completed', 'Failed', 'Stopped'].includes(task.status);

  actions.className = 'actions';
  if (canPause) actions.appendChild(createActionButton(task, 'pause', 'Pause', 'Ⅱ'));
  else if (canResume) actions.appendChild(createActionButton(task, 'resume', 'Resume', '▶'));
  if (canStop) actions.appendChild(createActionButton(task, 'stop', 'Stop', '■'));
  actions.appendChild(createActionButton(task, 'restart', 'Restart', '↻'));
  actions.appendChild(createActionButton(task, 'remove', 'Remove', '✕'));
  return actions;
}

function createTaskRow(task, now) {
  const row = document.createElement('div');
  const dot = document.createElement('span');
  const name = document.createElement('span');
  const meta = document.createElement('div');
  const status = document.createElement('span');
  const runs = document.createElement('span');
  const priority = document.createElement('label');
  const priorityInput = document.createElement('input');
  const runLabel = task.runCount === 1 ? 'run' : 'runs';

  row.className = 'task';
  if (task.activityUntil > now) row.classList.add('is-recently-active');

  dot.className = 'task-dot';
  dot.style.background = task.traceColor;
  name.className = 'task-name';
  name.textContent = task.app;
  name.title = `${task.app} · ${task.id}`;

  status.className = 'task-status';
  status.dataset.status = task.status;
  status.textContent = `${statusIcons[task.status] || '?'} ${task.status}`;

  runs.textContent = `${integerNumberFormat.format(task.runCount)} ${runLabel} · ${formatLastRun(task.lastRunAt, now)}`;

  priority.className = 'task-priority';
  priority.textContent = 'prio';
  priorityInput.className = 'number-input';
  priorityInput.type = 'number';
  priorityInput.min = '0';
  priorityInput.max = String(UINT32_MAX);
  priorityInput.step = '1';
  priorityInput.value = String(task.priority);
  priorityInput.dataset.priorityTaskId = task.localId;
  priorityInput.disabled = !canSetTaskPriority(task);
  priorityInput.setAttribute('aria-label', `Priority for ${task.app}`);
  priority.appendChild(priorityInput);

  meta.className = 'task-meta';
  meta.append(status, runs, priority);
  row.append(dot, name, createTaskActions(task), meta);
  return row;
}

function renderTasks() {
  const now = performance.now();
  if (!tasks.length) {
    const empty = document.createElement('p');
    empty.className = 'task-empty';
    empty.textContent = 'No programs. Drop a .wasm file anywhere or use Load.';
    taskList.replaceChildren(empty);
  } else {
    taskList.replaceChildren(...tasks.map((task) => createTaskRow(task, now)));
  }
  updateCounters();
}

function updateCounters() {
  let ready = tasks.filter((task) => ['Running', 'Ready'].includes(task.status)).length;
  let waiting = tasks.filter((task) => task.status === 'Waiting').length;
  let total = ready + waiting;
  let timers = 0;

  if (runtime) {
    try {
      total = callRuntime('browser_runtime_get_task_count', 'number');
      ready = callRuntime('browser_runtime_get_ready_task_count', 'number');
      waiting = callRuntime('browser_runtime_get_waiting_task_count', 'number');
      timers = callRuntime('browser_runtime_get_timer_count', 'number');
    } catch (error) {
      // Keep UI-derived counters while an older cached runtime is replaced.
    }
  }

  activeBadge.textContent = String(tasks.length);
  lcdTasks.textContent = String(total);
  lcdReady.textContent = `${ready}/${total}`;
  cpuView.tasks.textContent = String(total);
  cpuView.ready.textContent = String(ready);
  waitingCount.textContent = String(waiting);
  timerCount.textContent = String(timers);

  if (runtime && runtime.HEAPU8) {
    const memoryMb = runtime.HEAPU8.buffer.byteLength / (1024 * 1024);
    memoryValue.textContent = `${memoryMb.toFixed(1)} MB`;
  }
}

function findTask(localId) {
  return tasks.find((task) => task.localId === localId);
}

function parsePriority(value) {
  if (value.trim() === '') throw new Error('Priority is required');

  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 0 || priority > UINT32_MAX) {
    throw new Error(`Priority must be an integer between 0 and ${UINT32_MAX}`);
  }
  return priority;
}

function updateTaskPriority(task, input) {
  const previousPriority = task.priority;

  try {
    if (!task.osTaskId) throw new Error('Task is not available in the runtime');

    const nextPriority = parsePriority(input.value);
    const status = callRuntime('browser_task_set_priority', 'number', ['number', 'number'], [task.osTaskId, nextPriority]);
    if (status !== OS_STATUS_OK) throw new Error(runtimeError());

    task.priority = callRuntime('browser_task_get_priority', 'number', ['number'], [task.osTaskId]);
    appendLog(`${task.id}: priority changed from ${previousPriority} to ${task.priority}`);
  } catch (error) {
    task.priority = previousPriority;
    appendLog(`${task.app}: ${error.message}`);
  }

  renderTasks();
}

function deleteOsTask(task) {
  if (!task.osTaskId) return;
  callRuntime('browser_task_delete', 'number', ['number'], [task.osTaskId]);
  task.osTaskId = 0;
}

async function handleTaskAction(task, action) {
  try {
    if (action === 'pause') {
      const status = callRuntime('browser_task_suspend', 'number', ['number'], [task.osTaskId]);
      if (status !== OS_STATUS_OK) throw new Error(runtimeError());
      task.status = 'Paused';
    } else if (action === 'resume') {
      const status = callRuntime('browser_task_resume', 'number', ['number'], [task.osTaskId]);
      if (status !== OS_STATUS_OK) throw new Error(runtimeError());
      task.status = 'Ready';
    } else if (action === 'stop') {
      deleteOsTask(task);
      task.status = 'Stopped';
    } else if (action === 'restart') {
      deleteOsTask(task);
      createOsTask(task);
    } else if (action === 'remove') {
      deleteOsTask(task);
      tasks.splice(tasks.indexOf(task), 1);
    }
    appendLog(`${task.id}: ${action.toUpperCase()}`);
  } catch (error) {
    task.status = 'Failed';
    appendLog(`${task.app}: ${error.message}`);
  }
  renderTasks();
}

taskList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const task = findTask(button.dataset.id);
  if (task) handleTaskAction(task, button.dataset.action);
});

taskList.addEventListener('change', (event) => {
  const input = event.target.closest('input[data-priority-task-id]');
  if (!input) return;
  const task = findTask(input.dataset.priorityTaskId);
  if (task) updateTaskPriority(task, input);
});

taskList.addEventListener('keydown', (event) => {
  const input = event.target.closest('input[data-priority-task-id]');
  if (!input) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    input.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    const task = findTask(input.dataset.priorityTaskId);
    if (task) input.value = String(task.priority);
    input.blur();
  }
});

/* ---------- Loading programs ---------- */

function openPicker() {
  fileInput.click();
}

async function addFile(file) {
  if (!file.name.toLowerCase().endsWith('.wasm')) {
    appendLog(`Rejected ${file.name}: .wasm files only`);
    return;
  }
  if (!runtime) {
    appendLog(`Cannot start ${file.name}: runtime is still loading`);
    return;
  }

  const wasmBytes = new Uint8Array(await file.arrayBuffer());
  const task = {
    localId: crypto.randomUUID(),
    id: 'pending',
    app: file.name,
    status: 'Ready',
    priority: 5,
    osTaskId: 0,
    runCount: 0,
    lastRunAt: 0,
    activityUntil: 0,
    traceColor: TRACE_COLORS[nextTraceColor++ % TRACE_COLORS.length],
    wasmBytes,
    entryPoint: await detectEntryPoint(wasmBytes)
  };

  try {
    createOsTask(task);
    tasks.push(task);
  } catch (error) {
    task.status = 'Failed';
    task.id = 'not-created';
    tasks.push(task);
    appendLog(`${file.name}: ${error.message}`);
  }
  renderTasks();
}

function handleFiles(files) {
  Array.from(files).forEach((file) => addFile(file).catch((error) => appendLog(`${file.name}: ${error.message}`)));
}

let pageFileDragDepth = 0;

function dragContainsFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function setPageDropActive(active) {
  pageDropOverlay.classList.toggle('is-active', active);
  pageDropOverlay.setAttribute('aria-hidden', String(!active));
}

function resetPageFileDrag() {
  pageFileDragDepth = 0;
  setPageDropActive(false);
}

document.addEventListener('dragenter', (event) => {
  if (!dragContainsFiles(event)) return;
  event.preventDefault();
  pageFileDragDepth += 1;
  setPageDropActive(true);
}, true);

document.addEventListener('dragover', (event) => {
  if (!dragContainsFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  setPageDropActive(true);
}, true);

document.addEventListener('dragleave', (event) => {
  if (pageFileDragDepth === 0) return;
  event.preventDefault();
  pageFileDragDepth -= 1;
  if (pageFileDragDepth === 0) setPageDropActive(false);
}, true);

document.addEventListener('drop', (event) => {
  if (!dragContainsFiles(event)) return;
  event.preventDefault();
  const files = event.dataTransfer.files;
  resetPageFileDrag();
  if (files.length > 0) handleFiles(files);
}, true);

document.addEventListener('dragend', resetPageFileDrag, true);

loadButton.addEventListener('click', openPicker);
newTaskButton.addEventListener('click', openPicker);
fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

/* ---------- Board, library, panels ---------- */

function createCpuNode() {
  Board.addNode({
    id: CPU_NODE_ID,
    x: -130,
    y: -110,
    width: 260,
    height: 220,
    pins: {
      left: ['GPIO0', 'GPIO1', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO5', 'GPIO6', 'GPIO7'],
      right: ['SCK', 'MOSI', 'MISO', 'CS', 'SDA', 'SCL', 'TX', 'RX'],
      top: ['3V3', '5V'],
      bottom: ['GND', 'GND']
    },
    render(chip) {
      const notch = document.createElement('span');
      const led = document.createElement('span');
      const title = document.createElement('div');
      const subtitle = document.createElement('div');
      const stats = document.createElement('div');
      const hint = document.createElement('div');

      notch.className = 'chip-notch';
      led.className = 'chip-led';
      title.className = 'chip-title';
      title.textContent = 'WASM CPU';
      subtitle.className = 'chip-subtitle';
      subtitle.textContent = 'wasm-rtos · wasm3';
      stats.className = 'chip-stats';
      hint.className = 'chip-drop-hint';
      hint.textContent = 'drop .wasm to run';

      const stat = (label) => {
        const wrapper = document.createElement('div');
        const value = document.createElement('strong');
        const caption = document.createElement('span');
        wrapper.className = 'chip-stat';
        value.textContent = '0';
        caption.textContent = label;
        wrapper.append(value, caption);
        stats.appendChild(wrapper);
        return value;
      };

      cpuView.tasks = stat('TASKS');
      cpuView.ready = stat('READY');
      cpuView.fuel = stat('MFUEL/S');
      cpuView.led = led;
      chip.append(notch, led, title, subtitle, stats, hint);
    }
  });
}

function renderLibrary() {
  const query = librarySearch.value.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  let lastCategory = '';

  PARTS
    .filter((part) => !query || `${part.name} ${part.meta} ${part.category}`.toLowerCase().includes(query))
    .forEach((part) => {
      if (part.category !== lastCategory) {
        const heading = document.createElement('div');
        heading.className = 'library-category';
        heading.textContent = part.category;
        fragment.appendChild(heading);
        lastCategory = part.category;
      }

      const item = document.createElement('button');
      const icon = document.createElement('span');
      const text = document.createElement('span');
      const name = document.createElement('span');
      const meta = document.createElement('span');
      const tag = document.createElement('span');

      item.type = 'button';
      item.className = 'library-item';
      item.disabled = !part.available;
      item.dataset.partId = part.id;
      if (part.id === Board.getSelected()) item.classList.add('is-selected');
      icon.className = 'library-item-icon';
      icon.textContent = part.icon;
      text.className = 'library-item-text';
      name.className = 'library-item-name';
      name.textContent = part.name;
      meta.className = 'library-item-meta';
      meta.textContent = part.meta;
      tag.className = part.available ? 'library-item-tag is-placed' : 'library-item-tag';
      tag.textContent = part.available ? 'on board' : 'planned';

      text.append(name, meta);
      item.append(icon, text, tag);
      fragment.appendChild(item);
    });

  libraryList.replaceChildren(fragment);
}

libraryList.addEventListener('click', (event) => {
  const item = event.target.closest('.library-item');
  if (!item || item.disabled) return;
  Board.select(item.dataset.partId);
  Board.fit();
});

librarySearch.addEventListener('input', renderLibrary);
Board.on('select', renderLibrary);

const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

function setPanel(name, visible) {
  const button = document.querySelector(`#toggle${name[0].toUpperCase()}${name.slice(1)}`);
  if (isNarrow() && name !== 'editor') {
    app.classList.toggle(`show-${name}`, visible);
  } else {
    app.classList.toggle(`no-${name}`, !visible);
  }
  button.classList.toggle('is-on', visible);
  button.setAttribute('aria-pressed', String(visible));
}

function togglePanel(name) {
  const button = document.querySelector(`#toggle${name[0].toUpperCase()}${name.slice(1)}`);
  setPanel(name, button.getAttribute('aria-pressed') !== 'true');
}

function syncPanelsToViewport() {
  ['library', 'inspector'].forEach((name) => {
    app.classList.remove(`show-${name}`, `no-${name}`);
    setPanel(name, !isNarrow());
  });
}

['library', 'inspector', 'editor'].forEach((name) => {
  document.querySelector(`#toggle${name[0].toUpperCase()}${name.slice(1)}`)
    .addEventListener('click', () => togglePanel(name));
});
window.matchMedia('(max-width: 900px)').addEventListener('change', syncPanelsToViewport);

runButton.addEventListener('click', toggleRun);

document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, select, button, [contenteditable]')) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (event.key === ' ') toggleRun();
  else if (key === 'l') togglePanel('library');
  else if (key === 'i') togglePanel('inspector');
  else if (key === 'e') togglePanel('editor');
  else if (key === 'o') openPicker();
  else return;
  event.preventDefault();
});

// Editor tabs
const editorTabs = [...document.querySelectorAll('.editor-tabs .tab')];
editorTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    editorTabs.forEach((other) => {
      const active = other === tab;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
      document.querySelector(`#${other.getAttribute('aria-controls')}`).hidden = !active;
    });
    if (tab.id === 'consoleTab') consoleLog.scrollTop = consoleLog.scrollHeight;
  });
});

// Editor height: drag the top edge, or use arrow keys on it.
function setEditorHeight(height) {
  const max = Math.max(120, window.innerHeight - 200);
  const clamped = Math.round(Math.min(max, Math.max(110, height)));
  document.documentElement.style.setProperty('--editor-h', `${clamped}px`);
  try { localStorage.setItem('wasm-rtos.editor-height', String(clamped)); } catch (error) { /* optional */ }
}

editorResize.addEventListener('pointerdown', (event) => {
  editorResize.setPointerCapture(event.pointerId);
  const startY = event.clientY;
  const startHeight = editorPanel.getBoundingClientRect().height;
  const move = (moveEvent) => setEditorHeight(startHeight + startY - moveEvent.clientY);
  const stop = () => {
    editorResize.removeEventListener('pointermove', move);
    editorResize.removeEventListener('pointerup', stop);
    editorResize.removeEventListener('pointercancel', stop);
  };
  editorResize.addEventListener('pointermove', move);
  editorResize.addEventListener('pointerup', stop);
  editorResize.addEventListener('pointercancel', stop);
});

editorResize.addEventListener('keydown', (event) => {
  const height = editorPanel.getBoundingClientRect().height;
  if (event.key === 'ArrowUp') setEditorHeight(height + 20);
  else if (event.key === 'ArrowDown') setEditorHeight(height - 20);
  else return;
  event.preventDefault();
});

try {
  const savedHeight = Number(localStorage.getItem('wasm-rtos.editor-height'));
  if (savedHeight) setEditorHeight(savedHeight);
} catch (error) {
  // Storage unavailable; keep the default height.
}

/* ---------- Runtime lifecycle ---------- */

function refreshRuntimeState() {
  if (!runtime) return;
  const sampledAt = performance.now();
  tasks.forEach((task) => {
    if (task.osTaskId) {
      task.status = stateToStatus(task.osTaskId);
      task.priority = callRuntime('browser_task_get_priority', 'number', ['number'], [task.osTaskId]);
      const runCount = callRuntime('browser_task_get_run_count', 'number', ['number'], [task.osTaskId]) >>> 0;
      if (runCount !== task.runCount) {
        task.runCount = runCount;
        task.lastRunAt = sampledAt;
        task.activityUntil = sampledAt + TASK_ACTIVITY_PULSE_MS;
      }
    }
  });
  updateFuelTelemetry();

  const activeElement = document.activeElement;
  if (activeElement && activeElement.matches('input[data-priority-task-id]')) {
    updateCounters();
    return;
  }

  renderTasks();
}

function updateRuntimeClock() {
  const seconds = runtimeStartedAt ? Math.floor((performance.now() - runtimeStartedAt) / 1000) : 0;
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const remaining = String(seconds % 60).padStart(2, '0');
  lcdClock.textContent = `${hours}:${minutes}:${remaining}`;
}

async function initializeRuntime() {
  consoleLog.textContent = '> _';
  appendLog('Loading wasm-rtos browser runtime');
  try {
    if (typeof createWasmRtosModule !== 'function') {
      throw new Error('os/wasm-rtos.js was not found');
    }
    runtime = await createWasmRtosModule({
      locateFile: (path) => path.endsWith('.wasm') ? 'os/wasm-rtos.wasm' : `os/${path}`,
      print: (message) => appendLog(message),
      printErr: (message) => appendLog(`ERROR: ${message}`)
    });
    const status = callRuntime('browser_runtime_init', 'number', [], []);
    if (status !== OS_STATUS_OK) throw new Error(runtimeError());
    fuelPerSlice = callRuntime('browser_runtime_get_fuel_per_slice', 'number') || fuelPerSlice;
    setFuelRate(fuelRatePerMs);
    initializeTraceTelemetry();
    runtimeStartedAt = performance.now();
    runtimeStatus.textContent = 'Running';
    runtimeStatusDetail.textContent = 'wasm-rtos is ready';
    appendLog('wasm-rtos initialized');
  } catch (error) {
    runtime = null;
    runtimeFailed = true;
    runtimeStatus.textContent = 'Failed';
    runtimeStatusDetail.textContent = error.message;
    appendLog(`Runtime initialization failed: ${error.message}`);
  }
  renderRunState();
  renderTasks();
}

createCpuNode();
if (!Board.hasSavedView()) Board.fit();
Board.select(CPU_NODE_ID);
renderLibrary();
syncPanelsToViewport();

setInterval(refreshRuntimeState, 250);
setInterval(updateRuntimeClock, 1000);
fuelRateSlider.addEventListener('input', () => setFuelRate(fuelRateSlider.value));
fuelRateInput.addEventListener('input', () => {
  if (fuelRateInput.value !== '') setFuelRate(fuelRateInput.value, false);
});
fuelRateInput.addEventListener('change', () => setFuelRate(fuelRateInput.value || fuelRatePerMs));
schedulerTimelineCanvas.addEventListener('pointermove', showTimelineTooltip);
schedulerTimelineCanvas.addEventListener('pointerleave', hideTimelineTooltip);
renderFuelRate();
renderTasks();
initializeRuntime();
requestAnimationFrame(drawSchedulerTimeline);
