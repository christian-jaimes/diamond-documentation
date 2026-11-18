// A minimap for the live editor, modelled on VS Code's own (which custom editors can't use):
// a scaled-down picture of the text on the right edge, a viewport slider that appears on hover
// and can be dragged, click-to-jump, and marks for search matches, the selection and diagnostics.
// Geometry is linear in editor pixels, so wrapped lines, headings, images and tables keep their
// proportions. Only the part of the document that is visible in the minimap is drawn.
import { EditorState, Extension, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { SearchQuery, getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { MINIMAP_DEFAULTS, MinimapGeometry, MinimapSettings, minimapGeometry, minimapRatio, normalizeMinimap, scrollForSliderTop } from '../shared/minimap';
import { diagnosticMarks } from './diagnostics';

const setMinimap = StateEffect.define<MinimapSettings>();
const settingsField = StateField.define<MinimapSettings>({
  create: () => MINIMAP_DEFAULTS,
  update(value, tr) {
    for (const e of tr.effects) { if (e.is(setMinimap)) { return e.value; } }
    return value;
  },
});

/** Change the minimap settings of a running editor (VS Code's `editor.minimap.*` changed). */
export function updateMinimap(view: EditorView, raw: unknown) {
  view.dispatch({ effects: setMinimap.of(normalizeMinimap(raw as Partial<MinimapSettings>)) });
}

export function minimapSupport(raw: unknown): Extension {
  return [settingsField.init(() => normalizeMinimap(raw as Partial<MinimapSettings>)), ViewPlugin.fromClass(MinimapPlugin)];
}

// ------------------------------------------------------------------ colours
type RGBA = [number, number, number, number];
let probe: CanvasRenderingContext2D | undefined;
/** Any CSS colour as [r, g, b, a(0..1)]; `fallback` is used when `css` is empty or invalid. */
function parseColor(css: string, fallback: string): RGBA {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  probe.canvas.width = probe.canvas.height = 1;
  probe.fillStyle = fallback;
  probe.fillStyle = css || fallback;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
}

interface Colors {
  text: RGBA; foregroundOpacity: number;
  find: string; selection: string; error: string; warning: string; info: string;
}

function readColors(el: HTMLElement): Colors {
  const style = getComputedStyle(el);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const css = (c: RGBA) => `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`;
  const mark = (name: string, alt: string, fallback: string) => css(parseColor(v(name) || v(alt), fallback));
  return {
    text: parseColor(v('--vscode-editor-foreground'), '#d4d4d4'),
    foregroundOpacity: parseColor(v('--vscode-minimap-foregroundOpacity'), '#000000c0')[3],
    find: mark('--vscode-minimap-findMatchHighlight', '--vscode-editor-findMatchHighlightBackground', '#d18616'),
    selection: mark('--vscode-minimap-selectionHighlight', '--vscode-editor-selectionBackground', '#264f78'),
    error: mark('--vscode-minimap-errorHighlight', '--vscode-editorError-foreground', '#ff1212b3'),
    warning: mark('--vscode-minimap-warningHighlight', '--vscode-editorWarning-foreground', '#cca700'),
    info: mark('--vscode-minimap-infoHighlight', '--vscode-editorInfo-foreground', '#3794ff'),
  };
}

// ------------------------------------------------------------------ layout of the visible text
/** One document line as laid out in the minimap: where its rows start (editor pixels) and how it wraps. */
interface LineLayout {
  from: number; to: number; text: string;
  y: number;          // editor y of the first row (document coordinates)
  rows: number;
  cpr: number;        // characters per row
  mult: number;       // width multiplier (headings are drawn wider)
  heading: boolean;
}

interface Mark { from: number; to: number; color?: string; }

const HEADING_NODE = /^(ATX|Setext)Heading(\d)$/;
const SHORT_GLYPHS = /[aceimnorsuvwxz]/;

class MinimapPlugin {
  private readonly dom = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly slider = document.createElement('div');
  private readonly layer = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d')!;
  private colors?: Colors;
  private raf = 0;
  private dirty = true;
  private geo?: MinimapGeometry;
  private viewH = 0;
  private width = 0;           // css px
  private shownSide = '';
  private matches: { doc: unknown; query: SearchQuery; marks: Mark[] } | undefined;
  private readonly resize: ResizeObserver;
  private readonly theme: MutationObserver;
  private readonly onScroll = () => { if (this.geo && this.geo.contentH > this.viewH) { this.dirty = true; } this.schedule(); };

  constructor(readonly view: EditorView) {
    this.dom.className = 'cm-d-minimap';
    this.canvas.className = 'cm-d-minimap-canvas';
    this.slider.className = 'cm-d-minimap-slider';
    this.dom.append(this.canvas, this.slider);
    view.dom.appendChild(this.dom);
    this.dom.addEventListener('pointerdown', e => this.pointerDown(e));
    this.dom.addEventListener('wheel', e => this.wheel(e), { passive: false });
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.resize = new ResizeObserver(() => { this.dirty = true; this.schedule(); });
    this.resize.observe(view.scrollDOM);
    // VS Code swaps the --vscode-* variables on <html> when the theme changes.
    this.theme = new MutationObserver(() => { this.colors = undefined; this.dirty = true; this.schedule(); });
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    this.schedule();
  }

  update(u: ViewUpdate) {
    // Cheap enough to redraw on any change: only the visible rows are drawn, once per frame.
    if (u.docChanged || u.geometryChanged || u.viewportChanged || u.heightChanged || u.selectionSet
      || u.transactions.some(tr => tr.effects.length)) {
      this.dirty = true;
      this.schedule();
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.theme.disconnect();
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.view.scrollDOM.classList.remove('cm-d-no-scrollbar');
    this.view.scrollDOM.style.paddingLeft = this.view.scrollDOM.style.paddingRight = '';
    this.view.dom.style.removeProperty('--diamond-minimap-inset');
    this.dom.remove();
  }

  private schedule() {
    if (!this.raf) { this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }
  }

  // ---------------------------------------------------------------- geometry
  private compute(cfg: MinimapSettings): MinimapGeometry {
    const sc = this.view.scrollDOM;
    this.viewH = sc.clientHeight;
    const s = minimapRatio(cfg.size, cfg.scale, this.view.defaultLineHeight, this.viewH, sc.scrollHeight);
    return minimapGeometry(sc.scrollTop, this.viewH, sc.scrollHeight, s);
  }

  // ---------------------------------------------------------------- interaction
  private pointerDown(e: PointerEvent) {
    if (e.button !== 0 || !this.geo) { return; }
    e.preventDefault(); // keep the editor focused
    const cfg = this.view.state.field(settingsField);
    const sc = this.view.scrollDOM;
    const top = this.dom.getBoundingClientRect().top;
    const g0 = this.geo;
    const y = e.clientY - top;
    // On the slider: keep the grab point. Elsewhere: centre the viewport on the click, then drag from there.
    const onSlider = y >= g0.sliderTop && y <= g0.sliderTop + g0.sliderH;
    const grab = onSlider ? y - g0.sliderTop : g0.sliderH / 2;
    const startScroll = sc.scrollTop, startX = e.clientX;
    this.dom.classList.add('cm-d-minimap-active');
    this.dom.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      // Like VS Code: dragging far to the side cancels, and the editor snaps back.
      if (Math.abs(ev.clientX - startX) > 140) { sc.scrollTop = startScroll; return; }
      const g = this.compute(cfg);
      sc.scrollTop = scrollForSliderTop(ev.clientY - top - grab, g, this.viewH);
    };
    const end = () => {
      this.dom.classList.remove('cm-d-minimap-active');
      this.dom.removeEventListener('pointermove', move);
      this.dom.removeEventListener('pointerup', end);
      this.dom.removeEventListener('pointercancel', end);
    };
    this.dom.addEventListener('pointermove', move);
    this.dom.addEventListener('pointerup', end);
    this.dom.addEventListener('pointercancel', end);
    move(e);
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const sc = this.view.scrollDOM;
    sc.scrollTop += e.deltaMode === 1 ? e.deltaY * this.view.defaultLineHeight : e.deltaMode === 2 ? e.deltaY * sc.clientHeight : e.deltaY;
  }

  // ---------------------------------------------------------------- marks
  private searchMarks(state: EditorState): Mark[] {
    if (!searchPanelOpen(state)) { return []; }
    const query = getSearchQuery(state);
    if (!query.valid) { return []; }
    if (this.matches && this.matches.doc === state.doc && this.matches.query.eq(query)) { return this.matches.marks; }
    const marks: Mark[] = [];
    const cursor = query.getCursor(state);
    for (let n = 0; n < 10000; n++) {
      const r = cursor.next();
      if (r.done) { break; }
      marks.push({ from: r.value.from, to: r.value.to });
    }
    this.matches = { doc: state.doc, query, marks };
    return marks;
  }

  // ---------------------------------------------------------------- drawing
  private draw() {
    const { view } = this;
    const cfg = view.state.field(settingsField);
    const sc = view.scrollDOM;
    const viewW = view.dom.clientWidth;
    const on = cfg.enabled && viewW >= 250 && sc.clientHeight > 0;
    this.dom.style.display = on ? '' : 'none';
    // The minimap's slider is the scrollbar while it is shown (no second scrollbar next to it).
    sc.classList.toggle('cm-d-no-scrollbar', on);
    if (!on) { this.setPadding(cfg, 0); return; }

    const dpr = window.devicePixelRatio || 1;
    const cwD = Math.max(1, Math.round(cfg.scale * dpr));          // device px per column
    const geo = this.geo = this.compute(cfg);
    const width = Math.min(Math.round(cfg.maxColumn * cwD / dpr), Math.max(40, Math.floor(viewW / 4)));
    const cols = Math.floor(width * dpr / cwD);
    const sbw = 0;
    this.width = width;
    this.setPadding(cfg, width);
    this.dom.style.width = width + 'px';
    this.dom.style.left = cfg.side === 'left' ? '0' : 'auto';
    this.dom.style.right = cfg.side === 'right' ? sbw + 'px' : 'auto';
    this.dom.classList.toggle('cm-d-minimap-always', true) // always shown: with no scrollbar it is the scroll position indicator;
    this.dom.classList.toggle('cm-d-minimap-left', cfg.side === 'left');

    // Slider: always cheap, even when the picture itself is unchanged.
    this.slider.style.top = Math.max(0, geo.sliderTop) + 'px';
    this.slider.style.height = Math.max(4, geo.sliderH) + 'px';

    const Wd = Math.round(width * dpr), Hd = Math.round(this.viewH * dpr);
    if (!this.dirty && this.canvas.width === Wd && this.canvas.height === Hd) { return; }
    this.dirty = false;
    if (this.canvas.width !== Wd || this.canvas.height !== Hd) {
      this.canvas.width = Wd; this.canvas.height = Hd;
      this.canvas.style.width = width + 'px'; this.canvas.style.height = this.viewH + 'px';
    }
    this.colors ??= readColors(view.dom);
    const colors = this.colors;
    const { state } = view;
    const doc = state.doc;
    const lh = view.defaultLineHeight;
    const padTop = view.documentPadding.top;
    const rowD = Math.max(1, Math.round(lh * geo.s * dpr));       // device px per text row
    const gap = rowD >= 3 ? 1 : 0;
    const glyphH = Math.max(1, rowD - gap);
    const yOf = (docY: number) => Math.round(((docY + padTop) * geo.s - geo.offset) * dpr);

    // ---- which lines are visible in the minimap
    const yTop = (geo.offset / geo.s) - padTop - lh, yBottom = ((geo.offset + this.viewH) / geo.s) - padTop;
    const textW = Math.max(120, view.contentDOM.clientWidth - 96);
    const cpr = Math.max(20, Math.floor(textW / Math.max(1, view.defaultCharacterWidth)));
    const lines: LineLayout[] = [];
    const tree = syntaxTree(state);
    let block = view.lineBlockAtHeight(Math.max(0, yTop));
    for (let guard = 0; guard < 20000; guard++) {
      const first = doc.lineAt(block.from), last = doc.lineAt(block.to);
      if (first.number === last.number) {
        let heading = false, mult = 1;
        if (first.text.charCodeAt(0) === 35 /* # */) {
          for (let n: any = tree.resolveInner(first.from, 1); n; n = n.parent) {
            const m = HEADING_NODE.exec(n.name);
            if (m) { heading = true; mult = Number(m[2]) <= 2 ? 2 : 1; break; }
          }
        }
        const perRow = Math.max(1, Math.floor(cpr / mult));
        const rows = Math.max(1, Math.ceil(first.length / perRow));
        // Headings sit lower in their (taller) block; centre them.
        const y = heading ? block.top + Math.max(0, (block.height - rows * lh) / 2) : block.top;
        lines.push({ from: first.from, to: first.to, text: first.text, y, rows, cpr: perRow, mult, heading });
      } else {
        // A block covering several lines (a table): spread the lines evenly over its height.
        const n = last.number - first.number + 1, step = block.height / n;
        const i0 = Math.max(0, Math.floor((yTop - block.top) / step)), i1 = Math.min(n - 1, Math.ceil((yBottom - block.top) / step));
        for (let i = i0; i <= i1; i++) {
          const l = doc.line(first.number + i);
          lines.push({ from: l.from, to: l.to, text: l.text, y: block.top + i * step, rows: 1, cpr: Math.max(1, cpr), mult: 1, heading: false });
        }
      }
      if (block.to >= doc.length || block.bottom > yBottom) { break; }
      block = view.lineBlockAt(block.to + 1);
    }

    // ---- marks (behind the text)
    const ctx = this.ctx;
    ctx.clearRect(0, 0, Wd, Hd);
    const paint = (list: Mark[], color: (m: Mark) => string, lineFull = false) => {
      if (!list.length || !lines.length) { return; }
      let lo = 0, hi = list.length;                      // first mark that ends at or after the first visible line
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].to < lines[0].from) { lo = mid + 1; } else { hi = mid; } }
      let i = lo;
      for (const l of lines) {
        while (i < list.length && list[i].to < l.from) { i++; }
        for (let j = i; j < list.length && list[j].from <= l.to; j++) {
          const m = list[j];
          const a = Math.max(m.from, l.from) - l.from;
          let b = Math.min(m.to, l.to) - l.from;
          if (b <= a) { if (!(lineFull && m.to > l.to)) { continue; } b = a + 1; }
          ctx.fillStyle = color(m);
          for (let r = Math.floor(a / l.cpr); r <= Math.floor((b - 1) / l.cpr) && r < l.rows; r++) {
            const c0 = Math.max(a, r * l.cpr) - r * l.cpr, c1 = Math.min(b, (r + 1) * l.cpr) - r * l.cpr;
            const x0 = c0 * l.mult * cwD, x1 = Math.min(Wd, c1 * l.mult * cwD);
            if (x1 <= x0 && x0 >= Wd) { continue; }
            ctx.fillRect(x0, yOf(l.y + r * lh), Math.max(cwD, x1 - x0), rowD);
          }
        }
      }
    };
    paint(this.searchMarks(state), () => colors.find);
    paint(state.selection.ranges.filter(r => !r.empty).map(r => ({ from: r.from, to: r.to })).sort((a, b) => a.from - b.from), () => colors.selection, true);
    const sev = [colors.error, colors.warning, colors.info, colors.info];
    paint(diagnosticMarks(state).map(d => ({ from: d.from, to: d.to, color: sev[d.severity] })), m => m.color!);

    // ---- text
    const px = new Uint32Array(Wd * Hd);
    const [tr, tg, tb] = colors.text;
    const pack = (alpha: number) => (Math.round(Math.max(0, Math.min(1, alpha)) * 255) << 24 | tb << 16 | tg << 8 | tr) >>> 0;
    const base = colors.foregroundOpacity;
    const levels = cfg.renderCharacters
      ? [0.5, 0.62, 0.74, 0.86, 1].map(k => pack(base * k * 0.9))
      : [pack(base * 0.45)];
    const headingColor = pack(Math.min(1, base * 1.15));
    for (const l of lines) {
      const text = l.text;
      for (let r = 0; r < l.rows; r++) {
        const y0 = yOf(l.y + r * lh);
        if (y0 + rowD < 0 || y0 >= Hd) { continue; }
        const end = Math.min(text.length, (r + 1) * l.cpr);
        let x = 0;
        for (let i = r * l.cpr; i < end; i++) {
          const c = text.charCodeAt(i);
          const w = cwD * l.mult;
          if (c <= 32) { x += c === 9 ? w * 4 : w; continue; }
          if (x + w > Wd) { break; }
          let color: number, h = glyphH;
          if (l.heading) { color = headingColor; }
          else if (cfg.renderCharacters) {
            color = levels[((c * 7) ^ (c >> 3)) % 5];
            if (SHORT_GLYPHS.test(text[i]) && glyphH > 1) { h = glyphH - 1; }
          } else { color = levels[0]; }
          const yEnd = y0 + glyphH;
          for (let yy = Math.max(0, yEnd - h); yy < Math.min(Hd, yEnd); yy++) {
            const row = yy * Wd;
            for (let xx = x; xx < x + w; xx++) { px[row + xx] = color; }
          }
          x += w;
        }
      }
    }
    // putImageData would replace the marks drawn above; composite through a scratch canvas instead.
    this.layer.width = Wd; this.layer.height = Hd;
    this.layer.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), Wd, Hd), 0, 0);
    ctx.drawImage(this.layer, 0, 0);
  }

  /** Reserve room for the minimap inside the scroller, so text never runs underneath it. */
  private setPadding(cfg: MinimapSettings, width: number) {
    const key = cfg.side + ':' + width;
    if (key === this.shownSide) { return; }
    this.shownSide = key;
    const sc = this.view.scrollDOM;
    sc.style.paddingRight = cfg.side === 'right' && width ? width + 'px' : '';
    sc.style.paddingLeft = cfg.side === 'left' && width ? width + 'px' : '';
    // The find widget keeps clear of the minimap, as VS Code's does.
    this.view.dom.style.setProperty('--diamond-minimap-inset', cfg.side === 'right' ? width + 'px' : '0px');
  }
}
