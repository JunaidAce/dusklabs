import { useEffect } from 'react';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isTouchPrimaryDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: none), (pointer: coarse)').matches;
}

export function MouseEffects() {
  useEffect(() => {
    const root = document.documentElement;
    const reduced = prefersReducedMotion();
    const touchOnly = isTouchPrimaryDevice();

    let rafId = 0;
    let running = false;
    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let currentX = targetX;
    let currentY = targetY;

    const setVars = (x: number, y: number) => {
      root.style.setProperty('--px', `${x.toFixed(2)}`);
      root.style.setProperty('--py', `${y.toFixed(2)}`);
      const nx = window.innerWidth ? x / window.innerWidth : 0.5;
      const ny = window.innerHeight ? y / window.innerHeight : 0.5;
      root.style.setProperty('--pnx', nx.toFixed(4));
      root.style.setProperty('--pny', ny.toFixed(4));
    };

    const stopLoopIfSettled = () => {
      if (Math.abs(targetX - currentX) < 0.1 && Math.abs(targetY - currentY) < 0.1) {
        currentX = targetX;
        currentY = targetY;
        setVars(currentX, currentY);
        running = false;
        rafId = 0;
        return true;
      }
      return false;
    };

    const tick = () => {
      if (!running) return;
      currentX += (targetX - currentX) * 0.18;
      currentY += (targetY - currentY) * 0.18;
      setVars(currentX, currentY);
      if (stopLoopIfSettled()) return;
      rafId = window.requestAnimationFrame(tick);
    };

    const ensureLoop = () => {
      if (running) return;
      running = true;
      rafId = window.requestAnimationFrame(tick);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      targetX = e.clientX;
      targetY = e.clientY;
      ensureLoop();
    };

    const onPointerLeave = () => {
      targetX = window.innerWidth / 2;
      targetY = window.innerHeight / 2;
      ensureLoop();
    };

    // Smoothed cursor position also powers the hero Sharingan's pointer-follow.
    root.style.setProperty('--px', `${currentX.toFixed(2)}`);
    root.style.setProperty('--py', `${currentY.toFixed(2)}`);
    root.style.setProperty('--pnx', '0.5');
    root.style.setProperty('--pny', '0.5');

    if (!reduced && !touchOnly) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      document.addEventListener('mouseleave', onPointerLeave, { passive: true });
      setVars(currentX, currentY);
    }

    const burstColors = [
      'rgba(210, 31, 43, 0.95)',
      'rgba(255, 77, 90, 0.95)',
      'rgba(255, 122, 24, 0.92)',
      'rgba(247, 241, 232, 0.85)',
    ];

    const onClickBurst = (e: MouseEvent) => {
      if (reduced) return;
      const x = e.clientX;
      const y = e.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      const count = 8;
      for (let i = 0; i < count; i++) {
        const particle = document.createElement('span');
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
        const distance = 10 + Math.random() * 18;
        const dx = Math.cos(angle) * distance;
        const dy = Math.sin(angle) * distance;
        const size = 3 + Math.random() * 3;
        const color = burstColors[i % burstColors.length] ?? 'rgba(210, 31, 43, 0.95)';
        particle.style.position = 'fixed';
        particle.style.left = `${x}px`;
        particle.style.top = `${y}px`;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.borderRadius = '999px';
        particle.style.pointerEvents = 'none';
        particle.style.zIndex = '9999';
        particle.style.background = color;
        particle.style.boxShadow = `0 0 10px ${color}`;
        particle.style.transform = 'translate(-50%, -50%) scale(1)';
        particle.style.opacity = '0.92';
        particle.style.willChange = 'transform, opacity';
        document.body.appendChild(particle);

        const anim = particle.animate(
          [
            { transform: 'translate(-50%, -50%) scale(1)', opacity: 0.92 },
            { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.2)`, opacity: 0 },
          ],
          {
            duration: 380,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            fill: 'forwards',
          },
        );
        const cleanup = () => {
          if (particle.parentNode) particle.parentNode.removeChild(particle);
        };
        anim.onfinish = cleanup;
        anim.oncancel = cleanup;
      }
    };

    if (!reduced) {
      window.addEventListener('click', onClickBurst, { passive: true });
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('mouseleave', onPointerLeave);
      window.removeEventListener('click', onClickBurst);
    };
  }, []);

  return null;
}
