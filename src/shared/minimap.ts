// Minimap settings and geometry shared by the extension (which reads VS Code's `editor.minimap.*`
// settings) and the live editor webview (which draws the minimap). Kept free of DOM and vscode
// imports so it can be unit-tested in plain Node.

export interface MinimapSettings {
  enabled: boolean;
  side: 'right' | 'left';
  renderCharacters: boolean;
  maxColumn: number;
  showSlider: 'always' | 'mouseover';
  size: 'proportional' | 'fill' | 'fit';
  scale: number;
}

export const MINIMAP_DEFAULTS: MinimapSettings = {
  enabled: true, side: 'right', renderCharacters: true, maxColumn: 120, showSlider: 'mouseover', size: 'proportional', scale: 1,
};

/** Fill in missing or invalid values with VS Code's defaults. */
export function normalizeMinimap(raw: Partial<Record<keyof MinimapSettings, unknown>> | undefined): MinimapSettings {
  const d = MINIMAP_DEFAULTS;
  const r = raw ?? {};
  const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed as readonly unknown[]).includes(v) ? v as T : def;
  const num = (v: unknown, min: number, max: number, def: number) => typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    side: pick(r.side, ['right', 'left'] as const, d.side),
    renderCharacters: typeof r.renderCharacters === 'boolean' ? r.renderCharacters : d.renderCharacters,
    maxColumn: num(r.maxColumn, 1, 1000, d.maxColumn),
    showSlider: pick(r.showSlider, ['always', 'mouseover'] as const, d.showSlider),
    size: pick(r.size, ['proportional', 'fill', 'fit'] as const, d.size),
    scale: num(r.scale, 1, 3, d.scale),
  };
}

/**
 * Minimap pixels per editor pixel. `proportional` keeps one 2px row per text line (times `scale`);
 * `fill` stretches a short document to the full height, `fit` shrinks a long one to fit.
 */
export function minimapRatio(size: MinimapSettings['size'], scale: number, lineHeight: number, viewH: number, scrollH: number): number {
  const s = (2 * scale) / Math.max(1, lineHeight);
  if (scrollH <= 0 || viewH <= 0) { return s; }
  if (size === 'fill' && scrollH * s < viewH) { return viewH / scrollH; }
  if (size === 'fit' && scrollH * s > viewH) { return viewH / scrollH; }
  return s;
}

export interface MinimapGeometry {
  /** Minimap pixels per editor pixel. */
  s: number;
  /** How far the minimap's content is scrolled (non-zero only when it is taller than the minimap). */
  offset: number;
  sliderTop: number;
  sliderH: number;
  maxScroll: number;
  /** Total height of the minimap's content. */
  contentH: number;
}

/** Where the viewport slider sits, and how the minimap content is scrolled, for an editor scroll position. */
export function minimapGeometry(scrollTop: number, viewH: number, scrollH: number, s: number): MinimapGeometry {
  const maxScroll = Math.max(0, scrollH - viewH);
  const contentH = scrollH * s;
  // Taller than the minimap: the content scrolls along with the editor, proportionally (like VS Code's).
  const offset = contentH > viewH && maxScroll > 0 ? (scrollTop / maxScroll) * (contentH - viewH) : 0;
  return { s, offset, sliderTop: scrollTop * s - offset, sliderH: Math.min(viewH, viewH * s), maxScroll, contentH };
}

/** The editor scroll position that puts the slider's top at `top` (inverse of `minimapGeometry`). */
export function scrollForSliderTop(top: number, g: MinimapGeometry, viewH: number): number {
  if (g.maxScroll <= 0) { return 0; }
  const range = g.contentH > viewH ? viewH - g.sliderH : g.maxScroll * g.s;
  return range <= 0 ? 0 : Math.min(g.maxScroll, Math.max(0, (top / range) * g.maxScroll));
}
