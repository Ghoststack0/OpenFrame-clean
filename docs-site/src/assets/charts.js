// Dependency-free SVG charts for a.yash0.in sites.
//
//   <figure class="chart" data-src="data/latency.json"></figure>          (JSON file, needs http)
//   <figure class="chart"><script type="application/json">{…}</script>   (inline spec)
//     <figcaption>Source and method notes.</figcaption></figure>
//
// Spec types:
//   line    { type, title, subtitle, unit, better, x: [...], series: [{ name, values }], marks: [{ x, label }], zero }
//   bar     { type, title, subtitle, unit, better, x: [...], series: [{ name, values }] }
//   compare { type, title, subtitle, unit, better, labels: ["Before", "After"], rows: [{ label, before, after, unit }] }
// `better` is "lower" or "higher" and decides whether a change reads as an improvement.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = ['--c1', '--c2', '--c3', '--c4', '--c5'];
  const color = (i) => `var(${COLORS[i]})`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '–';
    const a = Math.abs(n);
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: a < 10 ? 2 : a < 100 ? 1 : 0 });
  };
  const short = (n) => {
    const a = Math.abs(n);
    if (a >= 1e9) return fmt(n / 1e9) + 'B';
    if (a >= 1e6) return fmt(n / 1e6) + 'M';
    if (a >= 1e4) return fmt(n / 1e3) + 'k';
    return fmt(n);
  };
  const withUnit = (n, unit) => fmt(n) + (unit ? (/^[%x×]/.test(unit) ? '' : ' ') + unit : '');

  function svg(tag, attrs = {}, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.append(node);
    return node;
  }
  function text(parent, x, y, content, attrs = {}) {
    const t = svg('text', { x, y, ...attrs }, parent);
    t.textContent = content;
    return t;
  }

  function niceTicks(min, max, count = 5) {
    if (min === max) { max = min + 1; min = Math.min(0, min); }
    const span = max - min;
    const step0 = span / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  // Bar with a 4px rounded data end and a square baseline end.
  function barPath(x, y0, w, y1, horizontal) {
    if (horizontal) {
      // x..y1 along x, y0 is top, w is height
      const len = y1 - x;
      const r = Math.min(4, Math.abs(len), w / 2);
      return `M${x},${y0}H${y1 - r}Q${y1},${y0} ${y1},${y0 + r}V${y0 + w - r}Q${y1},${y0 + w} ${y1 - r},${y0 + w}H${x}Z`;
    }
    const up = y1 < y0;
    const r = Math.min(4, Math.abs(y0 - y1), w / 2);
    if (!up) return `M${x},${y0}H${x + w}V${y1 - r}Q${x + w},${y1} ${x + w - r},${y1}H${x + r}Q${x},${y1} ${x},${y1 - r}Z`;
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }

  function delta(before, after, better) {
    const pct = before === 0 ? 0 : ((after - before) / Math.abs(before)) * 100;
    const improved = better === 'higher' ? after > before : after < before;
    const flat = Math.abs(pct) < 0.5;
    return {
      pct,
      cls: flat ? 'flat' : improved ? 'good' : 'bad',
      label: (flat ? '→ ' : pct < 0 ? '▼ ' : '▲ ') + fmt(Math.abs(pct)) + '%',
      word: flat ? 'no change' : improved ? 'better' : 'worse',
      factor: after && before ? (better === 'higher' ? after / before : before / after) : null,
    };
  }

  // ---------- tooltip ----------

  function tooltip(plot) {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    plot.append(tip);
    return {
      show(html, x, y) {
        tip.innerHTML = html;
        tip.classList.add('on');
        const pw = plot.clientWidth;
        const tw = tip.offsetWidth;
        const left = x + 14 + tw > pw ? x - 14 - tw : x + 14;
        tip.style.left = Math.max(0, left) + 'px';
        tip.style.top = Math.max(0, y - tip.offsetHeight / 2) + 'px';
      },
      hide() { tip.classList.remove('on'); },
    };
  }
  const row = (c, name, value) => `<div><i style="background:${c}"></i>${esc(name)}<span>${esc(value)}</span></div>`;

  // ---------- line ----------

  function line(plot, spec, width) {
    const xs = spec.x;
    const series = spec.series;
    const H = spec.height || 300;
    const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
    const ticks = niceTicks(spec.zero === false ? Math.min(...all) : Math.min(0, ...all), Math.max(...all));
    const labelled = series.length > 1 && series.length <= 4 && width > 520;
    const left = Math.max(...ticks.map((t) => short(t).length)) * 7 + 14;
    const m = { t: spec.unit ? 24 : 14, r: labelled ? 112 : 16, b: 34, l: left };
    const iw = width - m.l - m.r;
    const ih = H - m.t - m.b;
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const X = (i) => m.l + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
    const Y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;

    const root = svg('svg', { viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': spec.title || 'Line chart' });
    for (const t of ticks) {
      svg('line', { class: 'grid', x1: m.l, x2: width - m.r, y1: Y(t), y2: Y(t) }, root);
      text(root, m.l - 10, Y(t) + 4, short(t), { 'text-anchor': 'end' });
    }
    if (spec.unit) text(root, m.l - 10, 8, spec.unit, { 'text-anchor': 'end', opacity: 0.8 });
    const every = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(iw / 70))));
    xs.forEach((x, i) => {
      const last = xs.length - 1;
      if (i !== last && (i % every || last - i < every * 0.75)) return;
      text(root, X(i), H - 10, x, { 'text-anchor': i === 0 && xs.length > 1 ? 'start' : i === xs.length - 1 && xs.length > 1 ? 'end' : 'middle' });
    });

    for (const mk of spec.marks || []) {
      const i = xs.indexOf(mk.x);
      if (i < 0) continue;
      svg('line', { class: 'mark-line', x1: X(i), x2: X(i), y1: m.t, y2: m.t + ih }, root);
      text(root, X(i) + 6, m.t + 10, mk.label, { class: 'ink' });
    }

    const showDots = xs.length <= 24;
    series.forEach((s, si) => {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1);
        pen = true;
      });
      svg('path', { d, fill: 'none', style: `stroke:${color(si)}`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, root);
      if (showDots) s.values.forEach((v, i) => {
        if (v !== null && v !== undefined) svg('circle', { cx: X(i), cy: Y(v), r: 3, style: `fill:${color(si)}`, stroke: 'var(--panel-2)', 'stroke-width': 2 }, root);
      });
    });

    // Direct labels at the right edge, nudged apart so they never collide.
    if (labelled) {
      const ends = series.map((s, si) => {
        let i = s.values.length - 1;
        while (i > 0 && (s.values[i] === null || s.values[i] === undefined)) i--;
        return { name: s.name, si, y: Y(s.values[i]) };
      }).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 15);
      for (const e of ends) {
        svg('rect', { x: width - m.r + 10, y: e.y - 4, width: 8, height: 8, rx: 2, style: `fill:${color(e.si)}` }, root);
        text(root, width - m.r + 24, e.y + 4, e.name.length > 13 ? e.name.slice(0, 12) + '…' : e.name, { class: 'ink' });
      }
    }

    // Crosshair + tooltip
    const cross = svg('line', { class: 'cross', y1: m.t, y2: m.t + ih, opacity: 0 }, root);
    const hits = series.map((s, si) => svg('circle', { r: 5, style: `fill:${color(si)}`, stroke: 'var(--panel-2)', 'stroke-width': 2, opacity: 0 }, root));
    const zone = svg('rect', { x: m.l - 8, y: 0, width: iw + 16, height: H, fill: 'transparent', tabindex: 0 }, root);
    plot.append(root);
    const tip = tooltip(plot);
    let idx = -1;
    const show = (i) => {
      idx = Math.max(0, Math.min(xs.length - 1, i));
      cross.setAttribute('x1', X(idx)); cross.setAttribute('x2', X(idx)); cross.setAttribute('opacity', 1);
      series.forEach((s, si) => {
        const v = s.values[idx];
        hits[si].setAttribute('opacity', v === null || v === undefined ? 0 : 1);
        if (v !== null && v !== undefined) { hits[si].setAttribute('cx', X(idx)); hits[si].setAttribute('cy', Y(v)); }
      });
      const scale = plot.clientWidth / width;
      const ys = series.map((s) => s.values[idx]).filter((v) => v !== null && v !== undefined);
      tip.show(`<b>${esc(xs[idx])}</b>` + series.map((s, si) => row(color(si), s.name, withUnit(s.values[idx], spec.unit))).join(''), X(idx) * scale, (ys.length ? Y(Math.max(...ys)) : m.t) * scale);
    };
    const hide = () => { cross.setAttribute('opacity', 0); hits.forEach((h) => h.setAttribute('opacity', 0)); tip.hide(); };
    zone.addEventListener('pointermove', (e) => {
      const r = root.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * width;
      show(Math.round(((px - m.l) / iw) * (xs.length - 1)));
    });
    zone.addEventListener('pointerleave', hide);
    zone.addEventListener('blur', hide);
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { show(idx + 1); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { show(idx < 0 ? xs.length - 1 : idx - 1); e.preventDefault(); }
      if (e.key === 'Escape') hide();
    });
  }

  // ---------- grouped bar ----------

  function bar(plot, spec, width) {
    const xs = spec.x;
    const series = spec.series;
    const H = spec.height || 300;
    const all = series.flatMap((s) => s.values);
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const left = Math.max(...ticks.map((t) => short(t).length)) * 7 + 14;
    const m = { t: spec.unit ? 24 : 18, r: 8, b: 34, l: left };
    const iw = width - m.l - m.r;
    const ih = H - m.t - m.b;
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const Y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
    const band = iw / xs.length;
    const pad = Math.min(band * 0.28, 28);
    const gap = 2;
    const bw = Math.max(2, (band - pad - gap * (series.length - 1)) / series.length);

    const root = svg('svg', { viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': spec.title || 'Bar chart' });
    for (const t of ticks) {
      svg('line', { class: t === 0 ? 'axis' : 'grid', x1: m.l, x2: width - m.r, y1: Y(t), y2: Y(t) }, root);
      text(root, m.l - 10, Y(t) + 4, short(t), { 'text-anchor': 'end' });
    }
    if (spec.unit) text(root, m.l - 10, 8, spec.unit, { 'text-anchor': 'end', opacity: 0.8 });
    plot.append(root);
    const tip = tooltip(plot);
    const maxChars = Math.max(4, Math.floor(band / 7));
    xs.forEach((x, i) => {
      const bx = m.l + i * band + pad / 2;
      text(root, m.l + i * band + band / 2, H - 10, String(x).length > maxChars ? String(x).slice(0, maxChars - 1) + '…' : x, { 'text-anchor': 'middle' });
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null || v === undefined) return;
        const x0 = bx + si * (bw + gap);
        const p = svg('path', { d: barPath(x0, Y(0), bw, Y(v)), style: `fill:${color(si)}`, tabindex: 0 }, root);
        const on = () => {
          p.setAttribute('opacity', 0.85);
          const scale = plot.clientWidth / width;
          tip.show(`<b>${esc(x)}</b>` + row(color(si), s.name, withUnit(v, spec.unit)), (x0 + bw / 2) * scale, Y(v) * scale);
        };
        const off = () => { p.removeAttribute('opacity'); tip.hide(); };
        p.addEventListener('pointerenter', on); p.addEventListener('focus', on);
        p.addEventListener('pointerleave', off); p.addEventListener('blur', off);
      });
    });
    if (series.length === 1 && xs.length <= 12) {
      xs.forEach((x, i) => {
        const v = series[0].values[i];
        if (v !== null && v !== undefined) text(root, m.l + i * band + band / 2, Y(v) + (v < 0 ? 14 : -7), short(v), { 'text-anchor': 'middle', class: 'ink' });
      });
    }
  }

  // ---------- before / after ----------

  function compare(plot, spec, width) {
    const rows = spec.rows;
    const [lb, la] = spec.labels || ['Before', 'After'];
    const better = spec.better || 'lower';
    const labelW = Math.min(180, Math.max(90, width * 0.26));
    const deltaW = width > 520 ? 118 : 84;
    const bh = 12, inner = 3, rowH = bh * 2 + inner + 26;
    const H = rows.length * rowH + 4;
    const iw = width - labelW - deltaW - 92;
    const sharedMax = Math.max(...rows.map((r) => Math.max(r.before, r.after)));

    const root = svg('svg', { viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': spec.title || 'Before and after comparison' });
    plot.append(root);
    const tip = tooltip(plot);
    rows.forEach((r, i) => {
      const top = i * rowH + 10;
      const unit = r.unit ?? spec.unit;
      const max = spec.scale === 'row' ? Math.max(r.before, r.after) : sharedMax;
      const W = (v) => Math.max(2, (v / max) * iw);
      const d = delta(r.before, r.after, r.better || better);
      if (i) svg('line', { class: 'grid', x1: 0, x2: width, y1: top - 10, y2: top - 10 }, root);
      text(root, 0, top + bh + 6, r.label.length > labelW / 7 ? r.label.slice(0, Math.floor(labelW / 7) - 1) + '…' : r.label, { class: 'strong' });
      const x0 = labelW;
      svg('path', { d: barPath(x0, top, bh, x0 + W(r.before), true), style: 'fill:var(--c-before)' }, root);
      text(root, x0 + W(r.before) + 8, top + bh - 2, withUnit(r.before, unit));
      svg('path', { d: barPath(x0, top + bh + inner, bh, x0 + W(r.after), true), style: 'fill:var(--c1)' }, root);
      text(root, x0 + W(r.after) + 8, top + bh * 2 + inner - 2, withUnit(r.after, unit), { class: 'strong' });
      const chip = svg('g', {}, root);
      svg('rect', { x: width - deltaW, y: top + 3, width: deltaW, height: 22, rx: 6, style: `fill:${d.cls === 'good' ? 'rgba(70,201,125,.1)' : d.cls === 'bad' ? 'rgba(255,106,77,.1)' : 'rgba(255,255,255,.05)'}` }, chip);
      text(chip, width - deltaW / 2, top + 18, d.label + (width > 520 ? ' ' + d.word : ''), { 'text-anchor': 'middle', style: `fill:var(${d.cls === 'good' ? '--ok' : d.cls === 'bad' ? '--danger' : '--mute'})` });
      const hit = svg('rect', { x: 0, y: top - 8, width, height: rowH - 4, fill: 'transparent', tabindex: 0 }, root);
      const on = () => {
        const scale = plot.clientWidth / width;
        tip.show(`<b>${esc(r.label)}</b>` + row('var(--c-before)', lb, withUnit(r.before, unit)) + row('var(--c1)', la, withUnit(r.after, unit)) +
          `<div>Change<span>${esc(d.label)} ${d.word}${d.factor && d.factor >= 1.1 ? ` (${fmt(d.factor)}×)` : ''}</span></div>`, (x0 + W(Math.max(r.before, r.after))) * scale, (top + bh) * scale);
      };
      hit.addEventListener('pointerenter', on); hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', tip.hide); hit.addEventListener('blur', tip.hide);
    });
  }

  // ---------- table view ----------

  function table(spec) {
    let head, body;
    if (spec.type === 'compare') {
      const [lb, la] = spec.labels || ['Before', 'After'];
      head = ['Metric', lb, la, 'Change'];
      body = spec.rows.map((r) => {
        const d = delta(r.before, r.after, r.better || spec.better || 'lower');
        const u = r.unit ?? spec.unit;
        return [r.label, withUnit(r.before, u), withUnit(r.after, u), `${d.label} ${d.word}`];
      });
    } else {
      head = [spec.xLabel || '', ...spec.series.map((s) => s.name)];
      body = spec.x.map((x, i) => [x, ...spec.series.map((s) => withUnit(s.values[i], spec.unit))]);
    }
    return '<div class="table"><table><thead><tr>' + head.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('') + '</tr></thead><tbody>' +
      body.map((r) => '<tr>' + r.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
  }

  // ---------- mount ----------

  const RENDER = { line, bar, compare };

  function legend(spec) {
    if (spec.type === 'compare') {
      const [lb, la] = spec.labels || ['Before', 'After'];
      return `<ul class="chart-legend"><li><i style="background:var(--c-before)"></i>${esc(lb)}</li><li><i style="background:var(--c1)"></i>${esc(la)}</li></ul>`;
    }
    if (spec.series.length < 2) return '';
    const cls = spec.type === 'line' ? ' class="line"' : '';
    return '<ul class="chart-legend">' + spec.series.map((s, i) => `<li><i${cls} style="background:${color(i)}"></i>${esc(s.name)}</li>`).join('') + '</ul>';
  }

  function validate(spec) {
    if (!RENDER[spec.type]) throw new Error(`Unknown chart type "${spec.type}". Use line, bar or compare.`);
    if (spec.type === 'compare') {
      if (!Array.isArray(spec.rows) || !spec.rows.length) throw new Error('compare charts need rows: [{ label, before, after }]');
      return;
    }
    if (!Array.isArray(spec.x) || !Array.isArray(spec.series) || !spec.series.length) throw new Error(`${spec.type} charts need x: [...] and series: [{ name, values }]`);
    if (spec.series.length > COLORS.length) throw new Error(`At most ${COLORS.length} series per chart; fold the rest into "Other" or split the chart.`);
    for (const s of spec.series) if (s.values.length !== spec.x.length) throw new Error(`Series "${s.name}" has ${s.values.length} values but x has ${spec.x.length}.`);
  }

  async function mount(fig) {
    let spec;
    try {
      const inline = fig.querySelector('script[type="application/json"]');
      spec = inline ? JSON.parse(inline.textContent) : await (await fetch(fig.dataset.src)).json();
      validate(spec);
    } catch (err) {
      fig.insertAdjacentHTML('afterbegin', `<p class="chart-error">Chart error: ${esc(err.message)}</p>`);
      console.error('chart', fig, err);
      return;
    }
    const caption = fig.querySelector('figcaption');
    const head = document.createElement('div');
    head.className = 'chart-head';
    head.innerHTML = `<div class="chart-title">${spec.title ? `<b>${esc(spec.title)}</b>` : ''}${spec.subtitle ? `<span>${esc(spec.subtitle)}</span>` : ''}</div>` +
      '<button class="btn btn-sm" type="button" aria-pressed="false">Table</button>';
    const plot = document.createElement('div');
    plot.className = 'chart-plot';
    const tableWrap = document.createElement('div');
    tableWrap.hidden = true;
    tableWrap.innerHTML = table(spec);
    fig.prepend(head);
    head.insertAdjacentHTML('afterend', legend(spec));
    (fig.querySelector('.chart-legend') || head).after(plot, tableWrap);
    if (caption) fig.append(caption);

    const btn = head.querySelector('button');
    btn.addEventListener('click', () => {
      const showTable = tableWrap.hidden;
      tableWrap.hidden = !showTable;
      plot.hidden = showTable;
      btn.setAttribute('aria-pressed', String(showTable));
      btn.textContent = showTable ? 'Chart' : 'Table';
    });

    let last = 0;
    const draw = () => {
      const w = Math.round(plot.clientWidth || fig.clientWidth);
      if (!w || w === last) return;
      last = w;
      plot.replaceChildren();
      RENDER[spec.type](plot, spec, w);
    };
    new ResizeObserver(draw).observe(plot);
    draw();
  }

  const start = () => document.querySelectorAll('figure.chart').forEach(mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
