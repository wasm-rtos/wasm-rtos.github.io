// A board on the serial cable (docs/decisions.md, 3), through Web Serial: its programs' output in the
// Console, the page's files as the board's files, the page as the board's page store when it has no
// card, and programs started and stopped on it. Every byte on the cable is a packet:
//   0xA5 | type u8 | id u16 | slot u32 | length u16 | payload | crc32 u32
// Loaded after main.js, whose functions it uses.

const BOARD = {
  CONSOLE: 0x01, RESULT: 0x02, TASK_ENDED: 0x03,
  FS_STAT: 0x10, FS_READ: 0x11, FS_LIST: 0x12, PAGE_WRITE: 0x13, PAGE_READ: 0x14,
  PUT_OPEN: 0x20, PUT_DATA: 0x21, PUT_CLOSE: 0x22, RUN: 0x23, KILL: 0x24, LIST: 0x25, PS: 0x26,
  STORES: 0x27, PRIORITY: 0x28,
  HELLO: 0x7F, FS_ANSWER: 0x90
};
const BOARD_BAUD = 921600;
const BOARD_COMMAND_TIMEOUT_MS = 10000;
const BOARD_PUT_PIECE = 512;

const boardLink = {
  port: null,
  writer: null,
  info: null,          // what the board's HELLO says: { board, firmware, card, files, pages, frame }
  pending: new Map(),  // command id -> resolve
  nextId: 1,
  frames: new Map(),   // the board's memory frames by slot, while it has no card
  programs: new Map(), // task id -> { path, status }
  lines: new Map(),    // task id -> the lines it printed, kept for Run on both
  stores: [],          // the board's page stores: { name, priority, slots, used, writes, reads }
  helloTimer: 0,
  storesTimer: 0,
  writing: Promise.resolve()
};

const boardButton = document.querySelector('#boardButton');
const boardSection = document.querySelector('#boardSection');
const boardStatus = document.querySelector('#boardStatus');
const boardPrograms = document.querySelector('#boardPrograms');
const boardStores = document.querySelector('#boardStores');
const filesRunOnBoard = document.querySelector('#filesRunOnBoard');
const filesPutOnCard = document.querySelector('#filesPutOnCard');
const filesRunOnBoth = document.querySelector('#filesRunOnBoth');
const boardCompare = document.querySelector('#boardCompare');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Writes are queued, so packets never interleave on the cable.
function boardSend(type, id, slot, payload = new Uint8Array(0)) {
  const packet = new Uint8Array(14 + payload.length);
  const view = new DataView(packet.buffer);
  packet[0] = 0xA5;
  view.setUint8(1, type);
  view.setUint16(2, id, true);
  view.setUint32(4, slot >>> 0, true);
  view.setUint16(8, payload.length, true);
  packet.set(payload, 10);
  view.setUint32(10 + payload.length, crc32(packet.subarray(1, 10 + payload.length)), true);
  boardLink.writing = boardLink.writing.then(() => boardLink.writer && boardLink.writer.write(packet)).catch(() => {});
  return boardLink.writing;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const le32 = (value) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, value, true); return b; };
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  parts.forEach((p) => { out.set(p, at); at += p.length; });
  return out;
};

// A command and its RESULT: { status, text }.
function boardCommand(type, slot, payload) {
  const id = boardLink.nextId;
  boardLink.nextId = boardLink.nextId === 0xFFFF ? 1 : boardLink.nextId + 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      boardLink.pending.delete(id);
      reject(new Error('the board did not answer'));
    }, BOARD_COMMAND_TIMEOUT_MS);
    boardLink.pending.set(id, (answer) => { clearTimeout(timer); resolve(answer); });
    boardSend(type, id, slot, payload);
  });
}

/* ---------- The board asking for the page's files and frames ---------- */

// A path the board asks for is relative to where it mounted the page's files.
function pagePath(relative) {
  return relative ? `${FS_ROOT}/${relative}` : FS_ROOT;
}

