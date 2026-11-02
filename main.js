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
// Lines kept in the console and in each program's output.
const CONSOLE_MAX_LINES = 2000;
const PROGRAM_OUTPUT_MAX_LINES = 500;
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
const OS_TASK_DEAD = 4;

const OS_TASK_EXIT_RETURNED = 1;
const OS_TASK_EXIT_EXPLICIT = 2;
const OS_TASK_EXIT_DELETED = 3;
const OS_TASK_EXIT_WASM_ERROR = 4;

const UINT32_MAX = 0xFFFFFFFF;
const CPU_NODE_ID = 'cpu';

// Browser file store, mounted by the runtime like an SD card.
const FS_ROOT = '/sd';
const FS_TYPE_FILE = 1;
const FS_TYPE_DIRECTORY = 2;
const OS_STATUS_END_OF_DIRECTORY = 29;
const FS_NAME_BUFFER_SIZE = 256;

const statusIcons = {
  Running: '▶',
  Ready: '◷',
  Waiting: '◷',
  Paused: 'Ⅱ',
  Completed: '✓',
  Failed: '×',
  Stopped: '■'
};

// Parts catalogue. The processor, the LED and the button are wired to the kernel.
// The catalog; a part is on the board when the device profile places it (by id).
const PARTS = [
  { category: 'Processor', id: CPU_NODE_ID, name: 'WASM CPU', meta: 'wasm-rtos · wasm3', icon: 'CPU' },
  { category: 'Devices', id: 'watch', name: 'Watch', meta: 'Round 240×240 · bezel · 2 buttons · touch', icon: 'WCH' },
  { category: 'Displays', id: 'gc9a01', name: 'GC9A01', meta: 'Round TFT 240×240 · spi0 · CS GPIO5, DC GPIO4', icon: 'TFT' },
  { category: 'Displays', id: 'ssd1306', name: 'SSD1306', meta: 'OLED 128×64 · 1-bit · "main"', icon: 'OLD' },
  { category: 'Sensors', id: 'lm75', name: 'LM75', meta: 'Temperature · i2c0 at 0x48', icon: 'TMP' },
  { category: 'Sensors', id: 'bme280', name: 'BME280', meta: 'Temperature, humidity, pressure · I²C', icon: 'ENV' },
  { category: 'Sensors', id: 'mpu6050', name: 'MPU6050', meta: '6-axis IMU · I²C', icon: 'IMU' },
  { category: 'Input', id: 'button', name: 'Push button', meta: 'GPIO0 · "button-a" · to ground', icon: 'BTN' },
  { category: 'Input', id: 'potentiometer', name: 'Potentiometer', meta: 'Analog', icon: 'POT' },
  { category: 'Output', id: 'led', name: 'LED', meta: 'GPIO2 · "led"', icon: 'LED' },
  { category: 'Output', id: 'neopixel', name: 'RGB LED strip', meta: 'Addressable · GPIO', icon: 'RGB' }
];

const app = document.querySelector('#app');
const taskList = document.querySelector('#taskList');
const activeBadge = document.querySelector('#activeBadge');
const waitingCount = document.querySelector('#waitingCount');
const timerCount = document.querySelector('#timerCount');
const consoleLog = document.querySelector('#consoleLog');
const busLog = document.querySelector('#busLog');
const runtimeStatus = document.querySelector('#runtimeStatus');
const runtimeStatusDetail = document.querySelector('#runtimeStatusDetail');
const memoryValue = document.querySelector('#memoryValue');
const deviceSelect = document.querySelector('#deviceSelect');
const programSection = document.querySelector('#programSection');
const programTitle = document.querySelector('#programTitle');
const programProps = document.querySelector('#programProps');
const programError = document.querySelector('#programError');
const programOutput = document.querySelector('#programOutput');
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
const filesPath = document.querySelector('#filesPath');
const filesList = document.querySelector('#filesList');
const filesUp = document.querySelector('#filesUp');
const filesRun = document.querySelector('#filesRun');
const filesAdd = document.querySelector('#filesAdd');
const filesAddFolder = document.querySelector('#filesAddFolder');
const filesDelete = document.querySelector('#filesDelete');
const filesInput = document.querySelector('#filesInput');
const folderInput = document.querySelector('#folderInput');
const pageDropDetail = document.querySelector('#pageDropDetail');
const filesFootnote = document.querySelector('#filesFootnote');
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
const compactNumberFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

const cpuView = {};

function timeStamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// The console keeps its last lines and redraws once per frame, so a chatty program cannot stall the page.
const consoleLines = [];
let consoleRedrawPending = false;

function appendLog(message) {
  consoleLines.push(`[${timeStamp()}] ${message}`);
  if (consoleLines.length > CONSOLE_MAX_LINES) consoleLines.splice(0, consoleLines.length - CONSOLE_MAX_LINES);
  if (consoleRedrawPending) return;
  consoleRedrawPending = true;
  requestAnimationFrame(() => {
    consoleRedrawPending = false;
    consoleLog.textContent = `${consoleLines.join('\n')}\n> _`;
    consoleLog.scrollTop = consoleLog.scrollHeight;
  });
}

/* ---------- Program output ---------- */

// Output arrives as bytes in pieces of any size; lines are cut per program and stream.
const outputStreams = new Map();

function onProgramOutput(taskId, fd, bytes) {
  const key = `${taskId}:${fd}`;
  let stream = outputStreams.get(key);
  if (!stream) {
    stream = { decoder: new TextDecoder(), pending: '' };
    outputStreams.set(key, stream);
  }
  const lines = (stream.pending + stream.decoder.decode(bytes, { stream: true })).split('\n');
  stream.pending = lines.pop();
  lines.forEach((line) => addProgramLine(taskId, fd, line));
}

// A program that ends without a final newline still shows its last line.
function flushProgramOutput(taskId) {
  [1, 2].forEach((fd) => {
    const key = `${taskId}:${fd}`;
    const stream = outputStreams.get(key);
    if (!stream) return;
    const rest = stream.pending + stream.decoder.decode();
    if (rest) addProgramLine(taskId, fd, rest);
    outputStreams.delete(key);
  });
}

