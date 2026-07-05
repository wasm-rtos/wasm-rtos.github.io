const tasks = [
  { app: 'orbit.wasm', id: 'task_7f3a1c', status: 'Running', priority: 9 },
  { app: 'mandelbrot.wasm', id: 'task_9b2d4e', status: 'Paused', priority: 5 },
  { app: 'physics-sim.wasm', id: 'task_a1c9e2', status: 'Completed', priority: 2 },
  { app: 'raytrace.wasm', id: 'task_c3a8f7', status: 'Failed', priority: 8 },
  { app: 'boids.wasm', id: 'task_c445a1', status: 'Queued', priority: 4 },
  { app: 'sierpinski.wasm', id: 'task_e7f6b2', status: 'Running', priority: 6 }
];

const statusIcons = { Running: '▶', Paused: 'Ⅱ', Completed: '✓', Failed: '×', Queued: '◷' };
const taskBody = document.querySelector('#taskBody');
const activeBadge = document.querySelector('#activeBadge');
const activeRatio = document.querySelector('#activeRatio');
const activeProgress = document.querySelector('#activeProgress');
const queueCount = document.querySelector('#queueCount');
const queueProgress = document.querySelector('#queueProgress');
const consoleLog = document.querySelector('#consoleLog');
const runtimeClock = document.querySelector('#runtimeClock');
const fileInput = document.querySelector('#wasmFile');
const dropZone = document.querySelector('#dropZone');
const launchButton = document.querySelector('#launchButton');
const newTaskButton = document.querySelector('#newTaskButton');

const initialLogs = [
  '[01:24:31] Runtime v1.4.2 initialized',
  '[01:24:31] Wasm runtime ready',
  '[01:24:31] Loading module: orbit.wasm (2.1 MB)',
  '[01:24:31] Validating module... OK',
  '[01:24:31] Instantiating... OK',
  '[01:24:33] Starting task: task_7f3a1c',
  '[01:24:32] [orbit] init: memory=256MB, threads=4',
  '[01:24:33] [orbit] loading data assets.... OK',
  '[01:24:33] [orbit] simulation started',
  '[01:24:35] [orbit] tick=1200 fps=60.1',
  '[01:24:37] [orbit] tick=2400 fps=60.0',
  '[01:24:37] Task task_7f3a1c: RUNNING',
  '[01:24:37] All systems nominal.',
  '> _'
];

function timeStamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function appendLog(message) {
  const prompt = '> _';
  const current = consoleLog.textContent.replace(/\n?> _\s*$/, '');
  consoleLog.textContent = `${current}\n[${timeStamp()}] ${message}\n${prompt}`.trimStart();
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

function renderTasks() {
  taskBody.innerHTML = '';
  tasks.forEach((task) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${task.app}</td>
      <td>${task.id}</td>
      <td><span class="status"><span class="status-icon" aria-hidden="true">${statusIcons[task.status]}</span>${task.status}</span></td>
      <td><span class="priority">${task.priority}</span></td>
      <td><div class="actions">${actionButtons(task)}</div></td>
    `;
    taskBody.appendChild(row);
  });
  updateCounters();
}

function actionButtons(task) {
  const playPause = task.status === 'Running'
    ? `<button class="icon-button" data-action="pause" data-id="${task.id}" aria-label="Pause ${task.app}">Ⅱ</button>`
    : `<button class="icon-button" data-action="play" data-id="${task.id}" aria-label="Play ${task.app}">▶</button>`;
  const stop = task.status !== 'Completed' && task.status !== 'Failed'
    ? `<button class="icon-button" data-action="stop" data-id="${task.id}" aria-label="Stop ${task.app}">■</button>` : '';
  const restart = `<button class="icon-button" data-action="restart" data-id="${task.id}" aria-label="Restart ${task.app}">↻</button>`;
  const remove = task.status !== 'Running'
    ? `<button class="icon-button" data-action="delete" data-id="${task.id}" aria-label="Delete ${task.app}">♲</button>` : '';
  return `${playPause}${stop}${restart}${remove}`;
}

function updateCounters() {
  const active = tasks.filter((task) => task.status === 'Running').length;
  const queued = tasks.filter((task) => task.status === 'Queued').length;
  activeBadge.textContent = `${tasks.length} Active`;
  activeRatio.textContent = `${active} / ${tasks.length}`;
  activeProgress.style.width = `${tasks.length ? (active / tasks.length) * 100 : 0}%`;
  queueCount.textContent = queued;
  queueProgress.style.width = `${Math.min(100, queued * 34)}%`;
}

function findTask(id) {
  return tasks.find((task) => task.id === id);
}

taskBody.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const task = findTask(button.dataset.id);
  if (!task) return;
  const action = button.dataset.action;
  if (action === 'play' || action === 'pause') task.status = task.status === 'Running' ? 'Paused' : 'Running';
  if (action === 'stop') task.status = 'Completed';
  if (action === 'restart') task.status = 'Running';
  if (action === 'delete') tasks.splice(tasks.indexOf(task), 1);
  appendLog(`${task.id}: ${action.toUpperCase()} ${action === 'delete' ? 'removed' : `=> ${task.status.toUpperCase()}`}`);
  renderTasks();
});

function openPicker() {
  fileInput.click();
}

function makeTaskId() {
  return `task_${Math.random().toString(16).slice(2, 8)}`;
}

function addFile(file) {
  if (!file.name.toLowerCase().endsWith('.wasm')) {
    appendLog(`Rejected ${file.name}: .wasm files only`);
    return;
  }
  const task = { app: file.name, id: makeTaskId(), status: 'Queued', priority: Math.ceil(Math.random() * 9) };
  tasks.push(task);
  appendLog(`Queued module: ${task.app} as ${task.id}`);
  renderTasks();
}

function handleFiles(files) {
  Array.from(files).forEach(addFile);
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

let runtimeSeconds = 5077;
setInterval(() => {
  runtimeSeconds += 1;
  const hours = String(Math.floor(runtimeSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((runtimeSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(runtimeSeconds % 60).padStart(2, '0');
  runtimeClock.textContent = `${hours}:${minutes}:${seconds}`;
}, 1000);

consoleLog.textContent = initialLogs.join('\n');
renderTasks();

const canvas = document.querySelector('#previewCanvas');
const ctx = canvas.getContext('2d');
const bodies = [
  { r: 86, speed: 0.0011, size: 5, offset: 0.2 },
  { r: 130, speed: 0.0008, size: 8, offset: 2.4 },
  { r: 168, speed: 0.00055, size: 10, offset: 4.8 },
  { r: 188, speed: 0.00042, size: 11, offset: 1.1 }
];

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
  const cx = width * 0.48;
  const cy = height * 0.49;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#191919';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,.055)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 42) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y < height; y += 42) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }

  ctx.strokeStyle = 'rgba(235,235,235,.62)';
  ctx.setLineDash([2, 5]);
  [86, 130, 168].forEach((radius) => { ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke(); });
  ctx.setLineDash([3, 6]);
  ctx.beginPath(); ctx.moveTo(cx - 155, cy); ctx.lineTo(cx + 180, cy); ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = '#f0f0f0';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, 48, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 54, 0, Math.PI * 2); ctx.stroke();

  bodies.forEach((body) => {
    const angle = now * body.speed + body.offset;
    const x = cx + Math.cos(angle) * body.r;
    const y = cy + Math.sin(angle) * body.r;
    ctx.beginPath(); ctx.arc(x, y, body.size, 0, Math.PI * 2);
    ctx.fillStyle = '#202020'; ctx.fill();
    ctx.strokeStyle = '#eeeeee'; ctx.lineWidth = 1.5; ctx.stroke();
  });

  ctx.fillStyle = 'rgba(15,15,15,.78)';
  ctx.fillRect(10, height - 82, 126, 70);
  ctx.fillStyle = '#f3f3f3';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ['FPS:        60', 'OBJECTS:    1.2k', 'TICKS/SEC: 1.456', 'MEM:      22.1 MB'].forEach((line, index) => {
    ctx.fillText(line, 18, height - 61 + index * 16);
  });

  ctx.strokeStyle = '#ededed';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(width - 30, height - 28); ctx.lineTo(width - 12, height - 28); ctx.moveTo(width - 21, height - 37); ctx.lineTo(width - 21, height - 19); ctx.stroke();
  requestAnimationFrame(drawPreview);
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(drawPreview);
