/* Proview "Navy" theme: the small bits of markup and behaviour behind navy.css
   - keeps navy.css the last stylesheet in <head> (other scripts add <style> tags at run time)
   - "Proview Employee" brand line, sidebar footer (profile card, Menu at bottom, Light mode)
   - Menu at bottom: a bottom bar built from the left menu's own buttons (same actions)
   - header: eyebrow above the title (menu at bottom), the page's main action as the primary button
   Shared localStorage keys (all Proview apps): "pv.theme" = dark|light, "pv.menu" = side|bottom */
(function () {
  'use strict';
  const root = document.documentElement;
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const I = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    pbottom: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18"/>',
    pside: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  };
  const svg = (k, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;
  const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isLight = () => root.getAttribute('data-theme') === 'light';
  const isBottom = () => root.classList.contains('menu-bottom');

  /* 1. navy.css stays last */
  const sheet = document.getElementById('pv-navy-css');
  function keepLast() { if (sheet && document.head.lastElementChild !== sheet) document.head.appendChild(sheet); }
  keepLast();
  try { new MutationObserver(keepLast).observe(document.head, { childList: true }); } catch (e) {}

  /* 2. brand line */
  const wm = document.querySelector('.side .brand .wordmark');
  if (wm) wm.innerHTML = 'Proview <i>Employee</i>';

  /* 3. switches */
  function syncMeta() {
    const m = document.querySelector('meta[name=theme-color]');
    if (m) m.setAttribute('content', isLight() ? '#f2f4f9' : '#171c29');
  }
  function themeBtnHtml() { return isLight() ? svg('moon', 17) + '<span class="lbl">Dark mode</span><span class="slbl">Dark</span>' : svg('sun', 17) + '<span class="lbl">Light mode</span><span class="slbl">Light</span>'; }
  function syncSwitches() {
    document.querySelectorAll('input[data-bind="settings.dark"]').forEach((c) => { c.checked = !isLight(); });
    document.querySelectorAll('[data-act=pvTheme]').forEach((b) => {
      if (b.classList.contains('pvb-sq')) b.innerHTML = svg(isLight() ? 'moon' : 'sun');
      else b.innerHTML = themeBtnHtml();
      const t = isLight() ? 'Dark mode' : 'Light mode'; b.title = t; b.setAttribute('aria-label', t);
    });
  }
  function setTheme(t) { root.setAttribute('data-theme', t); ls.set('pv.theme', t); syncMeta(); syncSwitches(); }
  A.pvTheme = () => setTheme(isLight() ? 'dark' : 'light');
  // Organization > You > "Dark mode" switch: the same shared theme (not the old per-business setting)
  document.addEventListener('change', (e) => {
    if (!e.target.matches || !e.target.matches('input[data-bind="settings.dark"]')) return;
    e.stopImmediatePropagation(); setTheme(e.target.checked ? 'dark' : 'light');
  }, true);
  A.pvMenu = () => {
    const b = !isBottom();
    root.classList.toggle('menu-bottom', b); ls.set('pv.menu', b ? 'bottom' : 'side');
    document.getElementById('app')?.classList.remove('navopen');
    buildBottom(); renderTop();
  };
  // the app's old dark switch (desktop footer and the phone rail) now flips the shared theme
  A.toggleDark = A.pvTheme; A.mDark = () => { A.navClose && A.navClose(); A.pvTheme(); };

  /* 4. sidebar footer + bottom bar */
  function footer() {
    const f = document.getElementById('sideFoot'); if (!f) return;
    f.querySelectorAll('.pv-mode').forEach((e) => e.remove());
    f.insertAdjacentHTML('beforeend', `<button class="pv-mode" data-act="pvMenu" title="Menu at bottom" aria-label="Menu at bottom">${svg('pbottom', 17)}<span class="lbl">Menu at bottom</span><span class="slbl">Bottom</span></button><button class="pv-mode" data-act="pvTheme"></button>`);
    syncSwitches();
  }
  function buildBottom() {
    let bar = document.getElementById('pvBottom');
    if (!bar) { bar = document.createElement('nav'); bar.id = 'pvBottom'; bar.setAttribute('aria-label', 'Menu'); document.body.appendChild(bar); }
    if (!isBottom()) { bar.innerHTML = ''; return; }
    const nav = document.getElementById('nav'); const items = [];
    if (nav) [...nav.children].forEach((el) => {
      if (el.classList.contains('nav-sec') || el.classList.contains('nav-div')) { if (items.length && items[items.length - 1] !== '<i class="pvb-sec"></i>') items.push('<i class="pvb-sec"></i>'); return; }
      if (el.tagName !== 'BUTTON' || !el.dataset.act || el.dataset.act === 'signOut') return;
      const group = el.classList.contains('nav-group');
      if (group && items.length && items[items.length - 1] !== '<i class="pvb-sec"></i>') items.push('<i class="pvb-sec"></i>');
      const icon = (group ? el.querySelector('.rail-ic') : el.querySelector(':scope > svg, :scope > .gs-ring'));
      const label = (el.querySelector('.lbl')?.textContent || el.title || '').trim();
      const cnt = el.querySelector('.cnt');
      const attrs = [...el.attributes].filter((a) => a.name !== 'class' && a.name !== 'style').map((a) => `${a.name}="${escH(a.value)}"`).join(' ');
      const cls = [...el.classList].filter((c) => c === 'on' || c === 'pe-off' || c === 'pe-all-nav').join(' ');
      items.push(`<button class="${cls}" ${attrs}>${icon ? icon.outerHTML : ''}<span>${escH(label)}</span>${cnt && !group ? `<span class="cnt">${escH(cnt.textContent)}</span>` : ''}</button>`);
    });
    bar.innerHTML = `<div class="pvb-items">${items.join('')}</div><button class="pvb-sq" data-act="pvMenu" title="Menu at side" aria-label="Menu at side">${svg('pside')}</button><button class="pvb-sq" data-act="pvTheme"></button>`;
    syncSwitches();
    const on = bar.querySelector('.pvb-items > button.on');
    if (on && on.scrollIntoView) { const box = bar.querySelector('.pvb-items'); const l = on.offsetLeft - box.clientWidth / 2 + on.offsetWidth / 2; box.scrollLeft = Math.max(0, l); }
  }

  /* 5. header: eyebrow (menu at bottom) and the page's main action as the primary button */
  const MAIN = ['newEntry', 'taskNew', 'newLeave', 'newInvoice', 'newMember', 'editSchedule', 'scNew', 'locManual', 'editLocation', 'apEdit', 'addAP', 'policyEdit', 'addPolicy', 'rotaPublish', 'repExport'];
  function eyebrow() {
    const h = document.querySelector('#top > h2'); if (!h) return;
    let t = '';
    try { const l = U.fLoc && typeof locn === 'function' && locn(U.fLoc); t = (l && l.name) || (S.org && S.org.name) || ''; } catch (e) {}
    h.setAttribute('data-eyebrow', t || 'Proview');
  }
  function hdrPrimary() {
    const top = document.getElementById('top'), content = document.getElementById('content'); if (!top || !content) return;
    top.querySelectorAll('.pv-hdr-pri').forEach((e) => e.remove());
    content.querySelectorAll('.pv-moved').forEach((e) => e.classList.remove('pv-moved'));
    if (document.body.classList.contains('signed-out')) return;
    let src = null;
    for (const a of MAIN) { src = content.querySelector(`.btn.pri[data-act="${a}"]`); if (src) break; }
    if (!src || src.closest('.modal,#drawer,.card .card')) return;
    const b = document.createElement('button');
    b.className = 'btn pri pv-hdr-pri';
    [...src.attributes].forEach((a) => { if (a.name.startsWith('data-') || a.name === 'disabled' || a.name === 'title') b.setAttribute(a.name, a.value); });
    b.innerHTML = src.innerHTML;
    src.classList.add('pv-moved');
    const me = top.querySelector('.top-me');
    if (me) top.insertBefore(b, me); else top.appendChild(b);
  }

  /* 6. hooks */
  const _rn = renderNav;
  renderNav = function () { const r = _rn.apply(this, arguments); footer(); buildBottom(); return r; };
  const _rt = renderTop;
  renderTop = function () { const r = _rt.apply(this, arguments); eyebrow(); hdrPrimary(); return r; };
  const _now = renderNow;
  renderNow = function () { const r = _now.apply(this, arguments); document.body.classList.remove('dark'); eyebrow(); hdrPrimary(); buildBottom(); syncSwitches(); return r; };

  const st = document.createElement('style');
  st.textContent = '@media (min-width:701px){#content .pv-moved{display:none!important}}';
  document.head.insertBefore(st, sheet || null);

  syncMeta();
  try { render(); } catch (e) { try { renderNav(); renderTop(); } catch (e2) {} }
})();
