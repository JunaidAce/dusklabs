import React from 'react';
import { MouseEffects } from '../effects/MouseEffects';
import { AkatsukiCloud } from '../ui/AkatsukiCloud';
import { Footer } from './Footer';
import { Navbar } from './Navbar';

export function PageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'transparent', position: 'relative', zIndex: 1 }}>
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 0,
          overflow: 'hidden',
        }}
      >
        <AkatsukiCloud size={150} className="dl-akatsuki-deco-cloud dl-akatsuki-cloud-a" />
        <AkatsukiCloud size={110} className="dl-akatsuki-deco-cloud dl-akatsuki-cloud-b" />
        <span className="dl-akatsuki-deco-kanji dl-akatsuki-kanji-a">暁</span>
        <span className="dl-akatsuki-deco-kanji dl-akatsuki-kanji-b">忍</span>
      </div>
      <style>{`
        @keyframes dl-float-a { 0%,100%{ transform: translateY(0) rotate(0deg); } 50%{ transform: translateY(-10px) rotate(8deg); } }
        @keyframes dl-float-b { 0%,100%{ transform: translateY(0) rotate(0deg); } 50%{ transform: translateY(8px) rotate(-6deg); } }
      `}</style>
      <MouseEffects />
      <Navbar />
      <main style={{ flex: 1, position: 'relative', zIndex: 1 }}>{children}</main>
      <Footer />
    </div>
  );
}
