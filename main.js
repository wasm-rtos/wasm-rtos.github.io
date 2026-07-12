const tasks = [];
let runtime = null;
let runtimeStartedAt = 0;

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
const queueCount = document.querySelector('#queueCount');
const queueProgress = document.querySelector('#queueProgress');
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

function timeStamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function appendLog(message) {
  const current = consoleLog.textContent.replace(/\n?> _\s*$/, '');
  consoleLog.textContent = `${current}\n[${timeStamp()}] ${message}\n> _`.trimStart();
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

function runtimeError() {
  if (!runtime) return 'wasm-rtos runtime is not initialized';
  const pointer = runtime.ccall('browser_runtime_get_last_error', 'number', [], []);
  return pointer ? runtime.UTF8ToString(pointer) : 'unknown runtime error';
}

function callRuntime(name, returnType, argumentTypes = [], argumentsList = []) {
  if (!runtime) throw new Error('wasm-rtos runtime is not initialized');
  return runtime.ccall(name, returnType, argumentTypes, argumentsList);
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
  const taskId = callRuntime(
    'browser_task_create',
    'number',
    ['array', 'number', 'string', 'string', 'number', 'number'],
    [task.wasmBytes, task.wasmBytes.length, 'app_main', task.app, 64 * 1024, task.priority]
  );

  if (!taskId) throw new Error(runtimeError());
  task.osTaskId = taskId;
  task.id = `task_${taskId}`;
  task.status = 'Ready';
  appendLog(`Started ${task.app} as ${task.id}`);
}

function actionButtons(task) {
  const canPause = task.osTaskId && ['Running', 'Ready', 'Waiting'].includes(task.status);
  const canResume = task.osTaskId && task.status === 'Paused';
  const canStop = Boolean(task.osTaskId) && !['Completed', 'Failed', 'Stopped'].includes(task.status);
  const pauseResume = canPause
    ? `<button class="icon-button" data-action="pause" data-id="${task.localId}" aria-label="Pause ${task.app}">Ⅱ</button>`
    : canResume
      ? `<button class="icon-button" data-action="resume" data-id="${task.localId}" aria-label="Resume ${task.app}">▶</button>`
      : '';
  const stop = canStop
    ? `<button class="icon-button" data-action="stop" data-id="${task.localId}" aria-label="Stop ${task.app}">■</button>`
    : '';
  const restart = `<button class="icon-button" data-action="restart" data-id="${task.localId}" aria-label="Restart ${task.app}">↻</button>`;
  const remove = `<button class="icon-button" data-action="remove" data-id="${task.localId}" aria-label="Remove ${task.app}">♲</button>`;
  return `${pauseResume}${stop}${restart}${remove}`;
}

function renderTasks() {
  taskBody.innerHTML = '';
  tasks.forEach((task) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${task.app}</td>
      <td>${task.id}</td>
      <td><span class="status"><span class="status-icon" aria-hidden="true">${statusIcons[task.status] || '?'}</span>${task.status}</span></td>
      <td><span class="priority">${task.priority}</span></td>
      <td><div class="actions">${actionButtons(task)}</div></td>
    `;
    taskBody.appendChild(row);
  });
  updateCounters();
}

function updateCounters() {
  const active = tasks.filter((task) => ['Running', 'Ready', 'Waiting'].includes(task.status)).length;
  const queued = tasks.filter((task) => ['Ready', 'Waiting'].includes(task.status)).length;
  activeBadge.textContent = `${tasks.length} ${tasks.length === 1 ? 'Task' : 'Tasks'}`;
  activeRatio.textContent = `${active} / ${tasks.length}`;
  activeProgress.style.width = `${tasks.length ? (active / tasks.length) * 100 : 0}%`;
  queueCount.textContent = queued;
  queueProgress.style.width = `${Math.min(100, queued * 25)}%`;

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

  const task = {
    localId: crypto.randomUUID(),
    id: 'pending',
    app: file.name,
    status: 'Ready',
    priority: 5,
    osTaskId: 0,
    wasmBytes: new Uint8Array(await file.arrayBuffer())
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
  Array.from(files).forEach((file) => addFile(file));
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
  tasks.forEach((task) => {
    if (task.osTaskId) task.status = stateToStatus(task.osTaskId);
  });
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
initializeRuntime();

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
