// Infinite board: pannable/zoomable grid with draggable part nodes.
// World coordinates are board units; screen = world * zoom + offset.

const Board = (() => {
  const GRID_MINOR = 20;
  const GRID_MAJOR = 100;
  const SNAP = 10;
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 3;
  const STORAGE_KEY = 'wasm-rtos.board.v1';

  const workspace = document.querySelector('#workspace');
  const gridCanvas = document.querySelector('#gridCanvas');
  const layer = document.querySelector('#boardLayer');
  const zoomLabel = document.querySelector('#zoomReset');
  const gridContext = gridCanvas.getContext('2d');

  const view = { x: 0, y: 0, zoom: 1 };
  const nodes = new Map();
  const listeners = { select: [] };
  let selectedId = null;
  let gridDirty = true;
  let restored = null;

  function emit(type, value) {
    listeners[type].forEach((listener) => listener(value));
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function saveState() {
    try {
      const positions = {};
      nodes.forEach((node) => { positions[node.id] = { x: node.x, y: node.y }; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ view, positions }));
    } catch (error) {
      // Storage may be unavailable (private mode); the board still works.
    }
  }

  function applyView() {
    layer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
    gridDirty = true;
  }

  function drawGrid() {
    if (!gridDirty) return;
    gridDirty = false;

    const width = workspace.clientWidth;
    const height = workspace.clientHeight;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.floor(width * scale));
    const pixelHeight = Math.max(1, Math.floor(height * scale));
    if (gridCanvas.width !== pixelWidth || gridCanvas.height !== pixelHeight) {
      gridCanvas.width = pixelWidth;
      gridCanvas.height = pixelHeight;
    }

    const context = gridContext;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = '#2d2d2d';
    context.fillRect(0, 0, width, height);

    const drawLines = (step, color) => {
      const screenStep = step * view.zoom;
      if (screenStep < 6) return;
      const startX = ((view.x % screenStep) + screenStep) % screenStep;
      const startY = ((view.y % screenStep) + screenStep) % screenStep;
      context.beginPath();
      for (let x = startX; x < width; x += screenStep) {
        const px = Math.round(x) + 0.5;
        context.moveTo(px, 0);
        context.lineTo(px, height);
      }
      for (let y = startY; y < height; y += screenStep) {
        const py = Math.round(y) + 0.5;
        context.moveTo(0, py);
        context.lineTo(width, py);
      }
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.stroke();
    };

    drawLines(GRID_MINOR, '#333333');
    drawLines(GRID_MAJOR, '#3d3d3d');

    // Board origin
    context.strokeStyle = '#474747';
    context.beginPath();
    context.moveTo(Math.round(view.x) + 0.5, 0);
    context.lineTo(Math.round(view.x) + 0.5, height);
    context.moveTo(0, Math.round(view.y) + 0.5);
    context.lineTo(width, Math.round(view.y) + 0.5);
    context.stroke();
  }

  function frame() {
    drawGrid();
    requestAnimationFrame(frame);
  }

  function clampZoom(zoom) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  }

  function zoomAt(screenX, screenY, nextZoom) {
    const zoom = clampZoom(nextZoom);
    const worldX = (screenX - view.x) / view.zoom;
    const worldY = (screenY - view.y) / view.zoom;
    view.zoom = zoom;
    view.x = screenX - worldX * zoom;
    view.y = screenY - worldY * zoom;
    applyView();
    saveState();
  }

  function zoomCenter(factor) {
    zoomAt(workspace.clientWidth / 2, workspace.clientHeight / 2, view.zoom * factor);
  }

  function fit() {
    if (!nodes.size) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    nodes.forEach((node) => {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    });
    const padding = 140;
    const width = workspace.clientWidth;
    const height = workspace.clientHeight;
    const zoom = clampZoom(Math.min(
      1.25,
      width / (maxX - minX + padding * 2),
      height / (maxY - minY + padding * 2)
    ));
    view.zoom = zoom;
    view.x = width / 2 - (minX + maxX) / 2 * zoom;
    view.y = height / 2 - (minY + maxY) / 2 * zoom;
    applyView();
    saveState();
  }

  function select(id) {
    if (selectedId === id) return;
    if (selectedId && nodes.has(selectedId)) nodes.get(selectedId).element.classList.remove('is-selected');
    selectedId = id && nodes.has(id) ? id : null;
    if (selectedId) nodes.get(selectedId).element.classList.add('is-selected');
    emit('select', selectedId);
  }

  function positionNode(node) {
    node.element.style.left = `${node.x}px`;
    node.element.style.top = `${node.y}px`;
  }

  function addPins(element, pins) {
    Object.entries(pins).forEach(([side, labels]) => {
      labels.forEach((label, index) => {
        const pin = document.createElement('div');
        const text = document.createElement('span');
        const offset = `${((index + 1) / (labels.length + 1)) * 100}%`;
        pin.className = `pin side-${side}`;
        if (side === 'left' || side === 'right') pin.style.top = offset;
        else pin.style.left = offset;
        text.textContent = label;
        pin.appendChild(text);
        element.appendChild(pin);
      });
    });
  }

  // definition: { id, x, y, width, height, pins, render(chipElement) }
  function addNode(definition) {
    const element = document.createElement('div');
    const chip = document.createElement('div');
    const saved = restored?.positions?.[definition.id];
    const node = {
      id: definition.id,
      x: saved ? saved.x : definition.x,
      y: saved ? saved.y : definition.y,
      width: definition.width,
      height: definition.height,
      element
    };

    element.className = 'node';
    element.dataset.nodeId = node.id;
    element.style.width = `${node.width}px`;
    element.style.height = `${node.height}px`;
    chip.className = 'chip';
    element.appendChild(chip);
    if (definition.pins) addPins(element, definition.pins);
    definition.render(chip);

    nodes.set(node.id, node);
    positionNode(node);
    layer.appendChild(element);
    return node;
  }

  // Pointer interaction: drag a chip to move it, drag empty board to pan.
  let gesture = null;

  workspace.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target.closest('.workspace-hud')) return;

    const chip = event.button === 0 ? event.target.closest('.chip') : null;
    const nodeElement = chip?.closest('.node');
    workspace.setPointerCapture(event.pointerId);

    if (nodeElement) {
      const node = nodes.get(nodeElement.dataset.nodeId);
      select(node.id);
      gesture = {
        kind: 'node',
        node,
        startX: event.clientX,
        startY: event.clientY,
        originX: node.x,
        originY: node.y
      };
      nodeElement.classList.add('is-dragging');
    } else {
      gesture = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        originX: view.x,
        originY: view.y,
        moved: false
      };
      workspace.classList.add('is-panning');
    }
  });

  workspace.addEventListener('pointermove', (event) => {
    if (!gesture) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;

    if (gesture.kind === 'node') {
      gesture.node.x = Math.round((gesture.originX + dx / view.zoom) / SNAP) * SNAP;
      gesture.node.y = Math.round((gesture.originY + dy / view.zoom) / SNAP) * SNAP;
      positionNode(gesture.node);
    } else {
      if (Math.abs(dx) + Math.abs(dy) > 3) gesture.moved = true;
      view.x = gesture.originX + dx;
      view.y = gesture.originY + dy;
      applyView();
    }
  });

  function endGesture() {
    if (!gesture) return;
    if (gesture.kind === 'node') {
      gesture.node.element.classList.remove('is-dragging');
    } else {
      workspace.classList.remove('is-panning');
      if (!gesture.moved) select(null);
    }
    gesture = null;
    saveState();
  }

  workspace.addEventListener('pointerup', endGesture);
  workspace.addEventListener('pointercancel', endGesture);

  workspace.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = workspace.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025));
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, view.zoom * factor);
    } else {
      view.x -= event.deltaX;
      view.y -= event.deltaY;
      applyView();
      saveState();
    }
  }, { passive: false });

  document.querySelector('#zoomIn').addEventListener('click', () => zoomCenter(1.25));
  document.querySelector('#zoomOut').addEventListener('click', () => zoomCenter(0.8));
  document.querySelector('#zoomReset').addEventListener('click', () => zoomCenter(1 / view.zoom));
  document.querySelector('#zoomFit').addEventListener('click', fit);

  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') zoomCenter(1.25);
    else if (event.key === '-') zoomCenter(0.8);
    else if (event.key === '0') zoomCenter(1 / view.zoom);
    else if (event.key === 'f' || event.key === 'F') fit();
    else if (event.key === 'Escape') select(null);
    else return;
    event.preventDefault();
  });

  new ResizeObserver(() => { gridDirty = true; }).observe(workspace);

  restored = loadState();
  if (restored?.view && Number.isFinite(restored.view.zoom)) {
    view.x = restored.view.x;
    view.y = restored.view.y;
    view.zoom = clampZoom(restored.view.zoom);
  }
  applyView();
  requestAnimationFrame(frame);

  return {
    addNode,
    select,
    fit,
    hasSavedView: () => Boolean(restored?.view),
    getSelected: () => selectedId,
    on: (type, listener) => listeners[type].push(listener)
  };
})();
