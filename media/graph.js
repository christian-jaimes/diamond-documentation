// @ts-check
// Graph view: dependency-free force-directed layout on a <canvas>.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('graph'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const tooltip = /** @type {HTMLElement} */ (document.getElementById('tooltip'));
  const $ = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

  const saved = vscode.getState() || {};
  const ui = {
    search: $('search'), local: $('local'), depth: $('depth'), depthVal: $('depthVal'),
    docs: $('docs'), files: $('files'), ghosts: $('ghosts'), orphans: $('orphans'), labels: $('labels'), legend: $('showLegend'),
  };
  for (const k of ['docs', 'files', 'ghosts', 'orphans', 'labels', 'legend', 'local']) { if (k in saved) { ui[k].checked = saved[k]; } }
  if (saved.depth) { ui.depth.value = saved.depth; }
  ui.depthVal.textContent = ui.depth.value;

  /** @type {{nodes: any[], edges: any[]}} */
  let data = { nodes: [], edges: [] };
  /** Simulation nodes keyed by id; positions survive data refreshes. */
  const simNodes = new Map();
  let nodes = [], links = [];
  let neighbors = new Map();
  let focusId = null;
  let hover = null, dragging = null, panning = null, downAt = null;
  let view = { x: 0, y: 0, k: 1 };
  let alpha = 1;
  let needsFit = true;
  let running = false;

  // ------------------------------------------------------------- theming
  const css = (/** @type {string} */ v, fallback) => getComputedStyle(document.body).getPropertyValue(v).trim() || fallback;
  let colors = {};
  function readTheme() {
    colors = {
      bg: css('--vscode-editor-background', '#1e1e1e'),
      fg: css('--vscode-editor-foreground', '#ccc'),
      edge: css('--vscode-editorIndentGuide-background1', css('--vscode-editorIndentGuide-background', '#555')),
      accent: css('--vscode-focusBorder', '#0a84ff'),
      ghost: css('--vscode-disabledForeground', '#777'),
      file: css('--vscode-charts-orange', '#d18616'),
      font: css('--vscode-font-family', 'sans-serif'),
    };
  }
  readTheme();
  new MutationObserver(() => { readTheme(); draw(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  const groupColor = new Map();
  function colorFor(n) {
    if (n.color) { return n.color; }
    if (n.type === 'ghost') { return colors.ghost; }
    if (n.type === 'file') { return colors.file; }
    if (!groupColor.has(n.group)) {
      // One colour per top-level folder, spread around the hue wheel (golden angle).
      groupColor.set(n.group, `hsl(${Math.round(210 + groupColor.size * 137.5) % 360}, 60%, 62%)`);
    }
    return groupColor.get(n.group);
  }

  // ------------------------------------------------------------- filtering
  function persist() {
    vscode.setState({ docs: ui.docs.checked, files: ui.files.checked, ghosts: ui.ghosts.checked, orphans: ui.orphans.checked, labels: ui.labels.checked, legend: ui.legend.checked, local: ui.local.checked, depth: ui.depth.value });
  }

  function rebuild() {
    const q = ui.search.value.trim().toLowerCase();
    let visible = data.nodes.filter(n =>
      (ui.docs.checked || n.type !== 'note' || n.id === focusId) && (ui.files.checked || n.type !== 'file') && (ui.ghosts.checked || n.type !== 'ghost'));
    const ids = new Set(visible.map(n => n.id));
    let edges = data.edges.filter(e => ids.has(e.source) && ids.has(e.target));

    // Local mode follows the active file; say so when it has nothing to show.
    let empty = '';
    if (ui.local.checked && !focusId) { empty = 'Open a file to see its links.'; }
    else if (ui.local.checked && !ids.has(focusId)) { empty = 'No links to or from this file yet.'; }
    $('empty').textContent = empty;
    $('empty').style.display = empty ? '' : 'none';
    if (empty) { visible = []; edges = []; }

    if (ui.local.checked && focusId && ids.has(focusId)) {
      const adj = new Map();
      for (const e of edges) {
        (adj.get(e.source) || adj.set(e.source, []).get(e.source)).push(e.target);
        (adj.get(e.target) || adj.set(e.target, []).get(e.target)).push(e.source);
      }
      const keep = new Set([focusId]);
      let frontier = [focusId];
      for (let d = 0; d < +ui.depth.value; d++) {
        const next = [];
        for (const id of frontier) { for (const m of adj.get(id) || []) { if (!keep.has(m)) { keep.add(m); next.push(m); } } }
        frontier = next;
      }
      visible = visible.filter(n => keep.has(n.id));
      edges = edges.filter(e => keep.has(e.source) && keep.has(e.target));
    }

    if (q) {
      const match = (n) => n.label.toLowerCase().includes(q) || n.path.toLowerCase().includes(q) || (q.startsWith('#') && n.tags.some(t => ('#' + t).toLowerCase().startsWith(q)));
      const hits = new Set(visible.filter(match).map(n => n.id));
      // Keep direct neighbours of matches so context stays visible.
      for (const e of edges) { if (hits.has(e.source) || hits.has(e.target)) { hits.add(e.source); hits.add(e.target); } }
      visible = visible.filter(n => hits.has(n.id));
      edges = edges.filter(e => hits.has(e.source) && hits.has(e.target));
    }

    const degree = new Map();
    for (const e of edges) { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); }
    if (!ui.orphans.checked) { visible = visible.filter(n => degree.get(n.id) || n.id === focusId); }

    // First neighbour of each node, so new nodes can appear next to it.
    const anchorOf = new Map();
    for (const e of edges) {
      if (!anchorOf.has(e.source)) { anchorOf.set(e.source, e.target); }
      if (!anchorOf.has(e.target)) { anchorOf.set(e.target, e.source); }
    }
    let added = 0;
    nodes = visible.map(n => {
      let s = simNodes.get(n.id);
      if (!s) {
        added++;
        const r = 50 + Math.random() * 250, a = Math.random() * Math.PI * 2;
        const near = simNodes.get(anchorOf.get(n.id));
        s = { x: near ? near.x + Math.cos(a) * 30 : Math.cos(a) * r, y: near ? near.y + Math.sin(a) * 30 : Math.sin(a) * r, vx: 0, vy: 0 };
        simNodes.set(n.id, s);
      }
      s.data = n;
      s.degree = degree.get(n.id) || 0;
      s.r = 4 + Math.sqrt(s.degree) * 2.2;
      return s;
    });
    const byId = new Map(nodes.map(n => [n.data.id, n]));
    links = edges.map(e => ({ s: byId.get(e.source), t: byId.get(e.target) })).filter(l => l.s && l.t);
    neighbors = new Map(nodes.map(n => [n, new Set()]));
    for (const l of links) { neighbors.get(l.s).add(l.t); neighbors.get(l.t).add(l.s); }

    $('stats').textContent = `${nodes.length} nodes · ${links.length} links`;
    $('depthWrap').style.display = ui.local.checked ? '' : 'none';
    // Only shake the layout hard when new nodes arrived; otherwise just settle the changes.
    reheat(added ? 0.8 : 0.25);
  }

  // ------------------------------------------------------------- physics
  function reheat(a) { alpha = Math.max(alpha, a); if (!running) { running = true; requestAnimationFrame(tick); } }

  function tick() {
    for (let i = 0; i < 2; i++) { step(); }
    draw();
    // Keep the view fitted while the layout settles (until the user pans or zooms).
    if (needsFit) { fit(alpha > 0.3 ? 0.08 : 0.25); }
    if (alpha > 0.004 || dragging) { requestAnimationFrame(tick); } else { running = false; if (needsFit) { fit(); needsFit = false; } }
  }

  function step() {
    const n = nodes.length;
    if (!n) { return; }
    // Repulsion: Barnes–Hut quadtree, O(n log n).
    const tree = buildQuadTree(nodes);
    const strength = 900;
    for (const a of nodes) { applyRepulsion(tree, a, strength * alpha); }
    // Springs
    for (const l of links) {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = (dist - 70) / dist * 0.06 * alpha / Math.max(1, Math.min(l.s.degree, l.t.degree) * 0.5);
      l.s.vx += dx * k; l.s.vy += dy * k; l.t.vx -= dx * k; l.t.vy -= dy * k;
    }
    // Gravity toward the centre keeps disconnected islands on screen.
    for (const a of nodes) {
      a.vx -= a.x * 0.012 * alpha; a.vy -= a.y * 0.012 * alpha;
      if (a === dragging) { a.vx = a.vy = 0; continue; }
      // In the local graph the open file sits in the middle, its links around it.
      if (ui.local.checked && a.data.id === focusId) { a.x += (0 - a.x) * 0.3; a.y += (0 - a.y) * 0.3; a.vx = a.vy = 0; continue; }
      a.vx *= 0.6; a.vy *= 0.6;
      a.x += Math.max(-40, Math.min(40, a.vx));
      a.y += Math.max(-40, Math.min(40, a.vy));
    }
    alpha *= 0.985;
  }

  function buildQuadTree(list) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of list) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const size = Math.max(maxX - minX, maxY - minY) + 1;
    const root = { x0: minX, y0: minY, size, mass: 0, cx: 0, cy: 0, kids: null, point: null };
    for (const p of list) { insert(root, p, 0); }
    return root;
  }
  function insert(q, p, depth) {
    q.cx = (q.cx * q.mass + p.x) / (q.mass + 1); q.cy = (q.cy * q.mass + p.y) / (q.mass + 1); q.mass++;
    if (!q.kids && !q.point) { q.point = p; return; }
    if (depth > 24) { return; } // coincident points
    if (!q.kids) {
      const h = q.size / 2;
      q.kids = [0, 1, 2, 3].map(i => ({ x0: q.x0 + (i & 1) * h, y0: q.y0 + (i >> 1) * h, size: h, mass: 0, cx: 0, cy: 0, kids: null, point: null }));
      const old = q.point; q.point = null;
      insert(child(q, old), old, depth + 1);
    }
    insert(child(q, p), p, depth + 1);
  }
  function child(q, p) { const h = q.size / 2; return q.kids[(p.x >= q.x0 + h ? 1 : 0) + (p.y >= q.y0 + h ? 2 : 0)]; }
  function applyRepulsion(q, a, s) {
    if (!q.mass || q.point === a && !q.kids) { return; }
    let dx = a.x - q.cx, dy = a.y - q.cy;
    let d2 = dx * dx + dy * dy;
    if (q.kids && q.size * q.size / (d2 || 1) > 0.81) { for (const k of q.kids) { applyRepulsion(k, a, s); } return; }
    if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
    const f = s * q.mass / Math.max(d2, 100);
    const d = Math.sqrt(d2);
    a.vx += dx / d * f; a.vy += dy / d * f;
  }

  // ------------------------------------------------------------- drawing
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.save();
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2 + view.x, h / 2 + view.y); ctx.scale(view.k, view.k);

    const active = hover || null;
    const near = active ? neighbors.get(active) : null;
    const lit = (n) => !active || n === active || near.has(n);

    ctx.lineWidth = 1 / view.k;
    for (const l of links) {
      const on = active && (l.s === active || l.t === active);
      ctx.strokeStyle = on ? colors.accent : colors.edge;
      ctx.globalAlpha = active && !on ? 0.15 : on ? 1 : 0.6;
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
      if (view.k > 0.35) { arrow(l, on ? colors.accent : colors.edge); }
    }
    for (const n of nodes) {
      ctx.globalAlpha = lit(n) ? 1 : 0.2;
      ctx.fillStyle = colorFor(n.data);
      ctx.beginPath();
      if (n.data.type === 'file') { ctx.rect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2); }
      else { ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); }
      if (n.data.type === 'ghost') { ctx.strokeStyle = colors.ghost; ctx.lineWidth = 1.5 / view.k; ctx.stroke(); } else { ctx.fill(); }
      if (n.data.id === focusId) {
        ctx.strokeStyle = colors.accent; ctx.lineWidth = 2.5 / view.k;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (ui.labels.checked) {
      const fontSize = 11 / Math.max(view.k, 0.6);
      ctx.font = `${fontSize}px ${colors.font}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = colors.fg;
      for (const n of nodes) {
        const show = n === active || (near && near.has(n)) || n.data.id === focusId || view.k > 0.9 || n.degree > 6 / view.k;
        if (!show) { continue; }
        ctx.globalAlpha = lit(n) ? 0.95 : 0.15;
        ctx.fillText(n.data.label, n.x, n.y + n.r + 2);
      }
    }
    ctx.restore();
  }

  /** Arrowhead at the target end of a link, so outgoing links and backlinks can be told apart. */
  function arrow(l, color) {
    const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
    const d = Math.hypot(dx, dy);
    if (d < l.t.r + 8) { return; }
    const ux = dx / d, uy = dy / d;
    const tipX = l.t.x - ux * (l.t.r + 1.5), tipY = l.t.y - uy * (l.t.r + 1.5);
    const size = Math.min(7, 4.5 / Math.min(view.k, 1.2));
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
    ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
    ctx.closePath(); ctx.fill();
  }

  /** Zoom and centre on the visible nodes; `ease` < 1 moves only part of the way (smooth follow). */
  function fit(ease = 1) {
    if (!nodes.length) { return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    const w = canvas.clientWidth, h = canvas.clientHeight - (document.body.classList.contains('compact') ? 40 : 60);
    const k = Math.min(2.2, 0.9 * Math.min(w / (maxX - minX + 60), h / (maxY - minY + 60)));
    const x = -(minX + maxX) / 2 * k, y = -(minY + maxY) / 2 * k + (document.body.classList.contains('compact') ? 14 : 20);
    view.k += (k - view.k) * ease; view.x += (x - view.x) * ease; view.y += (y - view.y) * ease;
    draw();
  }

  // ------------------------------------------------------------- interaction
  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - view.x) / view.k, y: (e.clientY - r.top - r.height / 2 - view.y) / view.k };
  };
  function nodeAt(p) {
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
      const hit = (n.r + 4 / view.k) ** 2;
      if (d < hit && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  canvas.addEventListener('mousedown', e => {
    const p = toWorld(e);
    downAt = { x: e.clientX, y: e.clientY };
    const n = nodeAt(p);
    if (n) { dragging = n; reheat(0.3); } else { needsFit = false; panning = { x: e.clientX - view.x, y: e.clientY - view.y }; }
  });
  window.addEventListener('mousemove', e => {
    if (dragging) {
      const p = toWorld(e); dragging.x = p.x; dragging.y = p.y; reheat(0.3); return;
    }
    if (panning) { view.x = e.clientX - panning.x; view.y = e.clientY - panning.y; draw(); return; }
    if (e.target !== canvas) { return; }
    const n = nodeAt(toWorld(e));
    if (n !== hover) { hover = n; canvas.style.cursor = n ? 'pointer' : 'default'; draw(); }
    if (n) {
      tooltip.textContent = n.data.path + (n.data.tags.length ? '  ' + n.data.tags.map(t => '#' + t).join(' ') : '');
      tooltip.style.display = 'block'; tooltip.style.left = e.clientX + 12 + 'px'; tooltip.style.top = e.clientY + 12 + 'px';
    } else { tooltip.style.display = 'none'; }
  });
  window.addEventListener('mouseup', e => {
    const moved = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
    if (dragging && !moved) {
      vscode.postMessage({ type: 'open', id: dragging.data.id, label: dragging.data.label, beside: e.ctrlKey || e.metaKey });
    }
    dragging = null; panning = null; downAt = null;
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    needsFit = false;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const k = Math.max(0.05, Math.min(6, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k;
    draw();
  }, { passive: false });

  for (const k of ['docs', 'files', 'ghosts', 'orphans', 'local']) { ui[k].addEventListener('change', () => { persist(); needsFit = true; rebuild(); }); }
  ui.labels.addEventListener('change', () => { persist(); draw(); });
  ui.depth.addEventListener('input', () => { ui.depthVal.textContent = ui.depth.value; persist(); needsFit = true; rebuild(); });
  ui.search.addEventListener('input', () => { needsFit = true; rebuild(); });
  // (Not `addEventListener('click', fit)`: the click event would be taken as fit's easing argument.)
  $('fit').addEventListener('click', () => { needsFit = false; fit(); });
  ui.legend.addEventListener('change', () => { persist(); updateLegend(); });
  $('colors').addEventListener('click', () => vscode.postMessage({ type: 'configureColors' }));
  $('toggleFilters').addEventListener('click', () => document.body.classList.toggle('filters-open'));

  // ------------------------------------------------------------- messages
  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (msg.type === 'data') { data = msg.graph; renderLegend(msg.legend || []); rebuild(); }
    else if (msg.type === 'mode') {
      // A choice saved in this view wins over the default, unless a command asked for a mode.
      if (msg.local !== undefined && (msg.force || !('local' in saved))) { ui.local.checked = msg.local; }
      if (msg.depth !== undefined && (msg.force || !('depth' in saved))) { ui.depth.value = String(msg.depth); ui.depthVal.textContent = ui.depth.value; }
      if (msg.showFiles !== undefined && !('files' in saved)) { ui.files.checked = msg.showFiles; }
      if (msg.showOrphans !== undefined && !('orphans' in saved)) { ui.orphans.checked = msg.showOrphans; }
      focusId = msg.focus || focusId; needsFit = true; persist(); rebuild();
    } else if (msg.type === 'focus') {
      focusId = msg.focus;
      if (ui.local.checked) { needsFit = true; rebuild(); } else { draw(); }
    }
  });

  function renderLegend(items) {
    const el = $('legend');
    el.replaceChildren(...items.map(i => {
      const row = document.createElement('div');
      const dot = document.createElement('span');
      dot.className = 'dot'; dot.style.background = i.color;
      row.append(dot, document.createTextNode(i.label));
      return row;
    }));
    updateLegend();
  }

  /** The legend shows when it is switched on and there are configured colours to explain. */
  function updateLegend() {
    const el = $('legend');
    el.style.display = ui.legend.checked && el.childElementCount ? '' : 'none';
  }

  new ResizeObserver(resize).observe(canvas);
  resize();
  vscode.postMessage({ type: 'ready' });
})();
