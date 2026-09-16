/**
 * Minimal types for the `qrcode` package — only what this app calls.
 *
 * ── WHY A LOCAL DECLARATION ────────────────────────────────────────────────
 * `@types/qrcode` is not installed, and adding it is a network fetch and a
 * lockfile change for one function. This declaration was written against the
 * INSTALLED source instead — `node_modules/qrcode/lib/browser.js` (1.5.0):
 *
 *   exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL)
 *
 * and the options its renderer actually reads: width, margin, scale, color.
 * Anything not listed here is not typed on purpose; add it when it is used and
 * check it against the source the same way.
 *
 * ── WHY qrcode AND NOT A NEW LIBRARY ───────────────────────────────────────
 * @aws-amplify/ui-react already depends on it for the Authenticator's own TOTP
 * setup screen, so it is guaranteed present wherever the Authenticator is. It
 * is declared in apps/console/package.json regardless: relying on a transitive
 * dependency is how a routine upgrade of ui-react silently removes a module
 * this app imports.
 */
declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    /** Rendered width in pixels. Also the height — QR codes are square. */
    readonly width?: number;
    /** Quiet zone in modules. The spec wants 4; 1 is fine on-screen at this size. */
    readonly margin?: number;
    readonly scale?: number;
    readonly color?: {
      /** CSS colour for the dark modules. */
      readonly dark?: string;
      /** CSS colour for the light modules. */
      readonly light?: string;
    };
  }

  /** Renders `text` as a QR code and resolves to a PNG data: URL. */
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
}