function answerFiles(type, id, payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const answer = (status, data = new Uint8Array(0)) => boardSend(BOARD.FS_ANSWER, id, 0, join(le32(status), data));
  try {
    if (type === BOARD.FS_STAT) {
      const path = pagePath(decoder.decode(payload));
      const size = callRuntime('browser_fs_file_size', 'number', ['string'], [path]);
      if (size >= 0) {
        const data = new Uint8Array(5);
        new DataView(data.buffer).setUint32(1, size, true);
        return answer(0, data);
      }
      listDirectory(path);
      return answer(0, new Uint8Array([1, 0, 0, 0, 0]));
    }
    if (type === BOARD.FS_READ) {
      const offset = view.getUint32(0, true);
      const length = view.getUint32(4, true);
      const relative = decoder.decode(payload.subarray(8));
      const size = callRuntime('browser_fs_file_size', 'number', ['string'], [pagePath(relative)]);
      const pointer = callRuntime('browser_fs_file_data', 'number', ['string'], [relative]);
      if (size < 0 || !pointer) return answer(-1);
      const end = Math.min(size, offset + Math.min(length, 4096));
      return answer(0, runtime.HEAPU8.slice(pointer + Math.min(offset, end), pointer + end));
    }
    if (type === BOARD.FS_LIST) {
      const index = view.getUint32(0, true);
      const entries = listDirectory(pagePath(decoder.decode(payload.subarray(4))));
      if (index >= entries.length) return answer(1);
      const entry = entries[index];
      return answer(0, join(new Uint8Array([entry.type === FS_TYPE_FILE ? 0 : 1]), encoder.encode(entry.name)));
    }
  } catch (error) {
    return answer(-1);
  }
  return answer(-1);
}

function answerFrames(type, id, slot, payload) {
  if (type === BOARD.PAGE_WRITE) {
    boardLink.frames.set(slot, payload.slice());
    return boardSend(BOARD.FS_ANSWER, id, 0, le32(payload.length === 4096 ? 0 : -1));
  }
  const frame = boardLink.frames.get(slot);
  return boardSend(BOARD.FS_ANSWER, id, 0, frame ? join(le32(0), frame) : le32(-1));
}

/* ---------- Packets from the board ---------- */

function boardPacket(type, id, slot, payload) {
  if (type === BOARD.HELLO) {
    const words = Object.fromEntries(decoder.decode(payload).split(' ').slice(1).map((w) => w.split('=')));
    const first = !boardLink.info;
    boardLink.info = words;
    if (first) appendLog(`Board connected: ${words.board}, ${words.firmware}; ` +
      `${words.card === '1' ? 'SD card at /sd, the page\'s files at /pc' : 'no card: the page\'s files are its /sd'}; ` +
      `pages on the ${words.pages}`);
    renderBoard();
  } else if (type === BOARD.CONSOLE) {
    const line = decoder.decode(payload);
    appendLog(`board task_${slot}: ${line}`);
    if (!boardLink.lines.has(slot)) boardLink.lines.set(slot, []);
    boardLink.lines.get(slot).push(line);
  } else if (type === BOARD.RESULT) {
    const resolve = boardLink.pending.get(id);
    boardLink.pending.delete(id);
    if (resolve) resolve({ status: new DataView(payload.buffer, payload.byteOffset).getInt32(0, true), text: decoder.decode(payload.subarray(4)) });
  } else if (type === BOARD.TASK_ENDED) {
    const text = decoder.decode(payload.subarray(4));
    appendLog(`board task_${slot} ${text}`);
    const program = boardLink.programs.get(slot);
    if (program) program.status = text.startsWith('failed') ? 'Failed' : 'Completed';
    renderBoard();
  } else if (type === BOARD.FS_STAT || type === BOARD.FS_READ || type === BOARD.FS_LIST) {
    answerFiles(type, id, payload);
  } else if (type === BOARD.PAGE_WRITE || type === BOARD.PAGE_READ) {
    answerFrames(type, id, slot, payload);
  }
}

// Packets out of the byte stream; bytes outside packets (the board's boot text) are skipped.
async function readBoard(readable) {
  const reader = readable.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = join(buffer, value);
      for (;;) {
        const start = buffer.indexOf(0xA5);
        if (start < 0) { buffer = new Uint8Array(0); break; }
        buffer = buffer.subarray(start);
        if (buffer.length < 10) break;
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const length = view.getUint16(8, true);
        if (length > 4160) { buffer = buffer.subarray(1); continue; }
        if (buffer.length < 14 + length) break;
        if (crc32(buffer.subarray(1, 10 + length)) !== view.getUint32(10 + length, true)) { buffer = buffer.subarray(1); continue; }
        boardPacket(view.getUint8(1), view.getUint16(2, true), view.getUint32(4, true), buffer.slice(10, 10 + length));
        buffer = buffer.subarray(14 + length);
      }
    }
  } catch (error) {
    appendLog(`Board: ${error.message}`);
  } finally {
    reader.releaseLock();
  }
}

/* ---------- Connecting ---------- */

async function connectBoard() {
  if (boardLink.port) return disconnectBoard();
  let port;
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: BOARD_BAUD, bufferSize: 65536 });
    // Release EN and GPIO0, so the board runs its firmware rather than its boot loader.
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } catch (error) {
    if (error.name !== 'NotFoundError') appendLog(`Board: ${error.message}`);
    return;
  }
  boardLink.port = port;
  boardLink.writer = port.writable.getWriter();
  boardLink.frames.clear();
  // The board takes three silent seconds as the cable gone: say HELLO every second.
  boardLink.helloTimer = setInterval(() => boardSend(BOARD.HELLO, 0, 0, encoder.encode('v1 computer=page')), 1000);
  boardLink.storesTimer = setInterval(readBoardStores, 2000);
  boardSend(BOARD.HELLO, 0, 0, encoder.encode('v1 computer=page'));
  renderBoard();
  readBoard(port.readable).then(() => disconnectBoard());
}