function addProgramLine(taskId, fd, line) {
  const task = tasks.find((entry) => entry.osTaskId === taskId);
  const label = task ? task.id : `task_${taskId}`;
  appendLog(fd === 2 ? `${label} stderr: ${line}` : `${label}: ${line}`);
  if (!task) return;
  task.output.push(fd === 2 ? `! ${line}` : line);
  if (task.output.length > PROGRAM_OUTPUT_MAX_LINES) task.output.splice(0, task.output.length - PROGRAM_OUTPUT_MAX_LINES);
  task.outputVersion += 1;
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
  lcdFuelUnit.textContent = 'Mfuel/s';
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
requestAnimationFrame(drawDeviceParts);
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

function stateToStatus(taskId) {
  const state = callRuntime('browser_task_get_state', 'number', ['number'], [taskId]);
  if (state === OS_TASK_READY) return 'Ready';
  if (state === OS_TASK_RUNNING) return 'Running';
  if (state === OS_TASK_WAITING) return 'Waiting';
  if (state === OS_TASK_SUSPENDED) return 'Paused';
  if (state !== OS_TASK_DEAD) return 'Failed';

  const reason = callRuntime('browser_task_get_exit_reason', 'number', ['number'], [taskId]);
  if (reason === OS_TASK_EXIT_WASM_ERROR) return 'Failed';
  if (reason === OS_TASK_EXIT_DELETED) return 'Stopped';
  if (reason === OS_TASK_EXIT_RETURNED || reason === OS_TASK_EXIT_EXPLICIT) return 'Completed';
  return 'Completed';
}

// The kernel loads the program from the file system, like an executable.
function createOsTask(task) {
  task.runCount = 0;
  task.lastRunAt = 0;
  task.activityUntil = 0;

  const taskId = callRuntime('browser_task_spawn', 'number', ['string', 'number'], [task.path, task.priority]);
  if (!taskId) throw new Error(runtimeError());
  task.osTaskId = taskId;
  task.id = `task_${taskId}`;
  task.status = 'Ready';
  traceTaskOwners.set(taskId, task.localId);
  appendLog(`Started ${task.path} as ${task.id}`);
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
  if (task.osTaskId && !task.swapped && ['Ready', 'Waiting', 'Paused'].includes(task.status)) {
    actions.appendChild(createActionButton(task, 'swap', 'Swap out of RAM', '⇣'));
  }
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
  row.dataset.taskId = task.localId;
  if (task.activityUntil > now) row.classList.add('is-recently-active');
  if (task.localId === selectedTaskId) row.classList.add('is-selected');

  dot.className = 'task-dot';
  dot.style.background = task.traceColor;
  name.className = 'task-name';
  name.textContent = task.app;
  name.title = `${task.app} · ${task.id}`;

  status.className = 'task-status';
  status.dataset.status = task.status;
  status.textContent = `${statusIcons[task.status] || '?'} ${task.status}${task.swapped ? ' · in swap' : ''}`;
  if (task.swapped) status.title = 'Out of RAM; it comes back when it runs';

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
    empty.textContent = 'No programs. Run one from Files, or drop a .wasm file anywhere.';
    taskList.replaceChildren(empty);
  } else {
    taskList.replaceChildren(...tasks.map((task) => createTaskRow(task, now)));
  }
  updateCounters();
  renderProgram();
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
      // A paused program has nothing to do: it leaves RAM until resumed.
      swapOut(task);
    } else if (action === 'swap') {
      swapOut(task);
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
  if (!button) {
    const row = event.target.closest('.task');
    if (row && !event.target.closest('input, label')) selectTask(row.dataset.taskId);
    return;
  }
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

/* ---------- Program inspector ---------- */

let selectedTaskId = '';

function selectTask(localId) {
  selectedTaskId = localId;
  renderTasks();
}

// Swapping is an optimisation: when it cannot happen, the program stays in RAM.
function swapOut(task) {
  const before = readTaskMemory(task.osTaskId);
  if (callRuntime('browser_task_swap_out', 'number', ['number'], [task.osTaskId]) !== OS_STATUS_OK) {
    appendLog(`${task.id}: stays in RAM (${runtimeError()})`);
    return;
  }
  const after = readTaskMemory(task.osTaskId);
  if (before && after) {
    appendLog(`${task.id}: swapped out, ${formatSize(before.total - after.total)} of RAM freed, ` +
      `${formatSize(after.swap)} in swap`);
  }
  task.status = stateToStatus(task.osTaskId);
  task.swapped = true;
}

// os_task_get_memory_usage for a task, or null.
function readTaskMemory(taskId) {
  if (!runtime || !taskId) return null;
  const out = runtime._malloc(40);
  try {
    if (callRuntime('browser_task_get_memory_usage', 'number', ['number', 'number'], [taskId, out]) !== OS_STATUS_OK) {
      return null;
    }
    const view = new DataView(runtime.HEAPU8.buffer, out, 40);
    const field = (index) => view.getUint32(index * 4, true);
    return {
      stack: field(0), stackPeak: field(1), memory: field(2), code: field(3), interpreter: field(4),
      interpreterPeak: field(5), image: field(6), swap: field(7), kernel: field(8), total: field(9)
    };
  } finally {
    runtime._free(out);
  }
}

function readTaskString(name, taskId) {
  const pointer = taskId ? callRuntime(name, 'number', ['number'], [taskId]) : 0;
  return pointer ? runtime.UTF8ToString(pointer) : '';
}

// The pins a task owns, by every name programs may use for them.
function ownedPins(taskId) {
  const pins = [...new Set(DEVICE_PROFILE.pins.map((entry) => entry.pin))];
  return pins
    .filter((pin) => callRuntime('browser_gpio_get_owner', 'number', ['number'], [pin]) === taskId)
    .map((pin) => `GPIO${pin} (${pinNames(pin).filter((name) => name !== `gpio${pin}`).join(', ') || `gpio${pin}`})`);
}

// Displays and input devices a task owns, by name.
function ownedDevices(taskId) {
  const owned = (call, entry) => callRuntime(call, 'number', ['number'], [entry.number]) === taskId;
  return [
    ...DEVICE_PROFILE.displays.filter((entry) => owned('browser_display_get_owner', entry)).map((entry) => `display "${entry.name}"`),
    ...DEVICE_PROFILE.inputs.filter((entry) => owned('browser_input_get_owner', entry)).map((entry) => `"${entry.name}"`)
  ];
}

function renderProgram() {
  const task = tasks.find((entry) => entry.localId === selectedTaskId);
  programSection.hidden = !task;
  if (!task || !runtime) return;

  const rows = [];
  const add = (label, value) => { if (value !== '' && value !== null && value !== undefined) rows.push([label, value]); };
  const appName = readTaskString('browser_task_get_app_name', task.osTaskId);
  const memory = readTaskMemory(task.osTaskId);

  programTitle.textContent = appName || task.app;
  add('File', task.path);
  add('Task', task.id);
  add('State', task.swapped ? `${task.status}, in swap` : task.status);
  add('Priority', String(task.priority));
  add('Runs', integerNumberFormat.format(task.runCount));
  if (task.osTaskId) {
    const fuel = callRuntime('browser_task_get_fuel_used', 'number', ['number'], [task.osTaskId]);
    const cpuMs = callRuntime('browser_task_get_cpu_ms', 'number', ['number'], [task.osTaskId]);
    add('Fuel', `${compactNumberFormat.format(fuel)} spent`);
    add('CPU time', formatCpuTime(cpuMs));
  }
  const ended = ['Completed', 'Failed', 'Stopped'].includes(task.status);
  if (memory && ended) {
    add('Stack', `${formatSize(memory.stackPeak)} at most`);
  } else if (memory) {
    const inRam = memory.total;
    add('RAM', formatSize(inRam));
    add('Memory', formatSize(memory.memory));
    add('Stack', memory.stack ? `${formatSize(memory.stackPeak)} of ${formatSize(memory.stack)} used`
      : `${formatSize(memory.stackPeak)} at most`);
    add('Code', formatSize(memory.code));
    if (memory.interpreter) add('Interpreter', formatSize(memory.interpreter));
    if (memory.image) add('Image', formatSize(memory.image));
    add('Kernel', formatSize(memory.kernel));
    if (memory.swap) add('In swap', formatSize(memory.swap));
  }
  if (task.osTaskId) {
    const pins = ownedPins(task.osTaskId);
    const devices = ownedDevices(task.osTaskId);
    if (DEVICE_PROFILE.pins.length) add('Pins', pins.length ? pins.join(', ') : 'none');
    if (devices.length) add('Devices', devices.join(', '));
  }

  programProps.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    return [term, detail];
  }));

  const error = readTaskString('browser_task_get_error', task.osTaskId);
  programError.hidden = !error;
  programError.textContent = error;
  renderProgramOutput(task);
}

// Redraw only when the output changed; stay at the bottom unless the reader scrolled up.
function renderProgramOutput(task) {
  if (programOutput.dataset.task === task.localId && programOutput.dataset.version === String(task.outputVersion)) return;
  const sameTask = programOutput.dataset.task === task.localId;
  const atBottom = programOutput.scrollHeight - programOutput.scrollTop - programOutput.clientHeight < 4;
  programOutput.dataset.task = task.localId;
  programOutput.dataset.version = String(task.outputVersion);
  programOutput.hidden = task.output.length === 0;
  programOutput.textContent = task.output.join('\n');
  if (atBottom || !sameTask) programOutput.scrollTop = programOutput.scrollHeight;
}

