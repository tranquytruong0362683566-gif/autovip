(function () {
  'use strict';

  if (window.__autoVipIncokitUiInitialized) return;
  window.__autoVipIncokitUiInitialized = true;

  const canvas = document.getElementById('magnetic-grid');
  if (!canvas) return;

  const context = canvas.getContext('2d');
  if (!context) return;

  const GRID_SIZE = 40;
  const LINE_COLOR = 'rgba(91, 198, 119, 0.17)';
  const LINE_WIDTH = 1;
  const POINTER_RADIUS = 230;
  const POINTER_STRENGTH = 30;
  const SUBDIVISIONS = 6;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let width = 0;
  let height = 0;
  let dpr = 1;
  let pointerX = -9999;
  let pointerY = -9999;
  let animationFrameId = null;
  let destroyed = false;

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (reducedMotion.matches) drawGrid();
  }

  function getDisplacement(x, y) {
    const deltaX = x - pointerX;
    const deltaY = y - pointerY;
    const distance = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
    if (distance > POINTER_RADIUS || distance < 0.1) return { x: 0, y: 0 };

    const normalized = distance / POINTER_RADIUS;
    const progress = 1 - normalized;
    const eased = progress * progress * (3 - (2 * progress));
    const motionScale = reducedMotion.matches ? 0.45 : 1;
    const magnitude = eased * POINTER_STRENGTH * motionScale;

    return {
      x: (deltaX / distance) * magnitude,
      y: (deltaY / distance) * magnitude
    };
  }

  function drawSmoothLine(points) {
    if (points.length < 2) return;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);

    for (let index = 0; index < points.length - 1; index += 1) {
      const point0 = points[Math.max(index - 1, 0)];
      const point1 = points[index];
      const point2 = points[index + 1];
      const point3 = points[Math.min(index + 2, points.length - 1)];

      context.bezierCurveTo(
        point1.x + ((point2.x - point0.x) / 6),
        point1.y + ((point2.y - point0.y) / 6),
        point2.x - ((point3.x - point1.x) / 6),
        point2.y - ((point3.y - point1.y) / 6),
        point2.x,
        point2.y
      );
    }

    context.stroke();
  }

  function buildLine(horizontal, fixedIndex, count) {
    const points = [];
    const steps = count * SUBDIVISIONS;

    for (let step = 0; step <= steps; step += 1) {
      const variable = -GRID_SIZE + ((step / SUBDIVISIONS) * GRID_SIZE);
      const fixed = -GRID_SIZE + (fixedIndex * GRID_SIZE);
      const sourceX = horizontal ? variable : fixed;
      const sourceY = horizontal ? fixed : variable;
      const displacement = getDisplacement(sourceX, sourceY);

      points.push({
        x: sourceX + displacement.x,
        y: sourceY + displacement.y
      });
    }

    return points;
  }

  function drawGrid() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(dpr, dpr);
    context.strokeStyle = LINE_COLOR;
    context.lineWidth = LINE_WIDTH;

    const columns = Math.ceil(width / GRID_SIZE) + 2;
    const rows = Math.ceil(height / GRID_SIZE) + 2;

    for (let row = 0; row < rows; row += 1) {
      drawSmoothLine(buildLine(true, row, columns));
    }

    for (let column = 0; column < columns; column += 1) {
      drawSmoothLine(buildLine(false, column, rows));
    }

    context.restore();
  }

  function animate() {
    if (destroyed || reducedMotion.matches) {
      animationFrameId = null;
      return;
    }
    drawGrid();
    animationFrameId = window.requestAnimationFrame(animate);
  }

  function ensureAnimationState() {
    if (reducedMotion.matches) {
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
      drawGrid();
      return;
    }
    if (animationFrameId === null && !destroyed) animationFrameId = window.requestAnimationFrame(animate);
  }

  function handlePointerMove(event) {
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (reducedMotion.matches) drawGrid();
  }

  function handlePointerLeave() {
    pointerX = -9999;
    pointerY = -9999;
    if (reducedMotion.matches) drawGrid();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    window.removeEventListener('resize', resizeCanvas);
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerleave', handlePointerLeave);
    reducedMotion.removeEventListener?.('change', ensureAnimationState);
  }

  resizeCanvas();
  ensureAnimationState();
  window.addEventListener('resize', resizeCanvas, { passive: true });
  document.addEventListener('pointermove', handlePointerMove, { passive: true });
  document.addEventListener('pointerleave', handlePointerLeave, { passive: true });
  reducedMotion.addEventListener?.('change', ensureAnimationState);
  window.addEventListener('pagehide', event => {
    if (!event.persisted) destroy();
  }, { once: true });
}());