async function disconnectBoard() {
  const { port, writer } = boardLink;
  if (!port) return;
  clearInterval(boardLink.helloTimer);
  clearInterval(boardLink.storesTimer);
  boardLink.stores = [];
  boardLink.port = null;
  boardLink.writer = null;
  boardLink.info = null;
  boardLink.pending.forEach((resolve) => resolve({ status: -1, text: 'the board went away' }));
  boardLink.pending.clear();
  try { writer.releaseLock(); } catch (error) { /* already released */ }
  try { await port.close(); } catch (error) { /* already closed */ }
  if (boardLink.frames.size) appendLog(`Board disconnected: the ${boardLink.frames.size} frames it kept here are gone`);
  else appendLog('Board disconnected');
  boardLink.frames.clear();
  renderBoard();
}

/* ---------- Running ---------- */

// A path of the page's files as the board sees it.
function boardPathFor(path) {
  return boardLink.info && boardLink.info.files === '/pc' ? `/pc${path.slice(FS_ROOT.length)}` : path;
}

// Starts a program of the page's files on the board; its task id, or 0.
async function runOnBoard(path) {
  if (!boardLink.info) return 0;
  const boardPath = boardPathFor(path);
  try {
    const { status, text } = await boardCommand(BOARD.RUN, 0, encoder.encode(boardPath));
    if (status) throw new Error(text);
    const id = Number(text);
    boardLink.programs.set(id, { path: boardPath, status: 'Running' });
    boardLink.lines.set(id, []);
    appendLog(`Started ${boardPath} on the board as task_${id}`);
    renderBoard();
    return id;
  } catch (error) {
    appendLog(`Cannot start ${boardPath} on the board: ${error.message}`);
    return 0;
  }
}

/*
 * Run on both (decision 4): the same file in the simulator and on the board at once; when both have
 * ended, their own lines compared, one by one.
 */
async function runOnBoth(path) {
  const pageTask = runProgram(path);
  const boardId = await runOnBoard(path);
  if (!pageTask || !boardId || pageTask.status === 'Failed') {
    showCompare('Run on both: it did not start in both places');
    return;
  }
  showCompare(`Comparing ${baseName(path)}: on the page ${pageTask.id}, on the board task_${boardId}…`);
  const ended = (status) => ['Completed', 'Failed', 'Stopped'].includes(status);
  const timer = setInterval(() => {
    const board = boardLink.programs.get(boardId);
    if (!boardLink.port) {
      clearInterval(timer);
      showCompare('Run on both: the board went away before the program ended');
      return;
    }
    if (!ended(pageTask.status) || !board || board.status === 'Running') return;
    clearInterval(timer);
    showCompare(compareLines(pageTask.output, boardLink.lines.get(boardId) || []));
  }, 500);
}

function compareLines(page, board) {
  const length = Math.max(page.length, board.length);
  const differ = [];
  for (let i = 0; i < length; i++) {
    if (page[i] !== board[i]) differ.push(`line ${i + 1}: page «${page[i] ?? '—'}», board «${board[i] ?? '—'}»`);
  }
  return differ.length
    ? `Run on both: ${differ.length} of ${length} lines differ. ${differ.join('; ')}`
    : `Run on both: the same output, ${length} lines`;
}

function showCompare(text) {
  boardCompare.hidden = false;
  boardCompare.textContent = text;
  appendLog(text);
}

async function stopOnBoard(id) {
  try {
    const { status, text } = await boardCommand(BOARD.KILL, id, new Uint8Array(0));
    if (status) throw new Error(text);
    boardLink.programs.get(id).status = 'Stopped';
    appendLog(`board task_${id}: stopped`);
  } catch (error) {
    appendLog(`Cannot stop board task_${id}: ${error.message}`);
  }
  renderBoard();
}