function formatCpuTime(milliseconds) {
  if (milliseconds < 1) return `${(milliseconds * 1000).toFixed(0)} µs`;
  if (milliseconds < 1000) return `${milliseconds.toFixed(1)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

/* ---------- Bus analyzer ---------- */

const BUS_MAX_ROWS = 400;
const OS_BUS_I2C = 1;
const OS_BUS_NO_CS = 0xffffffff;
const BUS_STATUS_NAMES = { 0: 'ok', 9: 'unsupported', 14: 'timeout', 30: 'NACK', 31: 'bus error' };
const GC9A01_COMMANDS = {
  0x01: 'SWRESET', 0x10: 'SLPIN', 0x11: 'SLPOUT', 0x20: 'INVOFF', 0x21: 'INVON', 0x28: 'DISPOFF', 0x29: 'DISPON',
  0x2a: 'CASET', 0x2b: 'RASET', 0x2c: 'RAMWR', 0x36: 'MADCTL', 0x3a: 'COLMOD', 0x3c: 'RAMWRC'
};
const busRows = [];
const busChipState = new Map();
let busSequence = 0;
let busChanged = false;

const hex = (bytes) => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

function busChip(kind, bus, device) {
  return DEVICE_PROFILE.chips.find((chip) => (kind === OS_BUS_I2C
    ? chip.type === 'lm75' && chip.address === device
    : chip.type === 'gc9a01' && chip.cs === device) && chip.bus === bus);
}

// What a transaction means to the chip it went to.
function decodeBus(event, chip) {
  if (!chip || event.status !== 0 || !event.ops) return '';
  if (chip.type === 'lm75') {
    const registers = ['temperature', 'configuration', 'hysteresis', 'limit'];
    const pointer = event.out.length ? event.out[0] & 3 : busChipState.get(chip) ?? 0;
    if (event.out.length) busChipState.set(chip, pointer);
    if (event.in.length >= 2 && pointer === 0) {
      const raw = ((event.in[0] << 8) | event.in[1]) << 16 >> 16;
      return `temperature ${(raw / 256).toFixed(2)} °C`;
    }
    return event.out.length > 1 ? `write ${registers[pointer]}` : event.in.length ? `read ${registers[pointer]}` : `select ${registers[pointer]}`;
  }
  const command = (event.pins >> chip.dc) & 1 ? null : event.out[0];
  if (command !== null && command !== undefined) {
    busChipState.set(chip, command);
    return GC9A01_COMMANDS[command] ?? `command 0x${command.toString(16)}`;
  }
  const last = busChipState.get(chip);
  if (last === 0x2c || last === 0x3c) return `pixels, ${event.written / 2} px`;
  if ((last === 0x2a || last === 0x2b) && event.out.length >= 4) {
    return `${last === 0x2a ? 'columns' : 'rows'} ${(event.out[0] << 8) | event.out[1]}–${(event.out[2] << 8) | event.out[3]}`;
  }
  return `${GC9A01_COMMANDS[last] ?? 'parameters'} ${hex(event.out)}`;
}

function readBusEvent(pointer) {
  const view = new DataView(runtime.HEAPU8.buffer, pointer, callRuntime('browser_bus_event_size', 'number'));
  const u32 = (offset) => view.getUint32(offset, true);
  const written = u32(28);
  const read = u32(32);
  return {
    time: view.getFloat64(0, true), task: u32(8), kind: u32(12), bus: u32(16), device: u32(20), status: view.getInt32(24, true),
    written, read, hz: u32(36), pins: u32(40), ops: u32(44),
    out: [...new Uint8Array(runtime.HEAPU8.buffer, pointer + 48, Math.min(16, written))],
    in: [...new Uint8Array(runtime.HEAPU8.buffer, pointer + 64, Math.min(16, read))]
  };
}

function busRow(event) {
  const kind = event.kind === OS_BUS_I2C ? 'i2c' : 'spi';
  const busName = DEVICE_PROFILE.buses.find((bus) => bus.kind === kind && bus.number === event.bus)?.name ?? `${kind}${event.bus}`;
  const chip = busChip(event.kind, event.bus, event.device);
  const device = event.kind === OS_BUS_I2C ? `0x${event.device.toString(16).padStart(2, '0')}`
    : event.device === OS_BUS_NO_CS ? 'own CS' : `CS${event.device}`;
  const more = (bytes, total) => `${hex(bytes)}${total > bytes.length ? ` … (${total} B)` : ''}`;
  const data = [event.written ? `W ${more(event.out, event.written)}` : '', event.read ? `R ${more(event.in, event.read)}` : '']
    .filter(Boolean).join(' → ') || (event.ops ? '' : 'address only');
  const status = BUS_STATUS_NAMES[event.status] ?? `status ${event.status}`;
  const meaning = decodeBus(event, chip);
  return {
    key: `${event.task}:${busName}:${device}`,
    pixels: meaning.startsWith('pixels'),
    event,
    text: [`${(event.time / 1000).toFixed(3).padStart(9)} s`, `task_${event.task}`.padEnd(8), busName, device.padEnd(7),
      (chip?.name ?? '').padEnd(7), data, meaning, event.status ? `! ${status}` : ''].filter(Boolean).join('  ')
  };
}

// New transactions since the last look; pixel writes in a row fold into one line.
function pollBus() {
  if (!runtime || !DEVICE_PROFILE.buses.length) return;
  const latest = callRuntime('browser_bus_get_latest_sequence', 'number');
  if (latest === busSequence) return;
  // The runtime keeps the last 1024; older ones are gone.
  const first = Math.max(busSequence + 1, latest - 1023);
  if (first > busSequence + 1) busRows.push({ key: '', text: `            … ${first - busSequence - 1} transactions not shown` });
  for (let sequence = first; sequence <= latest; sequence += 1) {
    const pointer = callRuntime('browser_bus_get_event', 'number', ['number'], [sequence]);
    if (!pointer) continue;
    const row = busRow(readBusEvent(pointer));
    const previous = busRows[busRows.length - 1];
    if (row.pixels && previous?.pixels && previous.key === row.key) {
      previous.count = (previous.count ?? 1) + 1;
      previous.bytes = (previous.bytes ?? previous.event.written) + row.event.written;
      previous.text = previous.text.replace(/  pixels.*$/, `  pixels, ${previous.bytes / 2} px in ${previous.count} writes`);
    } else {
      busRows.push(row);
    }
  }
  busSequence = latest;
  if (busRows.length > BUS_MAX_ROWS) busRows.splice(0, busRows.length - BUS_MAX_ROWS);
  busChanged = true;
  renderBus();
}

// The pane scrolls; it follows new rows unless the reader scrolled up.
function renderBus(follow = false) {
  const pane = busLog.parentElement;
  if (!busChanged || pane.hidden) return;
  busChanged = false;
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 4;
  busLog.textContent = busRows.map((row) => row.text).join('\n');
  if (atBottom || follow) pane.scrollTop = pane.scrollHeight;
}

/* ---------- Files ---------- */

let currentDir = FS_ROOT;
let selectedPath = '';

function joinPath(directory, name) {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

function parentPath(path) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

// Path inside the browser store for an absolute path under FS_ROOT, else ''.
function storePath(path) {
  return path.startsWith(`${FS_ROOT}/`) ? path.slice(FS_ROOT.length + 1) : '';
}

function isWasmPath(path) {
  return path.toLowerCase().endsWith('.wasm');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${fuelNumberFormat.format(bytes / 1024)} KB`;
  return `${fuelNumberFormat.format(bytes / (1024 * 1024))} MB`;
}

