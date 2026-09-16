import type { CSSProperties } from 'react';
import aeygisMark from './assets/aeygis-mark.png';
import authPanel from './assets/auth-panel.jpg';

/**
 * The left half of the sign-in screen — one large floating ink card.
 *
 * The image is imported, not hot-linked. Vite fingerprints and serves it from
 * the app's own origin, so the console's front door does not depend on a
 * third-party CDN being reachable from a clinic network. It is handed to CSS
 * as a custom property rather than a `background-image` declaration because
 * the panel stacks three layers — legibility overlay, photo, ink gradient —
 * and the gradient underneath is a real fallback: if the photo ever fails to
 * decode, the panel still reads correctly instead of going flat black.
 *
 * The lockup matches the app's top bar exactly (white logo tile + name + mono
 * sub-label) so signing in reads as entering this product rather than
 * crossing between two designs. The mark is the real Aeygis artefact pulled
 * from the deployed health.aeygis.com bundle, not a placeholder monogram.
 */
export function AuthBrandPanel() {
  return (
    <div className="auth-brandwrap">
      <aside
        className="auth-brand"
        style={{ '--auth-panel-image': `url(${authPanel})` } as CSSProperties}
      >
        <div className="auth-lockup">
          <span className="brand-tile">
            <img src={aeygisMark} alt="" width="24" height="24" />
          </span>
          <span className="auth-lockup-word">
            Aeygis Health
            <span>Sales console</span>
          </span>
        </div>

        <div className="auth-hero">
          <h1>
            From first assessment to <em>signed proposal</em>.
          </h1>
          <p>
            The Aeygis workspace for client assessments, pricing, and proposal approvals.
          </p>
        </div>
      </aside>
    </div>
  );
}
