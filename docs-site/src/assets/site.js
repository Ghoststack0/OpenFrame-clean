// Page shell for a.yash0.in sites: top bar, sidebar, table of contents, code blocks, tables and stat tiles.
// Pages stay readable without it; it only adds chrome around <main class="doc-main">.
(function () {
  const SITE = window.SITE || {};
  const main = document.querySelector('main.doc-main');
  const here = location.pathname.split('/').pop() || 'index.html';

  const el = (tag, attrs = {}, html = '') => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (html) node.innerHTML = html;
    return node;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const fmt = (n, digits) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits ?? (Math.abs(n) < 10 ? 2 : Math.abs(n) < 100 ? 1 : 0) });

  if (main) {
    main.id ||= 'main';
    document.body.prepend(el('a', { class: 'skip-link', href: '#' + main.id }, 'Skip to content'));

    // Top bar
    const bar = el('header', { class: 'topbar' });
    bar.innerHTML =
      `<a class="brand" href="./"><img src="assets/favicon.svg" alt=""><span>${esc(SITE.title || document.title)}</span></a>` +
      (SITE.crumb
        ? `<span class="crumb"><a href="${esc(SITE.crumb.href)}">${esc(SITE.crumb.label)}</a></span>`
        : `<span class="crumb"><a href="/">a.yash0.in</a> / ${esc(SITE.slug || '')}</span>`) +
      `<nav>${(SITE.links || []).map((l) => `<a class="btn btn-sm" href="${esc(l.href)}">${esc(l.title)}</a>`).join('')}</nav>`;
    document.body.prepend(bar);

    // Layout grid
    const docs = el('div', { class: 'docs' + (document.body.dataset.layout === 'wide' ? ' wide' : '') });
    main.replaceWith(docs);

    const groups = SITE.nav || [];
    const side = el('aside', { class: 'doc-side', 'aria-label': 'Pages' });
    if (groups.length) {
      const menu = el('details', { class: 'doc-menu' });
      if (matchMedia('(min-width: 861px)').matches) menu.open = true;
      menu.innerHTML =
        '<summary>Pages</summary><nav class="doc-nav">' +
        groups.map((g) =>
          `<div class="doc-nav-group"><p class="cap">${esc(g.group)}</p><ul>` +
          g.items.map((i) => `<li><a href="${esc(i.href)}"${i.href.replace(/^\.\//, '') === here || (i.href === './' && here === 'index.html') ? ' aria-current="page"' : ''}>${esc(i.title)}</a></li>`).join('') +
          '</ul></div>').join('') +
        '</nav>';
      side.append(menu);
      // Keep the menu open on desktop even after a resize from mobile.
      matchMedia('(min-width: 861px)').addEventListener('change', (e) => { if (e.matches) menu.open = true; });
    }
    docs.append(side, main);

    // Headings: ids, anchors, table of contents
    const heads = [...main.querySelectorAll('.doc-body h2, .doc-body h3')];
    for (const h of heads) {
      h.id ||= slugify(h.textContent);
      h.append(el('a', { class: 'doc-anchor', href: '#' + h.id, 'aria-label': 'Link to this section' }, '#'));
    }
    const h2s = heads.filter((h) => h.tagName === 'H2');
    if (h2s.length > 1 && document.body.dataset.layout !== 'wide') {
      const toc = el('aside', { class: 'doc-toc', 'aria-label': 'On this page' });
      toc.innerHTML = '<p class="cap">On this page</p><ul>' + h2s.map((h) => `<li><a href="#${h.id}">${esc(h.firstChild.textContent.trim())}</a></li>`).join('') + '</ul>';
      docs.append(toc);
      const links = new Map([...toc.querySelectorAll('a')].map((a) => [a.hash.slice(1), a]));
      const spy = () => {
        let current = h2s[0];
        for (const h of h2s) if (h.getBoundingClientRect().top < 140) current = h;
        links.forEach((a, id) => a.classList.toggle('on', id === current.id));
      };
      addEventListener('scroll', spy, { passive: true });
      spy();
    }

    // Footer
    const foot = el('footer', { class: 'site-foot' });
    foot.innerHTML = `<span>${esc(SITE.title || '')}${SITE.updated ? ' · updated ' + esc(SITE.updated) : ''}</span>${SITE.footer ? `<a href="${esc(SITE.footer.href)}">${esc(SITE.footer.label)}</a>` : '<a href="/">Hosted on a.yash0.in</a>'}`;
    docs.after(foot);
  }

  // Code blocks: <pre data-title="terminal">…</pre> becomes a captioned figure with copy.
  for (const pre of document.querySelectorAll('.doc-body pre')) {
    if (pre.closest('.code')) continue;
    const fig = el('figure', { class: 'code' });
    const label = pre.dataset.title || pre.dataset.lang || 'code';
    fig.innerHTML = `<figcaption><i></i><i></i><i></i><span>${esc(label)}</span><button class="btn btn-sm" type="button">Copy</button></figcaption>`;
    pre.replaceWith(fig);
    fig.append(pre);
    const btn = fig.querySelector('button');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText.replace(/\n$/, ''));
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Press Ctrl+C';
        getSelection().selectAllChildren(pre);
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1600);
    });
  }

  // Bare tables get the bordered scroll wrapper.
  for (const table of document.querySelectorAll('.doc-body table')) {
    if (table.parentElement.classList.contains('table')) continue;
    const wrap = el('div', { class: 'table' });
    table.replaceWith(wrap);
    wrap.append(table);
  }

  // Stat tiles: <div class="stat" data-label="p95" data-value="168" data-before="412" data-unit="ms" data-better="lower">
  for (const s of document.querySelectorAll('.stat[data-value]')) {
    const { label = '', value, before, unit = '', better = 'lower', note = '' } = s.dataset;
    const v = Number(value);
    let foot = '';
    if (before !== undefined) {
      const b = Number(before);
      const pct = b === 0 ? 0 : ((v - b) / Math.abs(b)) * 100;
      const improved = better === 'higher' ? v > b : v < b;
      const cls = Math.abs(pct) < 0.5 ? 'flat' : improved ? 'good' : 'bad';
      const arrow = cls === 'flat' ? '→' : pct < 0 ? '▼' : '▲';
      const word = cls === 'flat' ? 'no change' : improved ? 'better' : 'worse';
      foot = `<span class="delta ${cls}" title="${word}">${arrow} ${fmt(Math.abs(pct), 1)}% ${word}</span><span>was ${fmt(b)}${esc(unit)}</span>`;
    }
    if (note) foot += `<span>${esc(note)}</span>`;
    s.innerHTML = `<span class="cap">${esc(label)}</span><span class="stat-value">${fmt(v)}${unit ? `<small>${esc(unit)}</small>` : ''}</span>${foot ? `<span class="stat-foot">${foot}</span>` : ''}`;
  }
})();
