const tasks = [];
let runtime = null;
let runtimeStartedAt = 0;
let fuelPerSlice = 10000;
let fuelRatePerMs = 2400;
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
const TRACE_HEADER_HEIGHT = 44;
const TRACE_ROW_HEIGHT = 54;
const TRACE_FOOTER_HEIGHT = 10;
const TRACE_MIN_BAR_WIDTH = 2.2;
const TRACE_COLORS = ['#71e7b3', '#8bb8ff', '#d39cff', '#ffbd69', '#ff8585', '#69d2e7'];

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

const taskBody = document.querySelector('#taskBody');
const activeBadge = document.querySelector('#activeBadge');
const activeRatio = document.querySelector('#activeRatio');
const activeProgress = document.querySelector('#activeProgress');
const waitingCount = document.querySelector('#waitingCount');
const waitingProgress = document.querySelector('#waitingProgress');
const timerCount = document.querySelector('#timerCount');
const timerProgress = document.querySelector('#timerProgress');
const consoleLog = document.querySelector('#consoleLog');
const runtimeClock = document.querySelector('#runtimeClock');
const runtimeStatus = document.querySelector('#runtimeStatus');
const runtimeStatusDetail = document.querySelector('#runtimeStatusDetail');
const memoryValue = document.querySelector('#memoryValue');
const memoryProgress = document.querySelector('#memoryProgress');
const cpuValue = document.querySelector('#cpuValue');
const cpuProgress = document.querySelector('#cpuProgress');
const fileInput = document.querySelector('#wasmFile');
const dropZone = document.querySelector('#dropZone');
const launchButton = document.querySelector('#launchButton');
const newTaskButton = document.querySelector('#newTaskButton');
const fuelRateSlider = document.querySelector('#fuelRateSlider');
const fuelRateInput = document.querySelector('#fuelRateInput');
const fuelRateFrequency = document.querySelector('#fuelRateFrequency');
const fuelRatePerMsLabel = document.querySelector('#fuelRatePerMs');
const fuelRateActual = document.querySelector('#fuelRateActual');
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

function clampFuelRate(value) {
  if (!Number.isFinite(value)) return fuelRatePerMs;
  return Math.min(40000, Math.max(0, Math.round(value)));
}

function renderFuelRate() {
  const megaFuelPerSecond = fuelRatePerMs / 1000;
  const fractionDigits = megaFuelPerSecond < 0.1 ? 3 : megaFuelPerSecond < 10 ? 2 : 1;
  fuelRateFrequency.textContent = fuelRatePerMs === 0
    ? 'Paused'
    : `${megaFuelPerSecond.toFixed(fractionDigits)} Mfuel/s`;
  fuelRatePerMsLabel.textContent = `${fuelNumberFormat.format(fuelRatePerMs)} fuel/ms budget`;
}

function setFuelRate(value, updateInput = true) {
  fuelRatePerMs = clampFuelRate(Number(value));
  fuelRateSlider.value = String(fuelRatePerMs);
  if (updateInput) fuelRateInput.value = String(fuelRatePerMs);
  renderFuelRate();

  if (runtime) {
    callRuntime(
      'browser_runtime_set_fuel_per_ms',
      null,
      ['number'],
      [fuelRatePerMs]
    );
    resetFuelTelemetry();
  }
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

  const scheduledSlices = callRuntime(
    'browser_runtime_get_scheduled_slice_count',
    'number'
  ) >>> 0;
  const sliceDelta = (scheduledSlices - previousScheduledSlices) >>> 0;
  const scheduledFuelPerMs = sliceDelta * fuelPerSlice / elapsedMs;

  fuelRateActual.textContent = `${fuelNumberFormat.format(scheduledFuelPerMs)} fuel/ms scheduled`;
  previousScheduledSlices = scheduledSlices;
  previousFuelSampleAt = now;
}

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
      [
        firstSequence,
        requestedCount,
        traceTaskIdsPointer,
        traceStartsPointer,
        traceDurationsPointer
      ]
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
      ? 'Fuel paused'
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

