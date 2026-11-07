/* Proview Employee: data for the shared header tray (hub.js) */
(function () {
  if (!window.PVHub) return;
  const H = window.PVHub;
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const orgKey = () => ((window.PE_ONLINE && window.PE_ONLINE.org) || 'local') + '.' + (S.me || '');
  const staff = () => typeof isStaff === 'function' && isStaff();
  const fmtD = (d) => { try { return fmtDate(d, { day: 'numeric', month: 'short' }); } catch (e) { return d; } };
  const nameOf = (id) => (typeof mem === 'function' && mem(id) && mem(id).name) || 'Someone';
  const visibleChat = () => (S.chat || []).filter((m) => m && !m.deleted && (m.to === 'all' || !m.to || m.by === S.me || m.to === S.me));

  function myTeamIds() {
    if (staff()) return new Set();
    try { return new Set(scopeMembers('managed').map((m) => m.id)); } catch (e) { return new Set(); }
  }
  function inboxRaw() {
    const out = [], team = myTeamIds(), seen = lsGet('pvhub.' + orgKey() + '.inboxSeen') || 0;
    const reqs = (S.timeoff && S.timeoff.requests) || [];
    reqs.filter((r) => r.status === 'pending' && team.has(r.member) && r.member !== S.me).forEach((r) => {
      const p = typeof policy === 'function' ? policy(r.policy) : null;
      out.push({ id: 'req' + r.id, icon: 'page', need: true, at: r.at, unread: true,
        title: `${nameOf(r.member)} asked for ${p ? p.name.toLowerCase() : 'time off'}`,
        sub: `${fmtD(r.start)}${r.end && r.end !== r.start ? ' – ' + fmtD(r.end) : ''}${r.half ? ' (half day)' : ''}${r.note ? ' · ' + r.note : ''}`,
        actions: [
          { label: 'Approve', kind: 'pri', run: () => A.leaveStatus({ dataset: { id: r.id, s: 'approved' } }) },
          { label: 'Decline', kind: 'bad', run: () => A.leaveStatus({ dataset: { id: r.id, s: 'rejected' } }) },
        ],
        open: () => { U.view = 'timeoff'; render(); } });
    });
    reqs.filter((r) => r.member === S.me && r.status !== 'pending' && r.at > Date.now() - 30 * 864e5).forEach((r) => {
      const p = typeof policy === 'function' ? policy(r.policy) : null;
      out.push({ id: 'mine' + r.id, icon: 'check', at: r.decidedAt || r.at, unread: (r.decidedAt || r.at) > seen,
        title: `Your ${p ? p.name.toLowerCase() : 'time off'} was ${r.status === 'approved' ? 'approved' : 'declined'}`,
        sub: `${fmtD(r.start)}${r.end && r.end !== r.start ? ' – ' + fmtD(r.end) : ''}`,
        open: () => { U.view = staff() ? 'sHome' : 'timeoff'; render(); } });
    });
    (S.docs || []).filter((d) => d.member === S.me && !d.viewedAt).forEach((d) => {
      out.push({ id: 'doc' + d.id, icon: 'page', need: true, at: d.at || d.payDate || 0, unread: true,
        title: `New ${d.type === 'P45' ? 'P45' : 'payslip'}`, sub: d.period || d.name || '',
        open: () => { U.view = staff() ? 'sP45' : 'p45s'; render(); } });
    });
    return out.sort((a, b) => (b.need - a.need) || (new Date(b.at) - new Date(a.at)));
  }

  H.init({
    key: orgKey,
    searchItems(q) {
      const out = [], seen = new Set();
      document.querySelectorAll('.side .nav button[data-v]').forEach((b) => {
        const label = b.title || b.querySelector('.lbl')?.textContent || '';
        if (!label || seen.has(label) || (q && !label.toLowerCase().includes(q))) return;
        seen.add(label);
        out.push({ group: 'Pages', icon: 'page', label, run: () => b.click() });
      });
      if (q && !staff()) {
        (typeof activeMembers === 'function' ? activeMembers() : []).filter((m) => [m.name, m.email, m.phone].some((x) => x && String(x).toLowerCase().includes(q))).slice(0, 12)
          .forEach((m) => out.push({ group: 'People', av: true, label: m.name, hint: [m.role, m.email].filter(Boolean).join(' · '), run: () => { try { memberSheet(m.id); } catch (e) { U.view = 'people'; render(); } } }));
      }
      return out;
    },
    chat: {
      me: () => ({ id: S.me }),
      teamName: () => (S.org && S.org.name) || 'Everyone',
      people: () => (typeof activeMembers === 'function' ? activeMembers() : []).map((m) => ({ id: m.id, name: m.name, sub: m.role })),
      cached: () => visibleChat().map((m) => ({ ...m, to: m.to || 'all', byName: nameOf(m.by) })),
      async send(conv, text) {
        if (!S.me) throw new Error('Sign in to send messages');
        S.chat = S.chat || [];
        S.chat.push({ id: (typeof uid === 'function' ? uid() : Math.random().toString(36).slice(2)) + Date.now().toString(36), by: S.me, to: conv || 'all', text, at: Date.now() });
        save();
      },
    },
    inbox: {
      empty: 'Nothing waiting for you. Leave requests and new payslips show up here.',
      items: async () => inboxRaw(),
      count: () => inboxRaw().filter((i) => i.unread).length,
      seen: () => lsSet('pvhub.' + orgKey() + '.inboxSeen', Date.now()),
    },
  });

  // keep the chat panel and badges live when data changes
  const _render = render;
  render = function () { const r = _render.apply(this, arguments); try { H.chatChanged(); } catch (e) {} return r; };
})();
