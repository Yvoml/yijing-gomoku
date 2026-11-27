// The photograph stays intact. Only snow and loose plum petals are animated;
// the accompanying CSS adds a slight movement to the foreground branches.
const canvas = document.querySelector('#weather-canvas');
const button = document.querySelector('#toggle-weather');
const label = document.querySelector('#weather-state');
const context = canvas?.getContext('2d', { alpha: true });

if (canvas && context) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const storageKey = 'gomoku.sceneMotion';
  let storedChoice;
  try { storedChoice = localStorage.getItem(storageKey); } catch { /* Private browsing can disable storage. */ }
  let enabled = !reducedMotion.matches && storedChoice !== 'paused';
  let width = 1, height = 1, pixelRatio = 1;
  let frame = 0, previousTime = 0, elapsed = 0;
  let snow = [], petals = [];
  const random = (min, max) => min + Math.random() * (max - min);
  const tau = Math.PI * 2;
  const palette = ['#842d3e', '#9e3548', '#b54859', '#742b3b', '#bb5361'];

  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });

  // A cached soft sprite gives nearby snow depth without applying a costly
  // per-particle blur filter to the whole canvas on every frame.
  const snowSprite = document.createElement('canvas');
  snowSprite.width = snowSprite.height = 32;
  const spriteContext = snowSprite.getContext('2d');
  if (spriteContext) {
    const gradient = spriteContext.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,.95)');
    gradient.addColorStop(.28, 'rgba(255,255,255,.82)');
    gradient.addColorStop(.65, 'rgba(238,246,249,.27)');
    gradient.addColorStop(1, 'rgba(238,246,249,0)');
    spriteContext.fillStyle = gradient;
    spriteContext.fillRect(0, 0, 32, 32);
  }

  function makeSnow(initial = false) {
    const depth = random(.22, 1);
    const near = Math.random() < .09;
    return {
      x: initial ? random(-30, width + 30) : random(-width * .2, width),
      y: initial ? random(-20, height) : -random(8, 50),
      size: near ? random(3, 4.6) : random(.75, 2.1) * (.65 + depth * .4),
      depth, phase: random(0, tau), speed: random(12, 26) * (.6 + depth),
      opacity: near ? random(.38, .62) : random(.4, .86), near,
    };
  }

  function makePetal(initial = false) {
    return {
      x: initial ? random(-20, width) : random(-width * .15, width * .82),
      y: initial ? random(-30, height) : -random(12, 75),
      size: random(3.3, 8.4), depth: random(.42, 1),
      angle: random(0, tau), spin: random(-.6, .6),
      phase: random(0, tau), speed: random(15, 28),
      opacity: random(.55, .88), color: palette[Math.floor(Math.random() * palette.length)],
      curl: random(.7, 1.2),
    };
  }

  function resize() {
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    pixelRatio = Math.min(1.75, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const small = width <= 680;
    snow = Array.from({ length: small ? 45 : 80 }, () => makeSnow(true));
    petals = Array.from({ length: small ? 12 : 22 }, () => makePetal(true));
    paint();
  }

  function drawSnow(flake) {
    context.globalAlpha = flake.opacity;
    if (flake.near && spriteContext) {
      const size = flake.size * 2.5;
      context.drawImage(snowSprite, flake.x - size, flake.y - size, size * 2, size * 2);
    } else {
      context.fillStyle = '#f8fcff';
      context.beginPath();
      context.ellipse(flake.x, flake.y, flake.size * .65, flake.size, -.35, 0, tau);
      context.fill();
    }
  }

  function drawPetal(petal) {
    context.save();
    context.translate(petal.x, petal.y);
    context.rotate(petal.angle);
    // The varying horizontal scale suggests a petal turning around its fold.
    context.scale(.32 + Math.abs(Math.cos(elapsed * 1.15 + petal.phase)) * .68, petal.curl);
    const s = petal.size;
    context.globalAlpha = petal.opacity;
    context.fillStyle = petal.color;
    context.beginPath();
    context.moveTo(0, s * .8);
    context.bezierCurveTo(-s * .85, s * .32, -s * .76, -s * .56, -s * .19, -s * .68);
    context.bezierCurveTo(s * .1, -s * .92, s * .72, -s * .53, s * .57, -s * .06);
    context.bezierCurveTo(s * .53, s * .34, s * .17, s * .62, 0, s * .8);
    context.fill();
    context.globalAlpha = petal.opacity * .27;
    context.strokeStyle = '#f3abb1';
    context.lineWidth = Math.max(.45, s * .08);
    context.beginPath();
    context.moveTo(-s * .22, -s * .48);
    context.quadraticCurveTo(s * .05, -s * .1, 0, s * .52);
    context.stroke();
    context.restore();
  }

  function paint() {
    context.clearRect(0, 0, width, height);
    // Distant flakes are painted first; plum petals remain crisp in front.
    for (const flake of snow) drawSnow(flake);
    for (const petal of petals) drawPetal(petal);
    context.globalAlpha = 1;
  }

  function tick(timestamp) {
    frame = 0;
    if (!enabled || document.hidden) return;
    const dt = previousTime ? Math.min((timestamp - previousTime) / 1000, .05) : 0;
    previousTime = timestamp;
    elapsed += dt;
    // Slow changing gusts keep snow and petals moving in the same breeze.
    const gust = 16 + Math.sin(elapsed * .28) * 10 + Math.sin(elapsed * .63 + 1.4) * 7;
    for (let i = 0; i < snow.length; i++) {
      const flake = snow[i];
      flake.x += (gust * (.55 + flake.depth) + Math.sin(elapsed * .8 + flake.phase) * 7) * dt;
      flake.y += (flake.speed + Math.cos(elapsed * .55 + flake.phase) * 3) * dt;
      if (flake.y > height + 20 || flake.x > width + 45) snow[i] = makeSnow();
      else if (flake.x < -45) flake.x = width + 35;
    }
    for (let i = 0; i < petals.length; i++) {
      const petal = petals[i];
      petal.x += (gust * (1.05 + petal.depth) + Math.sin(elapsed * 1.1 + petal.phase) * 14) * dt;
      petal.y += (petal.speed + Math.sin(elapsed * .95 + petal.phase) * 11 - Math.max(0, gust - 24) * .7) * dt;
      petal.angle += (petal.spin + Math.sin(elapsed * .7 + petal.phase) * .45) * dt;
      if (petal.y > height + 30 || petal.x > width + 45) petals[i] = makePetal();
      else if (petal.x < -45) petal.x = width + 35;
    }
    paint();
    frame = requestAnimationFrame(tick);
  }

  function syncMotion() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    const moving = enabled && !document.hidden;
    document.documentElement.classList.toggle('motion-paused', !moving);
    canvas.dataset.motion = moving ? 'playing' : 'paused';
    if (button) {
      button.setAttribute('aria-pressed', String(enabled));
      button.setAttribute('aria-label', enabled ? '暂停风雪动态效果' : '开启风雪动态效果');
    }
    if (label) label.textContent = enabled ? '暂停风雪' : '开启风雪';
    if (moving) frame = requestAnimationFrame(tick);
    else paint();
  }

  button?.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem(storageKey, enabled ? 'playing' : 'paused'); } catch { /* Motion still works without persistence. */ }
    syncMotion();
  });
  document.addEventListener('visibilitychange', syncMotion);
  reducedMotion.addEventListener('change', event => {
    // A system request for less motion takes effect immediately. Users may
    // deliberately turn it back on with the visible scene control.
    if (event.matches) enabled = false;
    else {
      let choice;
      try { choice = localStorage.getItem(storageKey); } catch { /* Use the default. */ }
      enabled = choice !== 'paused';
    }
    syncMotion();
  });
  window.addEventListener('resize', resize, { passive: true });
  resize();
  syncMotion();
}