// Entries of an absolute directory as the kernel VFS sees it: folders first.
function listDirectory(directory) {
  const entries = [];
  const namePointer = runtime._malloc(FS_NAME_BUFFER_SIZE);
  if (!namePointer) throw new Error('Unable to allocate a file name buffer');

  try {
    for (let index = 0; ; index += 1) {
      const type = callRuntime(
        'browser_fs_list',
        'number',
        ['string', 'number', 'number', 'number'],
        [directory, index, namePointer, FS_NAME_BUFFER_SIZE]
      );
      if (type < 0) {
        if (-type === OS_STATUS_END_OF_DIRECTORY) break;
        throw new Error(`Cannot list ${directory} (status ${-type})`);
      }
      const name = runtime.UTF8ToString(namePointer);
      const path = joinPath(directory, name);
      const size = type === FS_TYPE_FILE
        ? callRuntime('browser_fs_file_size', 'number', ['string'], [path])
        : 0;
      entries.push({ name, path, type, size });
    }
  } finally {
    runtime._free(namePointer);
  }

  return entries.sort((a, b) => (b.type - a.type) || a.name.localeCompare(b.name));
}

function writeStoreFile(path, bytes) {
  const relative = storePath(path);
  if (!relative) throw new Error(`Files can only be added under ${FS_ROOT}`);

  const pointer = runtime._malloc(Math.max(1, bytes.length));
  if (!pointer) throw new Error('Unable to allocate memory for the file');
  try {
    runtime.HEAPU8.set(bytes, pointer);
    const status = callRuntime('browser_fs_write', 'number', ['string', 'number', 'number'], [relative, pointer, bytes.length]);
    if (status !== OS_STATUS_OK) throw new Error(runtimeError());
  } finally {
    runtime._free(pointer);
  }
}

function runProgram(path) {
  if (!runtime) {
    appendLog(`Cannot start ${path}: runtime is still loading`);
    return;
  }

  const task = {
    localId: crypto.randomUUID(),
    id: 'pending',
    app: baseName(path),
    path,
    status: 'Ready',
    priority: 5,
    osTaskId: 0,
    runCount: 0,
    lastRunAt: 0,
    activityUntil: 0,
    output: [],
    outputVersion: 0,
    traceColor: TRACE_COLORS[nextTraceColor++ % TRACE_COLORS.length]
  };

  try {
    createOsTask(task);
  } catch (error) {
    task.status = 'Failed';
    task.id = 'not-created';
    appendLog(`${path}: ${error.message}`);
  }
  tasks.push(task);
  selectedTaskId = task.localId;
  renderTasks();
}

function selectEntry(path) {
  selectedPath = path;
  renderExplorer();
}

function openDirectory(path) {
  currentDir = path;
  selectedPath = '';
  renderExplorer();
}

function activateEntry(entry) {
  if (entry.type === FS_TYPE_DIRECTORY) openDirectory(entry.path);
  else if (isWasmPath(entry.path)) runProgram(entry.path);
  else appendLog(`${entry.path}: only .wasm files can be run`);
}

function renderPath() {
  const fragment = document.createDocumentFragment();
  const parts = currentDir.split('/').filter(Boolean);
  const crumb = (label, path) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'files-crumb';
    button.textContent = label;
    button.dataset.path = path;
    if (path === currentDir) {
      button.classList.add('is-current');
      button.setAttribute('aria-current', 'location');
    }
    return button;
  };

  fragment.appendChild(crumb('/', '/'));
  parts.forEach((part, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'files-crumb-separator';
      separator.textContent = '/';
      fragment.appendChild(separator);
    }
    fragment.appendChild(crumb(part, `/${parts.slice(0, index + 1).join('/')}`));
  });
  filesPath.replaceChildren(fragment);
  filesPath.title = currentDir;
}

function createFileRow(entry) {
  const row = document.createElement('button');
  const icon = document.createElement('span');
  const name = document.createElement('span');
  const meta = document.createElement('span');
  const isDirectory = entry.type === FS_TYPE_DIRECTORY;

  row.type = 'button';
  row.className = 'files-item';
  row.dataset.path = entry.path;
  row.title = isDirectory
    ? `${entry.path} · double-click to open`
    : `${entry.path}${isWasmPath(entry.path) ? ' · double-click to run' : ''}`;
  if (entry.path === selectedPath) {
    row.classList.add('is-selected');
    row.setAttribute('aria-pressed', 'true');
  }

  icon.className = 'files-item-icon';
  if (isDirectory) {
    icon.classList.add('is-folder');
    icon.textContent = 'DIR';
  } else if (isWasmPath(entry.path)) {
    icon.classList.add('is-wasm');
    icon.textContent = 'WASM';
  } else {
    const extension = entry.name.includes('.') ? entry.name.split('.').pop() : '';
    icon.textContent = (extension || 'FILE').slice(0, 4).toUpperCase();
  }

  name.className = 'files-item-name';
  name.textContent = entry.name;
  meta.className = 'files-item-meta';
  meta.textContent = isDirectory ? '' : formatSize(entry.size);

  row.append(icon, name, meta);
  return row;
}

let explorerEntries = [];

function renderExplorer() {
  renderPath();
  filesUp.disabled = currentDir === '/';

  if (!runtime) {
    explorerEntries = [];
    const message = document.createElement('p');
    message.className = 'files-empty';
    message.textContent = runtimeFailed ? 'The runtime failed to start.' : 'Loading the runtime…';
    filesList.replaceChildren(message);
    filesRun.disabled = true;
    filesDelete.disabled = true;
    return;
  }

  try {
    explorerEntries = listDirectory(currentDir);
  } catch (error) {
    // The folder disappeared (its last file was deleted): fall back to the root.
    if (currentDir !== FS_ROOT) {
      openDirectory(FS_ROOT);
      return;
    }
    explorerEntries = [];
    appendLog(error.message);
  }

  if (!explorerEntries.some((entry) => entry.path === selectedPath)) selectedPath = '';

  if (!explorerEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'files-empty';
    empty.textContent = 'Empty folder. Drop .wasm files or folders anywhere to add them here.';
    filesList.replaceChildren(empty);
  } else {
    filesList.replaceChildren(...explorerEntries.map(createFileRow));
  }

  const selected = explorerEntries.find((entry) => entry.path === selectedPath);
  filesRun.disabled = !selected || selected.type !== FS_TYPE_FILE || !isWasmPath(selected.path);
  filesDelete.disabled = !selected || !storePath(selected.path);
}

function deleteSelected() {
  const selected = explorerEntries.find((entry) => entry.path === selectedPath);
  if (!selected || !storePath(selected.path)) return;
  if (selected.type === FS_TYPE_DIRECTORY && !window.confirm(`Delete ${selected.path} and everything in it?`)) return;

  const relative = storePath(selected.path);
  const status = callRuntime('browser_fs_remove', 'number', ['string'], [relative]);
  if (status !== OS_STATUS_OK) {
    appendLog(`${selected.path}: ${runtimeError()}`);
  } else {
    appendLog(`Deleted ${selected.path}`);
    forgetPath(relative).catch((error) => appendLog(`${selected.path}: still saved: ${error.message}`));
  }
  selectedPath = '';
  renderExplorer();
}

filesList.addEventListener('click', (event) => {
  const row = event.target.closest('.files-item');
  if (row) selectEntry(row.dataset.path);
});

filesList.addEventListener('dblclick', (event) => {
  const row = event.target.closest('.files-item');
  const entry = row && explorerEntries.find((item) => item.path === row.dataset.path);
  if (entry) activateEntry(entry);
});

filesList.addEventListener('keydown', (event) => {
  const row = event.target.closest('.files-item');
  const entry = row && explorerEntries.find((item) => item.path === row.dataset.path);
  if (!entry) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    activateEntry(entry);
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    selectedPath = entry.path;
    deleteSelected();
  }
});

filesPath.addEventListener('click', (event) => {
  const crumb = event.target.closest('.files-crumb');
  if (crumb && crumb.dataset.path !== currentDir) openDirectory(crumb.dataset.path);
});