// The file copied to the board's card at the same path, to run there without the page later.
async function putOnCard(path) {
  const relative = storePath(path);
  const size = callRuntime('browser_fs_file_size', 'number', ['string'], [path]);
  const pointer = callRuntime('browser_fs_file_data', 'number', ['string'], [relative]);
  if (!boardLink.info || size < 0 || !pointer) return;
  const bytes = runtime.HEAPU8.slice(pointer, pointer + size);
  const started = performance.now();
  try {
    let answer = await boardCommand(BOARD.PUT_OPEN, 0, join(le32(size), encoder.encode(path)));
    if (answer.status) throw new Error(answer.text);
    for (let at = 0; at < size; at += BOARD_PUT_PIECE) {
      answer = await boardCommand(BOARD.PUT_DATA, at, bytes.subarray(at, at + BOARD_PUT_PIECE));
      if (answer.status) throw new Error(answer.text);
    }
    answer = await boardCommand(BOARD.PUT_CLOSE, 0, new Uint8Array(0));
    const want = `${size} ${crc32(bytes).toString(16).padStart(8, '0')}`;
    if (answer.status || answer.text !== want) throw new Error(answer.text);
    appendLog(`Put ${path} on the board's card: ${formatSize(size)} in ${((performance.now() - started) / 1000).toFixed(1)} s, crc32 matches`);
  } catch (error) {
    appendLog(`Cannot put ${path} on the board's card: ${error.message}`);
  }
}

/* ---------- The board's page stores (kernel decision 10) ---------- */

// One line a store: "card priority=2 slots=256 used=0 writes=448 reads=396".
async function readBoardStores() {
  if (!boardLink.info) return;
  try {
    const { status, text } = await boardCommand(BOARD.STORES, 0, new Uint8Array(0));
    if (status) return;
    boardLink.stores = text.split('\n').filter(Boolean).map((line) => {
      const [name, ...fields] = line.split(' ');
      return { name, ...Object.fromEntries(fields.map((f) => f.split('=')).map(([k, v]) => [k, Number(v)])) };
    });
    renderBoardStores();
  } catch (error) {
    // A board that does not answer in time is shown as it was.
  }
}

// The person orders the stores: the higher priority takes the next frame.
async function setBoardPriority(name, priority) {
  try {
    const { status, text } = await boardCommand(BOARD.PRIORITY, 0, encoder.encode(`${name} ${priority}`));
    if (status) throw new Error(text);
    appendLog(`Board: the ${name} store now at priority ${priority}`);
  } catch (error) {
    appendLog(`Board: cannot set the ${name} store's priority: ${error.message}`);
  }
  readBoardStores();
}

function renderBoardStores() {
  const editing = document.activeElement && boardStores.contains(document.activeElement);
  if (editing) return;
  boardStores.replaceChildren(...boardLink.stores.map((store) => {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${store.name}: ${store.used} of ${store.slots} frames · ${store.writes} out, ${store.reads} in`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '99';
    input.value = String(store.priority);
    input.title = `Priority of the ${store.name} store: the higher takes the next frame`;
    input.setAttribute('aria-label', input.title);
    input.addEventListener('change', () => setBoardPriority(store.name, Math.max(0, Math.round(Number(input.value) || 0))));
    row.append(label, input);
    return row;
  }));
}

/* ---------- The board on the page ---------- */

function renderBoard() {
  const connected = Boolean(boardLink.port);
  const info = boardLink.info;
  boardButton.setAttribute('aria-pressed', connected ? 'true' : 'false');
  boardButton.title = connected ? 'Disconnect the board' : 'Connect a board on its serial cable';
  boardSection.hidden = !connected;
  if (connected) {
    boardStatus.textContent = info
      ? `${info.board} · ${info.firmware} · ${info.card === '1' ? 'SD card' : 'no card'} · pages on the ${info.pages}` +
        (boardLink.frames.size ? ` (${boardLink.frames.size} frames here)` : '')
      : 'Waiting for the board to say HELLO';
    boardPrograms.replaceChildren(...[...boardLink.programs].reverse().map(([id, program]) => {
      const row = document.createElement('li');
      row.textContent = `task_${id} ${program.path} · ${program.status}`;
      if (program.status === 'Running') {
        const stop = document.createElement('button');
        stop.className = 'button';
        stop.type = 'button';
        stop.textContent = 'Stop';
        stop.addEventListener('click', () => stopOnBoard(id));
        row.appendChild(stop);
      }
      return row;
    }));
  }
  if (!connected) boardStores.replaceChildren();
  const wasm = typeof selectedPath === 'string' && isWasmPath(selectedPath);
  filesRunOnBoard.hidden = !info;
  filesRunOnBoard.disabled = !wasm;
  filesPutOnCard.hidden = !info || info.card !== '1';
  filesPutOnCard.disabled = !wasm;
  filesRunOnBoth.hidden = !info;
  filesRunOnBoth.disabled = !wasm;
}

if ('serial' in navigator) {
  boardButton.hidden = false;
  boardButton.addEventListener('click', connectBoard);
  filesRunOnBoard.addEventListener('click', () => runOnBoard(selectedPath));
  filesPutOnCard.addEventListener('click', () => putOnCard(selectedPath));
  filesRunOnBoth.addEventListener('click', () => runOnBoth(selectedPath));
  // The Files panel's selection changes the buttons.
  document.querySelector('#filesList').addEventListener('click', () => setTimeout(renderBoard, 0));
}
renderBoard();
