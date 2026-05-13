// Particle field — mimics the in-app dots
(function() {
  const canvas = document.getElementById('particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const colors = [
    'rgba(63, 229, 194, 0.55)',  // mint
    'rgba(255, 122, 77, 0.45)',  // orange
    'rgba(245, 200, 74, 0.40)',  // yellow
    'rgba(43, 184, 156, 0.35)',  // mint dim
  ];
  let particles = [];
  let w = 0, h = 0, raf;

  function resize() {
    w = canvas.width = window.innerWidth * window.devicePixelRatio;
    h = canvas.height = Math.max(document.body.scrollHeight, window.innerHeight) * window.devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = Math.max(document.body.scrollHeight, window.innerHeight) + 'px';
    init();
  }

  function init() {
    const density = Math.min(180, Math.floor((window.innerWidth * window.innerHeight) / 9000));
    particles = [];
    for (let i = 0; i < density; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: (Math.random() * 2.5 + 0.6) * window.devicePixelRatio,
        c: colors[(Math.random() * colors.length) | 0],
        vx: (Math.random() - 0.5) * 0.15 * window.devicePixelRatio,
        vy: (Math.random() - 0.5) * 0.15 * window.devicePixelRatio,
        a: Math.random() * Math.PI * 2,
        as: (Math.random() * 0.02 + 0.005),
      });
    }
  }

  function tick() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.a += p.as;
      if (p.x < 0) p.x = w; else if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h; else if (p.y > h) p.y = 0;
      const flicker = 0.7 + Math.sin(p.a) * 0.3;
      ctx.globalAlpha = flicker;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(tick);
  }

  let resizeTO;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTO);
    resizeTO = setTimeout(resize, 150);
  });
  // Re-measure once images settle
  window.addEventListener('load', resize);
  resize();
  tick();
})();

// Scroll reveal
(function() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach(el => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  els.forEach(el => io.observe(el));
})();

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (id.length > 1) {
      const t = document.querySelector(id);
      if (t) {
        e.preventDefault();
        window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' });
      }
    }
  });
});