function canvasRoundedRect(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function resizeSchedulerTimeline() {
  const width = Math.max(1, schedulerTimelineShell.clientWidth);
  const height = Math.max(
    154,
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
    detail.textContent = 'Launch a WASM task to see scheduler activity.';
  } else if (!traceRuntimeSupported) {
    heading.textContent = 'Trace runtime unavailable';
    detail.textContent = 'Refresh after the browser runtime finishes updating.';
  } else if (fuelRatePerMs === 0) {
    heading.textContent = 'Execution is paused';
    detail.textContent = 'Raise fuel above zero to schedule task slices.';
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
  updateTimelineStatus();
  updateTraceWindow();
  if (traceRuntimeSupported) consumeTraceEvents();
  else traceClockMs = runtimeStartedAt ? performance.now() - runtimeStartedAt : 0;

  const { width, height } = resizeSchedulerTimeline();
  const context = schedulerTimelineContext;
  const labelWidth = width < 560 ? 116 : Math.min(220, Math.max(170, width * 0.23));
  const trackLeft = labelWidth;
  const trackRight = Math.max(trackLeft + 1, width - 16);
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
  context.fillStyle = '#151515';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#181818';
  context.fillRect(0, 0, labelWidth, height);

  context.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  context.fillStyle = '#747474';
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillText(width < 560 ? 'TASK / SHARE' : 'TASK / EXECUTION SHARE', 14, 16);
  context.fillText('EXECUTION → NOW', trackLeft + 10, 16);

  context.strokeStyle = 'rgba(255,255,255,.08)';
  context.lineWidth = 1;
  for (let index = 0; index <= 5; index += 1) {
    const x = trackLeft + trackWidth * index / 5;
    context.beginPath();
    context.moveTo(x + 0.5, TRACE_HEADER_HEIGHT);
    context.lineTo(x + 0.5, height);
    context.stroke();

    const secondsAgo = Math.round(traceWindowMs / 1000 * (1 - index / 5));
    context.fillStyle = index === 5 ? '#bfc7c3' : '#676767';
    context.textAlign = index === 0 ? 'left' : index === 5 ? 'right' : 'center';
    context.fillText(index === 5 ? 'NOW' : `−${secondsAgo}s`, x, TRACE_HEADER_HEIGHT - 8);
  }

  tasks.forEach((task, taskIndex) => {
    const rowTop = TRACE_HEADER_HEIGHT + taskIndex * TRACE_ROW_HEIGHT;
    const rowCenter = rowTop + TRACE_ROW_HEIGHT / 2;
    const taskDuration = totals.get(task.localId) || 0;
    const share = totalDuration ? taskDuration / totalDuration * 100 : 0;

    context.fillStyle = taskIndex % 2 ? 'rgba(255,255,255,.012)' : 'rgba(255,255,255,.025)';
    context.fillRect(0, rowTop, width, TRACE_ROW_HEIGHT);
    context.strokeStyle = 'rgba(255,255,255,.07)';
    context.beginPath();
    context.moveTo(0, rowTop + TRACE_ROW_HEIGHT - 0.5);
    context.lineTo(width, rowTop + TRACE_ROW_HEIGHT - 0.5);
    context.stroke();

    context.fillStyle = task.traceColor;
    context.beginPath();
    context.arc(14, rowCenter - 8, 3.5, 0, Math.PI * 2);
    context.fill();

    context.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.fillStyle = '#e5e5e5';
    context.textAlign = 'left';
    context.fillText(
      truncateCanvasText(context, task.app, labelWidth - 34),
      24,
      rowCenter - 8
    );

    context.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    context.fillStyle = '#777';
    const taskDetail = `${task.id} · ${share.toFixed(0)}% · ${formatTraceDuration(taskDuration)}`;
    context.fillText(
      truncateCanvasText(context, taskDetail, labelWidth - 24),
      24,
      rowCenter + 10
    );

    context.strokeStyle = 'rgba(255,255,255,.12)';
    context.beginPath();
    context.moveTo(trackLeft, rowCenter);
    context.lineTo(trackRight, rowCenter);
    context.stroke();
  });

  context.save();
  context.beginPath();
  context.rect(trackLeft, TRACE_HEADER_HEIGHT, trackWidth, height - TRACE_HEADER_HEIGHT);
  context.clip();

  visibleEvents.forEach((traceEvent) => {
    const taskIndex = tasks.findIndex((task) => task.localId === traceEvent.localId);
    if (taskIndex < 0) return;

    const task = tasks[taskIndex];
    const rowTop = TRACE_HEADER_HEIGHT + taskIndex * TRACE_ROW_HEIGHT;
    const eventStart = Math.max(windowStart, traceEvent.startedAtMs);
    const eventEnd = Math.min(
      traceClockMs,
      traceEvent.startedAtMs + Math.max(traceEvent.durationMs, 0.001)
    );
    const x = trackLeft + (eventStart - windowStart) / traceWindowMs * trackWidth;
    const proportionalWidth = (eventEnd - eventStart) / traceWindowMs * trackWidth;
    const barWidth = Math.max(TRACE_MIN_BAR_WIDTH, proportionalWidth);
    const barY = rowTop + 14;
    const barHeight = TRACE_ROW_HEIGHT - 28;

    context.save();
    context.globalAlpha = 0.2;
    context.shadowColor = task.traceColor;
    context.shadowBlur = 10;
    context.fillStyle = task.traceColor;
    canvasRoundedRect(context, x, barY, barWidth, barHeight, 3);
    context.fill();
    context.restore();

    context.fillStyle = task.traceColor;
    canvasRoundedRect(context, x, barY, barWidth, barHeight, 3);
    context.fill();

    traceHitRegions.push({
      x: Math.max(trackLeft, x - 3),
      y: barY - 4,
      width: Math.max(8, barWidth + 6),
      height: barHeight + 8,
      traceEvent,
      task
    });
  });
  context.restore();

  const fade = context.createLinearGradient(trackLeft, 0, trackLeft + 34, 0);
  fade.addColorStop(0, '#151515');
  fade.addColorStop(1, 'rgba(21,21,21,0)');
  context.fillStyle = fade;
  context.fillRect(trackLeft, TRACE_HEADER_HEIGHT, 34, height - TRACE_HEADER_HEIGHT);

  context.strokeStyle = 'rgba(255,255,255,.16)';
  context.beginPath();
  context.moveTo(trackLeft + 0.5, 0);
  context.lineTo(trackLeft + 0.5, height);
  context.stroke();
  context.strokeStyle = '#71e7b3';
  context.beginPath();
  context.moveTo(trackRight + 0.5, TRACE_HEADER_HEIGHT);
  context.lineTo(trackRight + 0.5, height);
  context.stroke();

  updateTimelineEmptyState(visibleEvents.length > 0);
  updateTimelineAccessibility(totals, totalDuration, visibleEvents.length > 0);
  requestAnimationFrame(drawSchedulerTimeline);
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
  age.textContent = formatTraceAge(
    traceClockMs - hit.traceEvent.startedAtMs - hit.traceEvent.durationMs
  );
  schedulerTimelineTooltip.replaceChildren(title, duration, document.createElement('br'), age);
  schedulerTimelineTooltip.hidden = false;

  const tooltipWidth = schedulerTimelineTooltip.offsetWidth;
  const tooltipHeight = schedulerTimelineTooltip.offsetHeight;
  const left = Math.min(
    schedulerTimelineShell.clientWidth - tooltipWidth - 8,
    Math.max(8, x + 12)
  );
  const top = Math.min(
    schedulerTimelineShell.clientHeight - tooltipHeight - 8,
    Math.max(8, y - tooltipHeight - 10)
  );
  schedulerTimelineTooltip.style.left = `${left}px`;
  schedulerTimelineTooltip.style.top = `${top}px`;
}

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

function createTextCell(value) {
  const cell = document.createElement('td');
  cell.textContent = value;
  return cell;
}

function createStatusCell(task) {
  const cell = document.createElement('td');
  const status = document.createElement('span');
  const icon = document.createElement('span');

  status.className = 'status';
  icon.className = 'status-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = statusIcons[task.status] || '?';

  status.append(icon, document.createTextNode(task.status));
  cell.appendChild(status);
  return cell;
}

function formatLastRun(lastRunAt, now) {
  if (!lastRunAt) return 'Never';

  const elapsedSeconds = Math.max(0, Math.floor((now - lastRunAt) / 1000));
  if (elapsedSeconds < 1) return 'Just now';
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours}h ago`;
}

function createActivityCell(task, now) {
  const cell = document.createElement('td');
  const activity = document.createElement('span');
  const indicator = document.createElement('span');
  const count = document.createElement('strong');
  const lastRun = document.createElement('small');
  const runLabel = task.runCount === 1 ? 'run' : 'runs';
  const lastRunLabel = formatLastRun(task.lastRunAt, now);

  activity.className = 'task-activity';
  indicator.className = 'task-activity-dot';
  indicator.setAttribute('aria-hidden', 'true');
  count.textContent = `${integerNumberFormat.format(task.runCount)} ${runLabel}`;
  lastRun.textContent = lastRunLabel;
  activity.setAttribute(
    'aria-label',
    `${integerNumberFormat.format(task.runCount)} ${runLabel}. Last run: ${lastRunLabel}`
  );

  activity.append(indicator, count, lastRun);
  cell.appendChild(activity);
  return cell;
}

function canSetTaskPriority(task) {
  return Boolean(task.osTaskId) && !['Completed', 'Failed', 'Stopped'].includes(task.status);
}

function createPriorityCell(task) {
  const cell = document.createElement('td');
  const input = document.createElement('input');

  input.className = 'priority-input';
  input.type = 'number';
  input.min = '0';
  input.max = String(UINT32_MAX);
  input.step = '1';
  input.value = String(task.priority);
  input.dataset.priorityTaskId = task.localId;
  input.disabled = !canSetTaskPriority(task);
  input.setAttribute('aria-label', `Priority for ${task.app}`);

  cell.appendChild(input);
  return cell;
}

function createActionButton(task, action, label, symbol) {
  const button = document.createElement('button');
  button.className = 'icon-button';
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = task.localId;
  button.setAttribute('aria-label', `${label} ${task.app}`);
  button.textContent = symbol;
  return button;
}

function createActionsCell(task) {
  const cell = document.createElement('td');
  const actions = document.createElement('div');
  const canPause = task.osTaskId && ['Running', 'Ready', 'Waiting'].includes(task.status);
  const canResume = task.osTaskId && task.status === 'Paused';
  const canStop = Boolean(task.osTaskId) && !['Completed', 'Failed', 'Stopped'].includes(task.status);

  actions.className = 'actions';

  if (canPause) {
    actions.appendChild(createActionButton(task, 'pause', 'Pause', 'Ⅱ'));
  } else if (canResume) {
    actions.appendChild(createActionButton(task, 'resume', 'Resume', '▶'));
  }

  if (canStop) {
    actions.appendChild(createActionButton(task, 'stop', 'Stop', '■'));
  }

  actions.appendChild(createActionButton(task, 'restart', 'Restart', '↻'));
  actions.appendChild(createActionButton(task, 'remove', 'Remove', '♲'));
  cell.appendChild(actions);
  return cell;
}

function renderTasks() {
  taskBody.replaceChildren();
  const now = performance.now();
  tasks.forEach((task) => {
    const row = document.createElement('tr');
    row.className = 'task-row';
    if (task.activityUntil > now) row.classList.add('is-recently-active');
    row.append(
      createTextCell(task.app),
      createTextCell(task.id),
      createStatusCell(task),
      createActivityCell(task, now),
      createPriorityCell(task),
      createActionsCell(task)
    );
    taskBody.appendChild(row);
  });
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

  const active = ready + waiting;
  activeBadge.textContent = `${tasks.length} ${tasks.length === 1 ? 'Task' : 'Tasks'}`;
  activeRatio.textContent = `${ready} / ${total}`;
  activeProgress.style.width = `${total ? (ready / total) * 100 : 0}%`;
  waitingCount.textContent = waiting;
  waitingProgress.style.width = `${total ? (waiting / total) * 100 : 0}%`;
  timerCount.textContent = timers;
  timerProgress.style.width = `${Math.min(100, timers * 25)}%`;

  const cpu = Math.min(100, active * 12);
  cpuValue.textContent = `${cpu}%`;
  cpuProgress.style.width = `${cpu}%`;

  if (runtime && runtime.HEAPU8) {
    const memoryMb = runtime.HEAPU8.buffer.byteLength / (1024 * 1024);
    memoryValue.textContent = `${memoryMb.toFixed(1)} MB`;
    memoryProgress.style.width = `${Math.min(100, memoryMb / 2)}%`;
  }
}

function findTask(localId) {
  return tasks.find((task) => task.localId === localId);
}

function parsePriority(value) {
  if (value.trim() === '') {
    throw new Error('Priority is required');
  }

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
    const status = callRuntime(
      'browser_task_set_priority',
      'number',
      ['number', 'number'],
      [task.osTaskId, nextPriority]
    );

    if (status !== OS_STATUS_OK) throw new Error(runtimeError());

    task.priority = callRuntime(
      'browser_task_get_priority',
      'number',
      ['number'],
      [task.osTaskId]
    );
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

taskBody.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const task = findTask(button.dataset.id);
  if (task) handleTaskAction(task, button.dataset.action);
});

taskBody.addEventListener('change', (event) => {
  const input = event.target.closest('input[data-priority-task-id]');
  if (!input) return;
  const task = findTask(input.dataset.priorityTaskId);
  if (task) updateTaskPriority(task, input);
});

taskBody.addEventListener('keydown', (event) => {
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

['click', 'keydown'].forEach((type) => {
  dropZone.addEventListener(type, (event) => {
    if (event.type === 'click' || event.key === 'Enter' || event.key === ' ') openPicker();
  });
});
launchButton.addEventListener('click', (event) => { event.stopPropagation(); openPicker(); });
newTaskButton.addEventListener('click', openPicker);
fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.add('is-dragover');
}));
['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragover');
}));
dropZone.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));

function refreshRuntimeState() {
  if (!runtime) return;
  const sampledAt = performance.now();
  tasks.forEach((task) => {
    if (task.osTaskId) {
      task.status = stateToStatus(task.osTaskId);
      task.priority = callRuntime(
        'browser_task_get_priority',
        'number',
        ['number'],
        [task.osTaskId]
      );
      const runCount = callRuntime(
        'browser_task_get_run_count',
        'number',
        ['number'],
        [task.osTaskId]
      ) >>> 0;
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
  runtimeClock.textContent = `${hours}:${minutes}:${remaining}`;
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
    runtimeStatus.textContent = 'Runtime: OK';
    runtimeStatusDetail.textContent = 'wasm-rtos is ready';
    appendLog('wasm-rtos initialized');
  } catch (error) {
    runtimeStatus.textContent = 'Runtime: Failed';
    runtimeStatusDetail.textContent = error.message;
    appendLog(`Runtime initialization failed: ${error.message}`);
  }
  renderTasks();
}

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
initializeRuntime();
requestAnimationFrame(drawSchedulerTimeline);

const canvas = document.querySelector('#previewCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

function drawPreview(now) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#191919';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  for (let x = 0; x < width; x += 42) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y < height; y += 42) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  const radius = 42 + Math.sin(now * 0.001) * 8;
  ctx.strokeStyle = '#ededed';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#f3f3f3';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(runtime ? 'WASM-RTOS: RUNNING' : 'WASM-RTOS: LOADING', 18, height - 24);
  requestAnimationFrame(drawPreview);
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(drawPreview);
