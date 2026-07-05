(function () {
  'use strict';

  var STORAGE_KEY = 'wasmRtosWindowLayout';
  var windows = [];
  var zIndex = 30;
  var previewCanvas;
  var previewResizeObserver;

  document.addEventListener('DOMContentLoaded', function () {
    windows = Array.prototype.slice.call(document.querySelectorAll('.window[data-window-id]'));
    initWindows();
    restoreLayout();
    initPreviewCanvas();
  });

  function initWindows() {
    windows.forEach(function (windowElement) {
      var header = windowElement.querySelector('.window-header');
      var handle = windowElement.querySelector('.resize-handle');
      if (header) {
        header.addEventListener('pointerdown', function (event) {
          if (event.target.closest('button, a, input, select, textarea')) return;
          startDrag(event, windowElement);
        });
      }
      if (handle) {
        handle.addEventListener('pointerdown', function (event) {
          startResize(event, windowElement);
        });
      }
    });
  }

  function bringToFront(windowElement) {
    zIndex += 1;
    windowElement.style.zIndex = String(zIndex);
    return zIndex;
  }

  function makeFloating(windowElement) {
    if (windowElement.classList.contains('is-floating')) return windowElement.getBoundingClientRect();
    var rect = windowElement.getBoundingClientRect();
    windowElement.classList.add('is-floating');
    windowElement.style.left = rect.left + 'px';
    windowElement.style.top = rect.top + 'px';
    windowElement.style.width = rect.width + 'px';
    windowElement.style.height = rect.height + 'px';
    return rect;
  }

  function startDrag(event, windowElement) {
    if (event.button !== undefined && event.button !== 0) return;
    var rect = makeFloating(windowElement);
    bringToFront(windowElement);
    var offsetX = event.clientX - rect.left;
    var offsetY = event.clientY - rect.top;
    document.body.classList.add('dragging-active');
    if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);

    function onMove(moveEvent) {
      var maxLeft = Math.max(0, window.innerWidth - windowElement.offsetWidth);
      var maxTop = Math.max(0, window.innerHeight - windowElement.offsetHeight);
      windowElement.style.left = clamp(moveEvent.clientX - offsetX, 0, maxLeft) + 'px';
      windowElement.style.top = clamp(moveEvent.clientY - offsetY, 0, maxTop) + 'px';
    }

    function onUp(upEvent) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('dragging-active');
      if (event.currentTarget.releasePointerCapture) {
        try { event.currentTarget.releasePointerCapture(upEvent.pointerId); } catch (ignore) {}
      }
      saveLayout();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    event.preventDefault();
  }

  function startResize(event, windowElement) {
    if (event.button !== undefined && event.button !== 0) return;
    var rect = makeFloating(windowElement);
    bringToFront(windowElement);
    var startX = event.clientX;
    var startY = event.clientY;
    var minWidth = parseFloat(getComputedStyle(windowElement).minWidth) || 280;
    var minHeight = parseFloat(getComputedStyle(windowElement).minHeight) || 220;
    if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);

    function onMove(moveEvent) {
      var maxWidth = window.innerWidth - rect.left;
      var maxHeight = window.innerHeight - rect.top;
      var width = clamp(rect.width + moveEvent.clientX - startX, minWidth, maxWidth);
      var height = clamp(rect.height + moveEvent.clientY - startY, minHeight, maxHeight);
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
    var layout = {};
    windows.forEach(function (windowElement) {
      if (!windowElement.classList.contains('is-floating')) return;
      layout[windowElement.dataset.windowId] = {
        left: parseFloat(windowElement.style.left) || 0,
        top: parseFloat(windowElement.style.top) || 0,
        width: parseFloat(windowElement.style.width) || windowElement.offsetWidth,
        height: parseFloat(windowElement.style.height) || windowElement.offsetHeight,
        zIndex: parseInt(windowElement.style.zIndex, 10) || zIndex
      };
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }

  function restoreLayout() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      var layout = JSON.parse(raw);
      windows.forEach(function (windowElement) {
        var state = layout[windowElement.dataset.windowId];
        if (!state) return;
        windowElement.classList.add('is-floating');
        windowElement.style.left = clamp(state.left, 0, Math.max(0, window.innerWidth - state.width)) + 'px';
        windowElement.style.top = clamp(state.top, 0, Math.max(0, window.innerHeight - state.height)) + 'px';
        windowElement.style.width = clamp(state.width, 280, window.innerWidth) + 'px';
        windowElement.style.height = clamp(state.height, 220, window.innerHeight) + 'px';
        windowElement.style.zIndex = String(state.zIndex || zIndex);
        zIndex = Math.max(zIndex, state.zIndex || zIndex);
      });
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
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
    var stage = previewCanvas.parentElement;
    var rect = stage.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var width = Math.max(320, rect.width);
    var height = Math.max(180, rect.height);
    previewCanvas.width = Math.round(width * dpr);
    previewCanvas.height = Math.round(height * dpr);
    previewCanvas.style.width = width + 'px';
    previewCanvas.style.height = height + 'px';
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