filesUp.addEventListener('click', () => openDirectory(parentPath(currentDir)));
filesRun.addEventListener('click', () => {
  if (selectedPath) runProgram(selectedPath);
});
filesDelete.addEventListener('click', deleteSelected);
filesAdd.addEventListener('click', () => filesInput.click());
filesAddFolder.addEventListener('click', () => folderInput.click());

/* ---------- Saved files ---------- */

// The store lives in wasm memory; IndexedDB keeps a copy so /sd survives
// reloads. Without IndexedDB (private windows, blocked storage) files stay
// in memory only.
const FILE_DB_NAME = 'wasm-rtos-files';
const FILE_DB_STORE = 'files';
let fileDbPromise = null;
let fileStorageAvailable = true;

function openFileDb() {
  if (!fileDbPromise) {
    fileDbPromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(FILE_DB_NAME, 1);
      } catch (error) {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore(FILE_DB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return fileDbPromise;
}

// Runs fill(store) in one transaction; resolves to its result, or rejects.
async function withFileStore(mode, fill) {
  const db = await openFileDb();
  if (!db) throw new Error('browser storage is unavailable');
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_DB_STORE, mode);
    const result = fill(transaction.objectStore(FILE_DB_STORE));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('storage transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('storage transaction aborted'));
  });
}

function saveFile(relative, bytes) {
  if (!fileStorageAvailable) return Promise.resolve();
  return withFileStore('readwrite', (store) => {
    store.put({ data: bytes, savedAt: Date.now() }, relative);
  });
}

// Forget a file, or a folder with everything below it.
function forgetPath(relative) {
  if (!fileStorageAvailable) return Promise.resolve();
  return withFileStore('readwrite', (store) => {
    store.delete(relative);
    store.delete(IDBKeyRange.bound(`${relative}/`, `${relative}/￿`));
  });
}

async function loadSavedFiles() {
  const records = {};
  await withFileStore('readonly', (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      records[cursor.key] = cursor.value;
      cursor.continue();
    };
  });
  return Object.entries(records)
    .map(([relative, value]) => ({ relative, data: value.data, savedAt: value.savedAt || 0 }))
    .sort((a, b) => a.savedAt - b.savedAt);
}

// Put saved files back into the store after the runtime starts.
async function restoreSavedFiles() {
  let saved;
  try {
    saved = await loadSavedFiles();
  } catch (error) {
    fileStorageAvailable = false;
    filesFootnote.innerHTML = 'Mounted at <code>/sd</code>, like an SD card. Browser storage is unavailable: files stay until the page is closed.';
    appendLog(`Files are not saved: ${error.message}`);
    return;
  }

  let restored = 0;
  for (const record of saved) {
    try {
      writeStoreFile(`${FS_ROOT}/${record.relative}`, new Uint8Array(record.data));
      restored += 1;
    } catch (error) {
      appendLog(`${FS_ROOT}/${record.relative}: not restored: ${error.message}`);
    }
  }
  if (restored) appendLog(`Restored ${restored} saved ${restored === 1 ? 'file' : 'files'} into ${FS_ROOT}`);
}

// Example programs appear under /sd/examples on every start; they are not saved with the user's files.
const EXAMPLES = ['watchface.wasm', 'i2cscan.wasm', 'thermodial.wasm'];

