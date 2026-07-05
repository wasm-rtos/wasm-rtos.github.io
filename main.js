(function () {
  'use strict';

  var STORAGE_KEY = 'wasmRtosWindowLayout';
  var GRID_SIZE = 16;
  var DESKTOP_QUERY = '(min-width: 921px)';
  var DEFAULT_LAYOUT = {
    launcher: { width: 514, height: 360, minWidth: 320, minHeight: 260 },
    console: { width: 514, height: 380, minWidth: 360, minHeight: 260 },
    preview: { width: 646, height: 760, minWidth: 320, minHeight: 240 },
    tasks: { width: 1180, height: 360, minWidth: 560, minHeight: 320 }
  };
  var windows = [];
  var previewCanvas;
  var previewResizeObserver;
  var workspace;
  var desktopMedia;

  document.addEventListener('DOMContentLoaded', function () {
    workspace = document.querySelector('.dashboard');
    windows = Array.prototype.slice.call(document.querySelectorAll('.window[data-window-id]'));
    desktopMedia = window.matchMedia(DESKTOP_QUERY);
    initWindows();
    applySavedSizes();
    initPreviewCanvas();
    window.addEventListener('resize', handleViewportResize);
    if (desktopMedia.addEventListener) {
      desktopMedia.addEventListener('change', applySavedSizes);
    } else if (desktopMedia.addListener) {
      desktopMedia.addListener(applySavedSizes);
    }
  });

  function initWindows() {
    windows.forEach(function (windowElement) {
      var handle = windowElement.querySelector('.resize-handle');
      if (handle) {
        handle.addEventListener('pointerdown', function (event) {
          if (!isDesktopWorkspace()) return;
          startResize(event, windowElement);
        });
      }
    });
  }

  function applySavedSizes() {
    if (!workspace) return;
    if (!isDesktopWorkspace()) {
      windows.forEach(function (windowElement) {
        windowElement.style.width = '';
        windowElement.style.height = '';
      });
      resizePreviewCanvas();
      return;
    }

    var savedSizes = readSizes();
    windows.forEach(function (windowElement) {
      var id = windowElement.dataset.windowId;
      var fallback = getDefaultState(id);
      var state = savedSizes[id] || fallback;
      applyWindowSize(windowElement, state);
    });
    resizePreviewCanvas();
  }

  function startResize(event, windowElement) {
    if (event.button !== undefined && event.button !== 0) return;
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
      saveSizes();
      resizePreviewCanvas();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    event.preventDefault();
    event.stopPropagation();
  }

  function saveSizes() {
    if (!isDesktopWorkspace()) return;
    var sizes = {};
    windows.forEach(function (windowElement) {
      var state = getWindowState(windowElement);
      sizes[windowElement.dataset.windowId] = {
        width: snap(state.width),
        height: snap(state.height)
      };
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  }

  function readSizes() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
      return {};
    }
  }

  function applyWindowSize(windowElement, state) {
    var minSize = getMinimumSize(windowElement);
    var rect = windowElement.getBoundingClientRect();
    var workspaceRect = workspace.getBoundingClientRect();
    var left = rect.left - workspaceRect.left;
    var top = rect.top - workspaceRect.top;
    var maxWidth = Math.max(minSize.width, workspace.clientWidth - left);
    var maxHeight = Math.max(minSize.height, workspace.clientHeight - top);
    var width = clamp(snap(state.width), minSize.width, maxWidth);
    var height = clamp(snap(state.height), minSize.height, maxHeight);
    windowElement.style.width = width + 'px';
    windowElement.style.height = height + 'px';
  }

  function handleViewportResize() {
    if (isDesktopWorkspace()) {
      windows.forEach(function (windowElement) {
        applyWindowSize(windowElement, getWindowState(windowElement));
      });
    }
    resizePreviewCanvas();
  }

  function getWindowState(windowElement) {
    var rect = windowElement.getBoundingClientRect();
    return {
      width: parseFloat(windowElement.style.width) || rect.width,
      height: parseFloat(windowElement.style.height) || rect.height
    };
  }

  function getDefaultState(id) {
    var state = DEFAULT_LAYOUT[id];
    var scale = Math.min(1, workspace.clientWidth / 1180);
    return {
      width: state.width * scale,
      height: state.height
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
