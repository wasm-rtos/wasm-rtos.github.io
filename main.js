(function () {
  'use strict';

  var STORAGE_KEY = 'wasmRtosWindowLayout';
  var GRID_SIZE = 16;
  var DESKTOP_QUERY = '(min-width: 921px)';
  var DEFAULT_LAYOUT = {
    launcher: { left: 0, top: 0, width: 514, height: 360, minWidth: 320, minHeight: 260 },
    console: { left: 0, top: 380, width: 514, height: 380, minWidth: 360, minHeight: 260 },
    preview: { left: 534, top: 0, width: 646, height: 760, minWidth: 320, minHeight: 240 },
    tasks: { left: 0, top: 780, width: 1180, height: 360, minWidth: 560, minHeight: 320 }
  };
  var windows = [];
  var zIndex = 30;
  var previewCanvas;
  var previewResizeObserver;
  var workspace;
  var desktopMedia;

  document.addEventListener('DOMContentLoaded', function () {
    workspace = document.querySelector('.dashboard');
    windows = Array.prototype.slice.call(document.querySelectorAll('.window[data-window-id]'));
    desktopMedia = window.matchMedia(DESKTOP_QUERY);
    initWindows();
    applyWorkspaceMode();
    initPreviewCanvas();
    window.addEventListener('resize', handleViewportResize);
    if (desktopMedia.addEventListener) {
      desktopMedia.addEventListener('change', applyWorkspaceMode);
    } else if (desktopMedia.addListener) {
      desktopMedia.addListener(applyWorkspaceMode);
    }
  });

  function initWindows() {
    windows.forEach(function (windowElement) {
      var header = windowElement.querySelector('.window-header');
      var handle = windowElement.querySelector('.resize-handle');
      if (header) {
        header.addEventListener('pointerdown', function (event) {
          if (!isDesktopWorkspace()) return;
          if (event.target.closest('button, a, input, select, textarea')) return;
          startDrag(event, windowElement);
        });
      }
      if (handle) {
        handle.addEventListener('pointerdown', function (event) {
          if (!isDesktopWorkspace()) return;
          startResize(event, windowElement);
        });
      }
    });
  }

  function applyWorkspaceMode() {
    if (!workspace) return;
    if (!isDesktopWorkspace()) {
      windows.forEach(function (windowElement) {
        windowElement.classList.remove('is-floating');
        windowElement.style.left = '';
        windowElement.style.top = '';
        windowElement.style.width = '';
        windowElement.style.height = '';
        windowElement.style.zIndex = '';
      });
      workspace.style.height = '';
      resizePreviewCanvas();
      return;
    }

    var savedLayout = readLayout();
    windows.forEach(function (windowElement) {
      var id = windowElement.dataset.windowId;
      var fallback = getDefaultState(id);
      var state = savedLayout[id] || fallback;
      applyWindowState(windowElement, state);
      zIndex = Math.max(zIndex, state.zIndex || zIndex);
    });
    updateWorkspaceHeight();
    resizePreviewCanvas();
  }

  function bringToFront(windowElement) {
    zIndex += 1;
    windowElement.style.zIndex = String(zIndex);
    return zIndex;
  }

  function startDrag(event, windowElement) {
    if (event.button !== undefined && event.button !== 0) return;
    bringToFront(windowElement);
    var workspaceRect = workspace.getBoundingClientRect();
    var rect = windowElement.getBoundingClientRect();
    var startLeft = rect.left - workspaceRect.left;
    var startTop = rect.top - workspaceRect.top;
    var offsetX = event.clientX - rect.left;
    var offsetY = event.clientY - rect.top;
    document.body.classList.add('dragging-active');
    if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);

    function onMove(moveEvent) {
      var maxLeft = Math.max(0, workspace.clientWidth - windowElement.offsetWidth);
      var maxTop = Math.max(0, workspace.clientHeight - windowElement.offsetHeight);
      var left = snap(moveEvent.clientX - workspaceRect.left - offsetX);
      var top = snap(moveEvent.clientY - workspaceRect.top - offsetY);
      windowElement.style.left = clamp(left, 0, maxLeft) + 'px';
      windowElement.style.top = clamp(top, 0, maxTop) + 'px';
    }

    function onUp(upEvent) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('dragging-active');
      if (event.currentTarget.releasePointerCapture) {
        try { event.currentTarget.releasePointerCapture(upEvent.pointerId); } catch (ignore) {}
      }
      windowElement.style.left = clamp(snap(parseFloat(windowElement.style.left) || startLeft), 0, Math.max(0, workspace.clientWidth - windowElement.offsetWidth)) + 'px';
      windowElement.style.top = clamp(snap(parseFloat(windowElement.style.top) || startTop), 0, Math.max(0, workspace.clientHeight - windowElement.offsetHeight)) + 'px';
      saveLayout();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    event.preventDefault();
  }

  function startResize(event, windowElement) {
    if (event.button !== undefined && event.button !== 0) return;
    bringToFront(windowElement);
    var rect = windowElement.getBoundingClientRect();
    var workspaceRect = workspace.getBoundingClientRect();
    var state = getWindowState(windowElement);
    var startX = event.clientX;
    var startY = event.clientY;
    var minSize = getMinimumSize(windowElement);
    var left = rect.left - workspaceRect.left;
    var top = rect.top - workspaceRect.top;
    if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);

    function onMove(moveEvent) {
      var maxWidth = Math.max(minSize.width, workspace.clientWidth - left);
      var maxHeight = Math.max(minSize.height, workspace.clientHeight - top);
      var width = clamp(snap(state.width + moveEvent.clientX - startX), minSize.width, maxWidth);
      var height = clamp(snap(state.height + moveEvent.clientY - startY), minSize.height, maxHeight);
      windowElement.style.width = width + 'px';
      windowElement.style.height = height + 'px';
      if (windowElement.dataset.windowId === 'preview') resizePreviewCanvas();
    }

    function onUp(upEvent) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      if (event.currentTarget.releasePointerCapture) {
        try { event.currentTarget.releasePointerCapture(upEvent.pointerId); } catch (ignore) {}
      }
      saveLayout();
      resizePreviewCanvas();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    event.preventDefault();
    event.stopPropagation();
  }

  function saveLayout() {
    if (!isDesktopWorkspace()) return;
    var layout = {};
    windows.forEach(function (windowElement) {
      var state = getWindowState(windowElement);
      layout[windowElement.dataset.windowId] = {
        left: snap(state.left),
        top: snap(state.top),
        width: snap(state.width),
        height: snap(state.height),
        zIndex: parseInt(windowElement.style.zIndex, 10) || zIndex
      };
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }

  function readLayout() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
      return {};
    }
  }

  function applyWindowState(windowElement, state) {
    var id = windowElement.dataset.windowId;
    var minSize = getMinimumSize(windowElement);
    var width = clamp(snap(state.width), minSize.width, workspace.clientWidth);
    var height = clamp(snap(state.height), minSize.height, workspace.clientHeight);
    var left = clamp(snap(state.left), 0, Math.max(0, workspace.clientWidth - width));
    var top = clamp(snap(state.top), 0, Math.max(0, workspace.clientHeight - height));
    windowElement.classList.add('is-floating');
    windowElement.style.left = left + 'px';
    windowElement.style.top = top + 'px';
    windowElement.style.width = width + 'px';
    windowElement.style.height = height + 'px';
    windowElement.style.zIndex = String(state.zIndex || DEFAULT_LAYOUT[id].zIndex || zIndex);
  }

  function handleViewportResize() {
    if (isDesktopWorkspace()) {
      windows.forEach(function (windowElement) {
        applyWindowState(windowElement, getWindowState(windowElement));
      });
      updateWorkspaceHeight();
    }
    resizePreviewCanvas();
  }

  function updateWorkspaceHeight() {
    workspace.style.height = '1140px';
  }

  function getWindowState(windowElement) {
    var rect = windowElement.getBoundingClientRect();
    var workspaceRect = workspace.getBoundingClientRect();
    return {
      left: parseFloat(windowElement.style.left) || rect.left - workspaceRect.left,
      top: parseFloat(windowElement.style.top) || rect.top - workspaceRect.top,
      width: parseFloat(windowElement.style.width) || rect.width,
      height: parseFloat(windowElement.style.height) || rect.height,
      zIndex: parseInt(windowElement.style.zIndex, 10) || zIndex
    };
  }

  function getDefaultState(id) {
    var state = DEFAULT_LAYOUT[id];
    var scale = Math.min(1, workspace.clientWidth / 1180);
    return {
      left: state.left * scale,
      top: state.top,
      width: state.width * scale,
      height: state.height,
      zIndex: state.zIndex || zIndex
    };
  }

  function getMinimumSize(windowElement) {
    var fallback = DEFAULT_LAYOUT[windowElement.dataset.windowId] || {};
    return {
      width: fallback.minWidth || 280,
      height: fallback.minHeight || 220
    };
  }

  function snap(value) {
    return Math.round(value / GRID_SIZE) * GRID_SIZE;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function isDesktopWorkspace() {
    return desktopMedia ? desktopMedia.matches : window.innerWidth >= 921;
  }

  function initPreviewCanvas() {
    previewCanvas = document.getElementById('preview-canvas');
    if (!previewCanvas) return;
    resizePreviewCanvas();
    if ('ResizeObserver' in window) {
      previewResizeObserver = new ResizeObserver(resizePreviewCanvas);
      previewResizeObserver.observe(previewCanvas.parentElement);
    } else {
      window.addEventListener('resize', resizePreviewCanvas);
    }
  }

  function resizePreviewCanvas() {
    if (!previewCanvas) return;
    var width = previewCanvas.clientWidth;
    var height = previewCanvas.clientHeight;
    if (!width || !height) return;
    var dpr = window.devicePixelRatio || 1;
    var bufferWidth = Math.max(1, Math.round(width * dpr));
    var bufferHeight = Math.max(1, Math.round(height * dpr));
    if (previewCanvas.width !== bufferWidth) previewCanvas.width = bufferWidth;
    if (previewCanvas.height !== bufferHeight) previewCanvas.height = bufferHeight;
    drawPreviewCanvas();
  }

  function drawPreviewCanvas() {
    if (!previewCanvas) return;
    var ctx = previewCanvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var width = previewCanvas.width / dpr;
    var height = previewCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#070809';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    for (var x = 0; x <= width; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (var y = 0; y <= height; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }

    var cx = width * 0.52;
    var cy = height * 0.5;
    var maxR = Math.min(width, height) * 0.38;
    ctx.strokeStyle = 'rgba(230,230,230,0.45)';
    ctx.setLineDash([2, 9]);
    [0.38, 0.62, 0.86, 1].forEach(function (scale) {
      ctx.beginPath(); ctx.arc(cx, cy, maxR * scale, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(245,245,245,0.72)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, maxR * 0.16, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(245,245,245,0.32)';
    ctx.beginPath(); ctx.arc(cx, cy, maxR * 0.23, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#d9d9d9';
    ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();

    var nodes = [[.62,.1,4],[.86,1.65,3],[1,2.82,4.5],[.38,4.1,3],[.75,5.36,3.5]];
    nodes.forEach(function (node) {
      var nx = cx + Math.cos(node[1]) * maxR * node[0];
      var ny = cy + Math.sin(node[1]) * maxR * node[0];
      ctx.fillStyle = '#cfcfcf';
      ctx.beginPath(); ctx.arc(nx, ny, node[2], 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath(); ctx.arc(nx, ny, node[2] + 7, 0, Math.PI * 2); ctx.stroke();
    });

    var sx = cx + Math.cos(-0.48) * maxR * 1.05;
    var sy = cy + Math.sin(-0.48) * maxR * 1.05;
    ctx.save();
    ctx.translate(sx, sy); ctx.rotate(-0.05);
    ctx.strokeStyle = '#f2f2f2'; ctx.fillStyle = 'rgba(240,240,240,0.18)';
    ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(-10, -7); ctx.lineTo(-5, 0); ctx.lineTo(-10, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  window.resetWasmRtosLayout = function () {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  };
}());