async function addExamples() {
  for (const name of EXAMPLES) {
    try {
      const response = await fetch(`examples/${name}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeStoreFile(`${FS_ROOT}/examples/${name}`, new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      appendLog(`examples/${name}: not added: ${error.message}`);
    }
  }
  renderExplorer();
}

/* ---------- Loading programs ---------- */

function openPicker() {
  fileInput.click();
}

// Where imported files land: the open folder when it is in the store.
function importDirectory() {
  return currentDir === FS_ROOT || storePath(currentDir) ? currentDir : FS_ROOT;
}

function fromFileList(fileList) {
  return Array.from(fileList).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name
  }));
}

function readEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function collectEntry(entry, prefix, output) {
  if (entry.isFile) {
    output.push({ file: await readEntryFile(entry), relativePath: `${prefix}${entry.name}` });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries returns the children in batches until an empty one.
    for (let batch = await readDirectoryBatch(reader); batch.length; batch = await readDirectoryBatch(reader)) {
      for (const child of batch) await collectEntry(child, `${prefix}${entry.name}/`, output);
    }
  }
}

/*
 * Copy files into the store under the open folder, keeping folder structure.
 * With run, every imported .wasm starts; otherwise only a single dropped one.
 */
async function importFiles(items, { run, runSingleWasm = false }) {
  if (!items.length) return;
  if (!runtime) {
    appendLog('Cannot add files: runtime is still loading');
    return;
  }

  const directory = importDirectory();
  const written = [];
  for (const item of items) {
    const path = joinPath(directory, item.relativePath);
    try {
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      writeStoreFile(path, bytes);
      written.push(path);
      saveFile(storePath(path), bytes).catch((error) => appendLog(`${path}: not saved: ${error.message}`));
    } catch (error) {
      appendLog(`${path}: ${error.message}`);
    }
  }

  if (written.length) {
    appendLog(written.length === 1 ? `Added ${written[0]}` : `Added ${written.length} files to ${directory}`);
  }
  if (currentDir !== directory) currentDir = directory;
  if (written.length === 1) selectedPath = written[0];
  renderExplorer();

  const programs = written.filter(isWasmPath);
  if (run) programs.forEach(runProgram);
  else if (runSingleWasm && items.length === 1 && !items[0].relativePath.includes('/') && programs.length === 1) {
    runProgram(programs[0]);
  }
}

let pageFileDragDepth = 0;

function dragContainsFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function setPageDropActive(active) {
  if (active) pageDropDetail.textContent = `Into ${importDirectory()} · a single .wasm also runs`;
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
  resetPageFileDrag();

  // Entries must be taken before the handler returns; reading them is async.
  const entries = Array.from(event.dataTransfer.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  const files = Array.from(event.dataTransfer.files);

  (async () => {
    let items;
    if (entries.length) {
      items = [];
      for (const entry of entries) await collectEntry(entry, '', items);
    } else {
      items = fromFileList(files);
    }
    await importFiles(items, { run: false, runSingleWasm: true });
  })().catch((error) => appendLog(`Drop failed: ${error.message}`));
}, true);

document.addEventListener('dragend', resetPageFileDrag, true);

loadButton.addEventListener('click', openPicker);
newTaskButton.addEventListener('click', openPicker);
fileInput.addEventListener('change', () => {
  importFiles(fromFileList(fileInput.files), { run: true });
  fileInput.value = '';
});
filesInput.addEventListener('change', () => {
  importFiles(fromFileList(filesInput.files), { run: false });
  filesInput.value = '';
});
folderInput.addEventListener('change', () => {
  importFiles(fromFileList(folderInput.files), { run: false });
  folderInput.value = '';
});

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

/*
 * Simulated devices, as data: the pins, displays and input devices the
 * kernel lends to programs, under the names programs open them by, and the
 * parts drawn on the board. A program asks for "main" and gets whatever
 * display the device has, and learns its size and shape from the kernel.
 */
const GPIO_CAN_ALL = 0x3f;
const PIXEL_MONO1 = 1;
const PIXEL_RGB565 = 2;
const PIXEL_XRGB8888 = 3;
const INPUT_BUTTONS = 1;
const INPUT_ROTARY = 2;
const INPUT_TOUCH = 3;
const TOUCH_UP = 0;
const TOUCH_DOWN = 1;
const TOUCH_MOVE = 2;
// Linux input event codes.
const KEY_BACK = 158;
const KEY_SELECT = 0x161;
const REL_DIAL = 7;
const PROFILE_STORAGE_KEY = 'wasm-rtos.device';

const DEVICE_PROFILES = {
  devboard: {
    name: 'Dev board',
    pins: [
      ...Array.from({ length: 8 }, (_, pin) => ({ name: `gpio${pin}`, pin, capabilities: GPIO_CAN_ALL })),
      { name: 'button-a', pin: 0, capabilities: GPIO_CAN_ALL },
      { name: 'led', pin: 2, capabilities: GPIO_CAN_ALL },
      { name: 'lcd-dc', pin: 4, capabilities: GPIO_CAN_ALL },
      { name: 'lcd-cs', pin: 5, capabilities: GPIO_CAN_ALL }
    ],
    buses: [
      { kind: 'i2c', name: 'i2c0', number: 0, hz: 400000 },
      { kind: 'spi', name: 'spi0', number: 0, hz: 40000000 }
    ],
    // Chips on the buses, simulated byte by byte like the real parts.
    chips: [
      { type: 'lm75', name: 'LM75', bus: 0, address: 0x48, celsius: 22.5 },
      { type: 'gc9a01', name: 'GC9A01', bus: 0, cs: 5, dc: 4, width: 240, height: 240 }
    ],
    displays: [
      { name: 'main', number: 0, width: 128, height: 64, round: false, format: PIXEL_MONO1, formats: [PIXEL_MONO1],
        dpi: 140, lit: 0x9fd7ff }
    ],
    inputs: [],
    parts: [
      { id: 'led', type: 'led', pin: 2, title: 'LED', x: -400, y: -110 },
      { id: 'button', type: 'button', pin: 0, title: 'BUTTON', x: -400, y: 30 },
      { id: 'ssd1306', type: 'oled', display: 0, x: 200, y: -90 },
      { id: 'lm75', type: 'lm75', chip: 0, x: 200, y: 150 },
      { id: 'gc9a01', type: 'gc9a01', chip: 1, x: 560, y: -150 }
    ]
  },
  watch: {
    name: 'Watch',
    pins: [],
    buses: [],
    chips: [],
    displays: [
      { name: 'main', number: 0, width: 240, height: 240, round: true, format: PIXEL_RGB565,
        formats: [PIXEL_RGB565, PIXEL_XRGB8888], dpi: 260 }
    ],
    inputs: [
      { name: 'bezel', number: 0, kind: INPUT_ROTARY, stepsPerTurn: 24 },
      { name: 'buttons', number: 1, kind: INPUT_BUTTONS, longPressMs: 600 },
      { name: 'touch', number: 2, kind: INPUT_TOUCH, display: 0 }
    ],
    parts: [
      { id: 'watch', type: 'watch', display: 0, bezel: 0, buttons: 1, touch: 2, x: 200, y: -190,
        keys: [{ code: KEY_SELECT, label: 'Select', title: 'KEY_SELECT, the crown' }, { code: KEY_BACK, label: 'Back', title: 'KEY_BACK' }] }
    ]
  }
};

function loadProfileId() {
  try {
    const id = localStorage.getItem(PROFILE_STORAGE_KEY);
    return id in DEVICE_PROFILES ? id : 'devboard';
  } catch (error) {
    return 'devboard';
  }
}

const deviceProfileId = loadProfileId();
const DEVICE_PROFILE = DEVICE_PROFILES[deviceProfileId];
const partView = { leds: [], displays: [], panels: [] };

function applyDeviceProfile() {
  DEVICE_PROFILE.pins.forEach(({ name, pin, capabilities, options = 0 }) => {
    const status = callRuntime('browser_gpio_add_pin', 'number', ['string', 'number', 'number', 'number'],
      [name, pin, capabilities, options]);
    if (status !== OS_STATUS_OK) throw new Error(`pin ${name}: ${runtimeError()}`);
  });
  DEVICE_PROFILE.displays.forEach((display) => {
    const formats = display.formats.reduce((mask, format) => mask | (1 << format), 0);
    const status = callRuntime('browser_display_add', 'number',
      ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [display.name, display.number, display.width, display.height, display.round ? 1 : 0, display.format, formats,
        display.dpi, 255, display.lit ?? 0xffffff]);
    if (status !== OS_STATUS_OK) throw new Error(`display ${display.name}: ${runtimeError()}`);
  });
  DEVICE_PROFILE.buses.forEach((bus) => {
    const status = callRuntime(`browser_${bus.kind}_add_bus`, 'number', ['string', 'number', 'number'], [bus.name, bus.number, bus.hz]);
    if (status !== OS_STATUS_OK) throw new Error(`bus ${bus.name}: ${runtimeError()}`);
  });
  DEVICE_PROFILE.chips.forEach((chip) => {
    chip.runtimeId = chip.type === 'lm75'
      ? callRuntime('browser_chip_add_lm75', 'number', ['number', 'number', 'number'], [chip.bus, chip.address, Math.round(chip.celsius * 1000)])
      : callRuntime('browser_chip_add_gc9a01', 'number', ['number', 'number', 'number', 'number', 'number'],
        [chip.bus, chip.cs, chip.dc, chip.width, chip.height]);
    if (chip.runtimeId < 0) throw new Error(`chip ${chip.name}: no room`);
  });
  DEVICE_PROFILE.inputs.forEach((input) => {
    const covered = input.kind === INPUT_TOUCH ? DEVICE_PROFILE.displays[input.display] : null;
    const status = callRuntime('browser_input_add', 'number',
      ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [input.name, input.number, input.kind, covered?.width ?? 0, covered?.height ?? 0, input.stepsPerTurn ?? 0,
        input.longPressMs ?? 0, input.repeatDelayMs ?? 0, input.repeatIntervalMs ?? 0]);
    if (status !== OS_STATUS_OK) throw new Error(`input ${input.name}: ${runtimeError()}`);
  });
}

// Picking another device restarts the simulator with it, like booting other hardware.
function renderDevicePicker() {
  deviceSelect.replaceChildren(...Object.entries(DEVICE_PROFILES).map(([id, profile]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = profile.name;
    option.selected = id === deviceProfileId;
    return option;
  }));
}

deviceSelect.addEventListener('change', () => {
  const running = tasks.some((task) => !['Completed', 'Failed', 'Stopped'].includes(task.status));
  if (running && !window.confirm(`Switch to ${DEVICE_PROFILES[deviceSelect.value].name}? Running programs stop.`)) {
    deviceSelect.value = deviceProfileId;
    return;
  }
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, deviceSelect.value);
  } catch (error) {
    appendLog('The device choice cannot be saved in this browser');
    deviceSelect.value = deviceProfileId;
    return;
  }
  window.location.reload();
});

// The names a program may open a pin by.
function pinNames(pin) {
  return DEVICE_PROFILE.pins.filter((entry) => entry.pin === pin).map((entry) => entry.name);
}

function createPartNode(part, build) {
  const pinLabel = `GPIO${part.pin}`;
  Board.addNode({
    id: part.id,
    x: part.x,
    y: part.y,
    width: 120,
    height: 110,
    pins: { right: [pinLabel], bottom: ['GND'] },
    render(chip) {
      const name = document.createElement('div');
      const meta = document.createElement('div');
      name.className = 'chip-subtitle part-title';
      name.textContent = part.title;
      meta.className = 'chip-subtitle';
      meta.textContent = pinLabel;
      chip.append(build(), name, meta);
    }
  });
}

function createLed(part) {
  const led = document.createElement('span');
  led.className = 'part-led';
  partView.leds.push({ element: led, pin: part.pin });
  return led;
}

function createButton(part) {
  const button = document.createElement('button');
  const press = (down) => (event) => {
    event.stopPropagation();
    button.classList.toggle('is-pressed', down);
    if (runtime) callRuntime('browser_gpio_ground', null, ['number', 'number'], [part.pin, down ? 1 : 0]);
  };
  button.type = 'button';
  button.className = 'part-button';
  button.title = `Hold to connect GPIO${part.pin} to ground`;
  button.setAttribute('aria-label', `Push button on GPIO${part.pin}`);
  button.addEventListener('pointerdown', press(true));
  button.addEventListener('pointerup', press(false));
  button.addEventListener('pointerleave', (event) => { if (button.classList.contains('is-pressed')) press(false)(event); });
  button.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); press(true)(event); }
  });
  button.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); press(false)(event); }
  });
  return button;
}

// A canvas at the display's own resolution; the runtime paints its framebuffer into it.
function createScreen(display, className) {
  const canvas = document.createElement('canvas');
  canvas.width = display.width;
  canvas.height = display.height;
  canvas.className = className;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Display "${display.name}", ${display.width}×${display.height}`);
  partView.displays.push({ canvas, context: canvas.getContext('2d'), display });
  return canvas;
}

function createOled(part) {
  const display = DEVICE_PROFILE.displays[part.display];
  Board.addNode({
    id: part.id,
    x: part.x,
    y: part.y,
    width: display.width * 2 + 40,
    height: display.height * 2 + 70,
    pins: { left: ['SDA', 'SCL'], bottom: ['3V3', 'GND'] },
    render(chip) {
      const name = document.createElement('div');
      const meta = document.createElement('div');
      name.className = 'chip-subtitle part-title';
      name.textContent = 'OLED';
      meta.className = 'chip-subtitle';
      meta.textContent = `"${display.name}" · ${display.width}×${display.height} · 1-bit`;
      chip.append(createScreen(display, 'part-screen part-screen-oled'), name, meta);
    }
  });
}

/*
 * A watch: the round display, a bezel around it (scroll over it, or drag it
 * around), side buttons, and touch on the glass.
 */
function createWatch(part) {
  const display = DEVICE_PROFILE.displays[part.display];
  const bezelInput = DEVICE_PROFILE.inputs[part.bezel];
  const size = display.width + 80;
  Board.addNode({
    id: part.id,
    x: part.x,
    y: part.y,
    width: size + 100,
    height: size + 60,
    render(chip) {
      const body = document.createElement('div');
      const bezel = document.createElement('div');
      const screen = createScreen(display, 'part-screen part-screen-round');
      const buttons = document.createElement('div');
      const meta = document.createElement('div');

      chip.classList.add('watch-chip');
      body.className = 'watch-body';
      body.style.width = `${size}px`;
      body.style.height = `${size}px`;
      bezel.className = 'watch-bezel';
      bezel.title = `Bezel "${bezelInput.name}": scroll or drag around · ${bezelInput.stepsPerTurn} steps a turn`;
      bezel.style.setProperty('--ticks', bezelInput.stepsPerTurn);
      buttons.className = 'watch-buttons';
      meta.className = 'chip-subtitle';
      meta.textContent = `"${display.name}" round ${display.width}×${display.height} · "bezel" · "buttons" · "touch"`;

      part.keys.forEach((key) => buttons.appendChild(createWatchKey(part, key)));
      bindBezel(bezel, part.bezel, bezelInput.stepsPerTurn);
      bindTouch(screen, part.touch, display);
      body.append(bezel, screen);
      chip.append(body, buttons, meta);
    }
  });
}

function inputCall(name, argumentsList) {
  if (runtime) callRuntime(name, 'number', argumentsList.map(() => 'number'), argumentsList);
}

function createWatchKey(part, key) {
  const button = document.createElement('button');
  const press = (down) => (event) => {
    event.stopPropagation();
    if (down === button.classList.contains('is-pressed')) return;
    button.classList.toggle('is-pressed', down);
    inputCall('browser_input_key', [part.buttons, key.code, down ? 1 : 0]);
  };
  button.type = 'button';
  button.className = 'watch-key';
  button.textContent = key.label;
  button.title = `${key.title} on "buttons"; hold for a long press`;
  button.addEventListener('pointerdown', press(true));
  button.addEventListener('pointerup', press(false));
  button.addEventListener('pointerleave', press(false));
  button.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); press(true)(event); }
  });
  button.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); press(false)(event); }
  });
  return button;
}

function bindBezel(bezel, device, stepsPerTurn) {
  let angle = 0;
  let wheelRest = 0;
  let drag = null;
  const turn = (steps) => {
    if (!steps) return;
    angle += steps * 360 / stepsPerTurn;
    bezel.style.transform = `rotate(${angle}deg)`;
    inputCall('browser_input_rotate', [device, REL_DIAL, steps]);
  };
  const pointerAngle = (event) => {
    const rect = bezel.getBoundingClientRect();
    return Math.atan2(event.clientY - rect.top - rect.height / 2, event.clientX - rect.left - rect.width / 2) * 180 / Math.PI;
  };

  // One wheel notch is one detent, scrolling down turns clockwise.
  bezel.addEventListener('wheel', (event) => {
    event.preventDefault();
    event.stopPropagation();
    wheelRest += event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
    const steps = Math.trunc(wheelRest / 50);
    wheelRest -= steps * 50;
    turn(steps);
  }, { passive: false });
  bezel.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    bezel.setPointerCapture(event.pointerId);
    drag = { last: pointerAngle(event), rest: 0 };
  });
  bezel.addEventListener('pointermove', (event) => {
    if (!drag) return;
    let delta = pointerAngle(event) - drag.last;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    drag.last += delta;
    drag.rest += delta;
    const steps = Math.trunc(drag.rest / (360 / stepsPerTurn));
    drag.rest -= steps * 360 / stepsPerTurn;
    turn(steps);
  });
  const end = () => { drag = null; };
  bezel.addEventListener('pointerup', end);
  bezel.addEventListener('pointercancel', end);
}

// Touch in display pixels; outside the round glass nothing is touched.
function bindTouch(screen, device, display) {
  let down = false;
  const point = (event) => {
    const rect = screen.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / rect.width * display.width);
    const y = Math.floor((event.clientY - rect.top) / rect.height * display.height);
    return [Math.min(display.width - 1, Math.max(0, x)), Math.min(display.height - 1, Math.max(0, y))];
  };
  const onGlass = ([x, y]) => !display.round ||
    (x - display.width / 2) ** 2 / (display.width / 2) ** 2 + (y - display.height / 2) ** 2 / (display.height / 2) ** 2 <= 1;

  screen.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !onGlass(point(event))) return;
    event.stopPropagation();
    screen.setPointerCapture(event.pointerId);
    down = true;
    inputCall('browser_input_touch', [device, 0, TOUCH_DOWN, ...point(event)]);
  });
  screen.addEventListener('pointermove', (event) => {
    if (down) inputCall('browser_input_touch', [device, 0, TOUCH_MOVE, ...point(event)]);
  });
  const end = (event) => {
    if (!down) return;
    down = false;
    inputCall('browser_input_touch', [device, 0, TOUCH_UP, ...point(event)]);
  };
  screen.addEventListener('pointerup', end);
  screen.addEventListener('pointercancel', end);
}

// A temperature sensor on I2C; the slider is the room it sits in.
function createLm75(part) {
  const chip = DEVICE_PROFILE.chips[part.chip];
  const bus = DEVICE_PROFILE.buses.find((entry) => entry.kind === 'i2c' && entry.number === chip.bus);
  Board.addNode({
    id: part.id,
    x: part.x,
    y: part.y,
    width: 200,
    height: 120,
    pins: { left: ['SDA', 'SCL'], bottom: ['3V3', 'GND'] },
    render(element) {
      const name = document.createElement('div');
      const meta = document.createElement('div');
      const row = document.createElement('label');
      const slider = document.createElement('input');
      const value = document.createElement('output');
      name.className = 'chip-subtitle part-title';
      name.textContent = chip.name;
      meta.className = 'chip-subtitle';
      meta.textContent = `"${bus.name}" at 0x${chip.address.toString(16)}`;
      row.className = 'part-slider';
      slider.type = 'range';
      slider.min = '-40';
      slider.max = '125';
      slider.step = '0.5';
      slider.value = String(chip.celsius);
      slider.setAttribute('aria-label', `${chip.name} temperature`);
      value.textContent = `${chip.celsius.toFixed(1)} °C`;
      slider.addEventListener('pointerdown', (event) => event.stopPropagation());
      slider.addEventListener('input', () => {
        chip.celsius = Number(slider.value);
        value.textContent = `${chip.celsius.toFixed(1)} °C`;
        if (runtime) callRuntime('browser_chip_set_temperature', null, ['number', 'number'], [chip.runtimeId, Math.round(chip.celsius * 1000)]);
      });
      row.append(slider, value);
      element.append(name, meta, row);
    }
  });
}

// A bare round TFT on SPI: it shows what its controller's memory holds once a driver switched it on.
function createGc9a01(part) {
  const chip = DEVICE_PROFILE.chips[part.chip];
  const bus = DEVICE_PROFILE.buses.find((entry) => entry.kind === 'spi' && entry.number === chip.bus);
  const canvas = document.createElement('canvas');
  canvas.width = chip.width;
  canvas.height = chip.height;
  canvas.className = 'part-screen part-screen-round part-panel';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${chip.name} panel, ${chip.width}×${chip.height}`);
  partView.panels.push({ canvas, context: canvas.getContext('2d'), chip });
  Board.addNode({
    id: part.id,
    x: part.x,
    y: part.y,
    width: chip.width + 60,
    height: chip.height + 80,
    pins: { left: ['SCK', 'MOSI', 'CS', 'DC'], bottom: ['3V3', 'GND'] },
    render(element) {
      const name = document.createElement('div');
      const meta = document.createElement('div');
      name.className = 'chip-subtitle part-title';
      name.textContent = chip.name;
      meta.className = 'chip-subtitle';
      meta.textContent = `"${bus.name}" · CS GPIO${chip.cs} · DC GPIO${chip.dc}`;
      element.append(canvas, name, meta);
    }
  });
}

function createDeviceParts() {
  const builders = {
    led: (part) => createPartNode(part, () => createLed(part)),
    button: (part) => createPartNode(part, () => createButton(part)),
    oled: createOled,
    watch: createWatch,
    lm75: createLm75,
    gc9a01: createGc9a01
  };
  DEVICE_PROFILE.parts.forEach((part) => builders[part.type](part));
}

// LEDs follow their pins; screens repaint when the runtime drew on them.
function drawDeviceParts() {
  if (runtime) {
    partView.leds.forEach(({ element, pin }) => {
      element.classList.toggle('is-on', callRuntime('browser_gpio_get_level', 'number', ['number'], [pin]) === 1);
    });
    partView.displays.forEach(({ canvas, context, display }) => {
      if (!callRuntime('browser_display_take_dirty', 'number', ['number'], [display.number])) return;
      const pointer = callRuntime('browser_display_framebuffer', 'number', ['number'], [display.number]);
      if (!pointer) return;
      const pixels = new Uint8ClampedArray(runtime.HEAPU8.buffer, pointer, display.width * display.height * 4);
      context.putImageData(new ImageData(pixels, display.width, display.height), 0, 0);
      const brightness = callRuntime('browser_display_get_brightness', 'number', ['number'], [display.number]);
      canvas.style.filter = brightness >= 255 ? '' : `brightness(${(0.1 + 0.9 * brightness / 255).toFixed(2)})`;
    });
    partView.panels.forEach(({ canvas, context, chip }) => {
      canvas.classList.toggle('is-off', !callRuntime('browser_chip_is_showing', 'number', ['number'], [chip.runtimeId]));
      if (!callRuntime('browser_chip_take_dirty', 'number', ['number'], [chip.runtimeId])) return;
      const pointer = callRuntime('browser_chip_framebuffer', 'number', ['number'], [chip.runtimeId]);
      if (!pointer) return;
      const pixels = new Uint8ClampedArray(runtime.HEAPU8.buffer, pointer, chip.width * chip.height * 4);
      context.putImageData(new ImageData(pixels, chip.width, chip.height), 0, 0);
    });
  }
  requestAnimationFrame(drawDeviceParts);
}

function isPlaced(part) {
  return part.id === CPU_NODE_ID || DEVICE_PROFILE.parts.some((entry) => entry.id === part.id);
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
      const placed = isPlaced(part);
      item.disabled = !placed;
      item.dataset.partId = part.id;
      if (part.id === Board.getSelected()) item.classList.add('is-selected');
      icon.className = 'library-item-icon';
      icon.textContent = part.icon;
      text.className = 'library-item-text';
      name.className = 'library-item-name';
      name.textContent = part.name;
      meta.className = 'library-item-meta';
      meta.textContent = part.meta;
      tag.className = placed ? 'library-item-tag is-placed' : 'library-item-tag';
      tag.textContent = placed ? 'on board' : 'planned';

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

// Files / Parts tabs
const libraryTabs = [...document.querySelectorAll('.panel-tabs .tab')];
libraryTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    libraryTabs.forEach((other) => {
      const active = other === tab;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
      document.querySelector(`#${other.getAttribute('aria-controls')}`).hidden = !active;
    });
    if (tab.id === 'filesTab') renderExplorer();
  });
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
    if (tab.id === 'busTab') { busChanged = true; renderBus(true); }
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
      const previous = task.status;
      task.status = stateToStatus(task.osTaskId);
      task.swapped = callRuntime('browser_task_is_swapped', 'number', ['number'], [task.osTaskId]) === 1;
      if (['Completed', 'Failed', 'Stopped'].includes(task.status) && previous !== task.status) {
        flushProgramOutput(task.osTaskId);
      }
      if (task.status === 'Failed' && previous !== 'Failed') {
        appendLog(`${task.id} failed: ${readTaskString('browser_task_get_error', task.osTaskId) || runtimeError()}`);
      }
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
  appendLog('Loading wasm-rtos browser runtime');
  try {
    if (typeof createWasmRtosModule !== 'function') {
      throw new Error('os/wasm-rtos.js was not found');
    }
    runtime = await createWasmRtosModule({
      locateFile: (path) => path.endsWith('.wasm') ? 'os/wasm-rtos.wasm' : `os/${path}`,
      onProgramOutput,
      print: (message) => appendLog(message),
      printErr: (message) => appendLog(`ERROR: ${message}`)
    });
    const status = callRuntime('browser_runtime_init', 'number', [], []);
    if (status !== OS_STATUS_OK) throw new Error(runtimeError());
    applyDeviceProfile();
    fuelPerSlice = callRuntime('browser_runtime_get_fuel_per_slice', 'number') || fuelPerSlice;
    setFuelRate(fuelRatePerMs);
    initializeTraceTelemetry();
    runtimeStartedAt = performance.now();
    runtimeStatus.textContent = 'Running';
    runtimeStatusDetail.textContent = 'wasm-rtos is ready';
    appendLog(`wasm-rtos initialized · ${DEVICE_PROFILE.name} · files mounted at ${FS_ROOT}`);
    await restoreSavedFiles();
    await addExamples();
  } catch (error) {
    runtime = null;
    runtimeFailed = true;
    runtimeStatus.textContent = 'Failed';
    runtimeStatusDetail.textContent = error.message;
    appendLog(`Runtime initialization failed: ${error.message}`);
  }
  renderRunState();
  renderTasks();
  renderExplorer();
}

createCpuNode();
renderDevicePicker();
createDeviceParts();
if (!Board.hasSavedView()) Board.fit();
Board.select(CPU_NODE_ID);
renderLibrary();
renderExplorer();
syncPanelsToViewport();

setInterval(refreshRuntimeState, 250);
setInterval(pollBus, 200);
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
