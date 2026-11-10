(() => {
  'use strict';
  const API = window.JADA_API || { configured: false };

  const DEFAULT_CRITERIA = [
    { key: 'innovation', label: 'الابتكار', desc: 'مستوى الإبداع والابتكار في الحل المقترح، ويشمل التفكير الإبداعي وتقديم حلول غير تقليدية للتحديات المطروحة.', weight: 20 },
    { key: 'impact', label: 'التأثير', desc: 'الأثر المتوقع للحل على المجتمع أو السوق أو الفئة المستهدفة.', weight: 20 },
    { key: 'execution', label: 'التنفيذ والتقنية', desc: 'جودة تنفيذ الحل تقنياً ومدى قابلية تطبيقه في الواقع.', weight: 20 },
    { key: 'market', label: 'ملاءمة السوق', desc: 'مدى توافق الحل مع احتياجات السوق والفئة المستهدفة.', weight: 20 },
    { key: 'presentation', label: 'العرض التقديمي', desc: 'وضوح عرض الفكرة أمام لجنة التحكيم وقوة الإقناع.', weight: 20 }
  ];
  const STATUS = { draft: 'مسودة', open: 'التقييم مفتوح', closed: 'التقييم مغلق' };
  const PLACE = ['', 'المركز الأول', 'المركز الثاني', 'المركز الثالث'];
  const LEVELS5 = ['ضعيف', 'مقبول', 'جيد', 'جيد جداً', 'ممتاز'];
  const levelOf = (v, scale) => v == null ? 'لم يُحدَّد بعد' : LEVELS5[Math.min(4, Math.max(0, Math.ceil(v / scale * 5) - 1))];

  const S = {
    route: 'judge', code: null,
    pub: null, pubErr: false,          // public_state
    js: null, jsErr: null,             // judge_session
    selTeam: null, drafts: {}, dragging: false, deferred: false,
    user: null, isAdmin: false, admin: { events: [], current: null, viewId: null, judges: {}, results: {} },
    adminDraft: null, adminDirty: false, lastReveal: null, loaded: false
  };

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const fmt = (n, d = 1) => (n == null || isNaN(n)) ? '—' : (Math.round(Number(n) * 10 ** d) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });
  const fmtDate = (iso) => {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat('ar-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z')); }
    catch { return iso; }
  };
  let toastT;
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800); };
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const siteBase = () => location.origin + location.pathname;
  const judgeLink = (code) => siteBase() + '#j-' + code;
  const errCode = (err) => String((err && (err.message || err.error_description)) || err || '');
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('نُسخ'); }
    catch {
      const box = el('textarea', { style: 'position:fixed;opacity:0' }); box.value = text; document.body.append(box); box.select();
      try { document.execCommand('copy'); toast('نُسخ'); } catch { toast('تعذّر النسخ'); }
      box.remove();
    }
  }
  function downloadFile(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- data views ----------
  // The event + results shown on live/winners pages and in the header.
  function viewed() {
    if (S.route === 'judge' && S.code) return { event: S.js ? S.js.event : null, results: null };
    if (S.isAdmin && S.admin.viewId) {
      const e = S.admin.events.find((x) => x.id === S.admin.viewId);
      if (e) return { event: { ...e, judges: (S.admin.judges[e.id] || []).map((j) => j.name) }, results: S.admin.results[e.id] || null };
    }
    return S.pub && S.pub.event ? { event: S.pub.event, results: S.pub.results } : { event: null, results: null };
  }
  function tieNotes(rows) {
    const notes = {};
    rows.forEach((r, i) => {
      const o = [rows[i - 1], rows[i + 1]].find((x) => x && x.score === r.score);
      if (!o) return;
      notes[r.id] = o.yes !== r.yes ? 'تعادل في الدرجة، حُسم بأصوات الجدارة'
        : o.spread !== r.spread ? 'تعادل في الدرجة والأصوات، حُسم بتوافق المحكّمين' : 'تعادل تام، القرار للجنة';
    });
    return notes;
  }

  // ---------- loading ----------
  async function loadPublic() {
    try { S.pub = await API.publicState(); S.pubErr = false; } catch { S.pubErr = true; }
  }
  async function loadJudge() {
    if (!S.code) { S.js = null; return; }
    try { S.js = await API.judgeSession(S.code); S.jsErr = S.js ? null : 'invalid'; }
    catch { S.jsErr = 'network'; }
  }
  async function loadAdmin(full) {
    if (!S.isAdmin) return;
    const a = S.admin;
    try {
      const [events, current] = await Promise.all([API.listEvents(), API.getCurrent()]);
      a.events = events || []; a.current = current;
      if (!a.viewId || !a.events.some((e) => e.id === a.viewId)) a.viewId = a.current || (a.events[0] && a.events[0].id) || null;
      if (a.viewId) {
        const tasks = [API.eventResults(a.viewId).then((r) => { a.results[a.viewId] = r; })];
        if (full || !a.judges[a.viewId]) tasks.push(API.listJudges(a.viewId).then((j) => { a.judges[a.viewId] = j || []; }));
        await Promise.all(tasks);
      }
    } catch (err) { console.warn(err); }
  }
  async function refreshAuth() {
    try { S.user = await API.getUser(); } catch { S.user = null; }
    try { S.isAdmin = S.user ? await API.isAdmin() : false; } catch { S.isAdmin = false; }
  }

  let pollT = null, lastSig = '';
  async function poll() {
    clearTimeout(pollT);
    if (!document.hidden) {
      if (S.route === 'judge' && S.code) await loadJudge();
      else if (S.isAdmin) await loadAdmin(false);
      if (!(S.route === 'judge' && S.code)) await loadPublic();
      const sig = JSON.stringify([S.pub, S.js && { e: S.js.event, s: S.js.scores }, S.admin.events, S.admin.current, S.admin.results[S.admin.viewId], S.admin.judges[S.admin.viewId]]);
      if (sig !== lastSig) { lastSig = sig; render(true); }
    }
    const fast = S.route === 'live' || S.route === 'winners';
    pollT = setTimeout(poll, fast ? 4000 : 12000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  // ---------- header ----------
  function renderHeader() {
    const chip = $('#eventChip'); chip.replaceChildren();
    const { event: e } = viewed();
    if (!API.configured) chip.append(el('span', { text: 'لم تُضبط قاعدة البيانات بعد' }));
    else if (!S.loaded) chip.append(el('span', { text: 'جارٍ التحميل…' }));
    else if (!e) chip.append(el('span', { text: 'لا يوجد هاكاثون نشط' }));
    else {
      chip.append(el('b', { text: e.name }));
      if (e.city) chip.append(el('span', { text: '· ' + e.city }));
      chip.append(el('span', { class: 'pill ' + (e.status || 'draft'), text: STATUS[e.status] || STATUS.draft }));
    }
    if (S.isAdmin && S.admin.events.length > 1 && S.route !== 'judge') {
      const sel = el('select', { id: 'viewEvent', 'aria-label': 'عرض هاكاثون' });
      for (const x of S.admin.events) sel.append(el('option', { value: x.id, text: x.name + (x.id === S.admin.current ? ' (النشط)' : ''), selected: x.id === S.admin.viewId }));
      sel.addEventListener('change', async () => {
        if (S.adminDirty) { S.adminDirty = false; }
        S.admin.viewId = sel.value; S.adminDraft = null; S.lastReveal = null;
        await loadAdmin(true); render();
      });
      chip.append(el('label', { class: 'view-as' }, 'عرض:', sel));
    }
    $('#adminTab').hidden = !S.isAdmin;
    document.querySelectorAll('.tab').forEach((t) => {
      if (t.dataset.route === S.route) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
  }

  // ---------- judge: code entry ----------
  function renderCodeEntry(page) {
    page.append(el('div', { class: 'page-head' }, el('div', {},
      el('h1', { text: 'صفحة المحكّم' }),
      el('p', { class: 'lead', text: 'لكل محكّم رابط خاص باسمه يرسله المنظّم. افتح رابطك مباشرة، أو الصق الرابط أو الرمز هنا.' }))));
    const inp = el('input', { type: 'text', id: 'codeInput', placeholder: 'الصق رابطك أو رمزك هنا', autocomplete: 'off', 'aria-label': 'رابط المحكّم أو رمزه' });
    const go = () => {
      const m = /([0-9a-f]{32})/i.exec(inp.value.trim());
      if (!m) { toast('الرمز غير صحيح، تأكد من نسخه كاملاً'); return; }
      location.hash = 'j-' + m[1].toLowerCase();
    };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    page.append(el('div', { class: 'card' }, el('div', { class: 'code-form' }, inp, el('button', { class: 'btn primary', type: 'button', onclick: go }, 'فتح صفحتي'))));
  }

  // ---------- judge: personal page ----------
  function renderJudge(root) {
    const page = el('section', { class: 'page', id: 'judge' });
    root.append(page);
    if (!S.code) return renderCodeEntry(page);
    if (!S.js) {
      page.append(el('div', { class: 'card empty' },
        el('h2', { text: S.jsErr === 'invalid' ? 'هذا الرابط غير صالح' : S.jsErr === 'network' ? 'تعذّر الاتصال' : 'جارٍ تحميل صفحتك…' }),
        S.jsErr === 'invalid' ? el('p', { text: 'ربما حُذف اسمك من قائمة المحكّمين أو نُسخ الرابط ناقصاً. اطلب رابطك من المنظّم.' }) : null,
        S.jsErr === 'network' ? el('p', { text: 'تحقق من اتصالك بالإنترنت؛ ستُعاد المحاولة تلقائياً.' }) : null));
      return;
    }
    const { judge: me, event: e } = S.js;
    const myScores = S.js.scores || {};
    const open = e.status === 'open';
    const done = e.teams.filter((t) => myScores[t.id]).length;
    const total = e.teams.length;

    page.append(el('div', { class: 'judge-hero card' },
      el('div', { class: 'jh-text' },
        el('span', { class: 'muted small', text: 'صفحة المحكّم · ' + e.name }),
        el('h1', { text: 'أهلاً ' + me.name }),
        el('p', { class: 'lead', text: total && done === total ? 'أكملت تقييم جميع المشاريع، شكراً لك. يمكنك مراجعة تقييماتك وتعديلها ما دام التقييم مفتوحاً.' : 'حرّك الشريط لكل معيار، ثم احفظ وانتقل إلى المشروع التالي.' })),
      progressRing(done, total)));

    if (!open) page.append(el('div', { class: 'notice' }, el('p', { text: e.status === 'closed' ? 'أُغلق باب التقييم. يمكنك مراجعة تقييماتك فقط.' : 'لم يُفتح باب التقييم بعد. ستتمكن من التقييم فور فتحه، والصفحة تتحدّث تلقائياً.' })));
    if (!total) { page.append(el('div', { class: 'card empty' }, el('h2', { text: 'لم تُضف المشاريع بعد' }))); return; }

    if (!S.selTeam || !e.teams.some((t) => t.id === S.selTeam)) {
      const first = e.teams.find((t) => !myScores[t.id]);
      S.selTeam = (first || e.teams[0]).id;
    }
    const layout = el('div', { class: 'judge-layout' });
    const list = el('div', { class: 'team-list', role: 'list', 'aria-label': 'المشاريع' });
    e.teams.forEach((t, i) => {
      const fin = !!myScores[t.id];
      const dr = S.drafts[e.id + ':' + t.id];
      const state = fin ? (dr && dr.dirty ? 'تعديل غير محفوظ' : '✓ تم التقييم') : (dr && dr.dirty ? 'مسودة' : 'لم يُقيّم بعد');
      list.append(el('button', {
        type: 'button', class: 'team-btn' + (fin ? ' done' : ''), role: 'listitem', 'aria-pressed': String(S.selTeam === t.id),
        onclick: () => { S.selTeam = t.id; render(); scrollToForm(); }
      },
        el('span', { class: 'num tnum', text: 'فريق ' + (i + 1) }),
        el('span', { class: 'nm', text: t.name }),
        el('span', { class: 'st' + (fin ? ' done' : ''), text: state })));
    });
    layout.append(el('div', { class: 'team-col' }, el('h2', { class: 'col-title', text: 'المشاريع' }), list));
    layout.append(scoreForm(e, myScores, open));
    page.append(layout);
  }
  const scrollToForm = () => { if (window.innerWidth < 860) setTimeout(() => { const f = $('#scoreForm'); if (f) f.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); }, 30); };

  function progressRing(done, total) {
    const r = 30, c = 2 * Math.PI * r, p = total ? done / total : 0, NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 76 76'); svg.setAttribute('class', 'ring'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'قيّمت ' + done + ' من ' + total);
    for (const cls of ['ring-bg', 'ring-fg']) {
      const ci = document.createElementNS(NS, 'circle');
      ci.setAttribute('cx', '38'); ci.setAttribute('cy', '38'); ci.setAttribute('r', String(r)); ci.setAttribute('class', cls);
      if (cls === 'ring-fg') { ci.setAttribute('stroke-dasharray', c.toFixed(1)); ci.setAttribute('stroke-dashoffset', (c * (1 - p)).toFixed(1)); }
      svg.append(ci);
    }
    return el('div', { class: 'ring-wrap' }, svg, el('div', { class: 'ring-label' }, el('b', { class: 'tnum', text: done + '/' + total }), el('span', { text: 'مشروعاً' })));
  }

  function scoreForm(e, myScores, open) {
    const box = el('div', { class: 'card score-form', id: 'scoreForm' });
    const idx = e.teams.findIndex((t) => t.id === S.selTeam);
    const team = e.teams[idx];
    const saved = myScores[team.id];
    const key = e.id + ':' + team.id;
    if (!S.drafts[key]) S.drafts[key] = { v: { ...((saved && saved.v) || {}) }, worthy: saved ? saved.worthy : null, note: (saved && saved.note) || '', dirty: false };
    const d = S.drafts[key];
    const scale = Number(e.scale) || 5;
    const editable = open;
    const wSum = e.criteria.reduce((s, c) => s + Number(c.weight || 0), 0) || 1;
    const prevT = e.teams[(idx - 1 + e.teams.length) % e.teams.length];
    const nextT = e.teams[(idx + 1) % e.teams.length];

    box.append(el('div', { class: 'sf-head' },
      el('div', { style: 'min-width:0' }, el('span', { class: 'muted small tnum', text: 'المشروع ' + (idx + 1) + ' من ' + e.teams.length }), el('h2', { text: team.name })),
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' },
        el('button', { class: 'btn ghost', type: 'button', 'aria-label': 'المشروع السابق', onclick: () => { S.selTeam = prevT.id; render(); } }, '→'),
        el('button', { class: 'btn ghost', type: 'button', 'aria-label': 'المشروع التالي', onclick: () => { S.selTeam = nextT.id; render(); } }, '←'))));

    const totalB = el('b', { class: 'tnum' });
    const saveBtn = el('button', { class: 'btn primary', type: 'button', id: 'saveScore' });
    const hint = el('p', { class: 'small muted', style: 'margin:0' });
    const isReady = () => e.criteria.every((c) => Number.isFinite(Number(d.v[c.key]))) && (d.worthy === true || d.worthy === false);
    const refresh = () => {
      const filled = e.criteria.filter((c) => Number.isFinite(Number(d.v[c.key])));
      totalB.textContent = filled.length ? fmt(filled.reduce((s, c) => s + Number(d.v[c.key]) / scale * c.weight, 0) / wSum * 100) : '—';
      const missing = e.criteria.length - filled.length;
      const noW = !(d.worthy === true || d.worthy === false);
      saveBtn.disabled = !editable || !isReady() || (saved && !d.dirty);
      saveBtn.textContent = saved ? (d.dirty ? 'حفظ التعديل' : 'محفوظ ✓') : 'حفظ التقييم';
      hint.textContent = !editable || isReady() ? '' : 'أكمل ' + [missing ? missing + ' من المعايير' : '', noW ? 'سؤال الجدارة' : ''].filter(Boolean).join(' و') + ' لتفعيل الحفظ.';
      hint.hidden = !hint.textContent;
    };
    const markDraft = () => {
      const btn = document.querySelector('.team-btn[aria-pressed="true"] .st');
      if (btn) btn.textContent = saved ? 'تعديل غير محفوظ' : 'مسودة';
    };

    for (const c of e.criteria) {
      const v = d.v[c.key];
      const has = Number.isFinite(Number(v));
      const range = el('input', { type: 'range', id: 'rng-' + c.key, min: '1', max: String(scale), step: '1', value: String(has ? v : Math.ceil(scale / 2)), disabled: !editable, 'aria-label': c.label });
      const bubble = el('output', { class: 'bubble tnum', for: 'rng-' + c.key, text: has ? String(v) : '—' });
      const level = el('span', { class: 'level', text: levelOf(has ? Number(v) : null, scale) });
      const wrap = el('div', { class: 'slider' + (has ? ' set' : '') });
      const paint = () => wrap.style.setProperty('--p', (scale > 1 ? (Number(range.value) - 1) / (scale - 1) * 100 : 100) + '%');
      const apply = () => {
        const cur = Number(range.value);
        if (d.v[c.key] !== cur || !wrap.classList.contains('set')) { d.v[c.key] = cur; d.dirty = true; markDraft(); }
        wrap.classList.add('set'); bubble.textContent = String(cur); level.textContent = levelOf(cur, scale);
        range.setAttribute('aria-valuetext', cur + ' من ' + scale + '، ' + levelOf(cur, scale));
        paint(); refresh();
      };
      range.addEventListener('input', apply);
      range.addEventListener('pointerdown', () => { S.dragging = true; });
      const end = () => { S.dragging = false; flushDeferred(); };
      range.addEventListener('change', () => { apply(); end(); });
      range.addEventListener('pointerup', () => { if (!wrap.classList.contains('set')) apply(); end(); });
      range.addEventListener('pointercancel', end);
      const ticks = el('div', { class: 'ticks', style: '--n:' + scale });
      for (let i = 1; i <= scale; i++) ticks.append(el('button', { type: 'button', class: 'tick tnum', tabindex: '-1', disabled: !editable, 'aria-hidden': 'true', onclick: () => { range.value = String(i); apply(); } }, String(i)));
      wrap.append(el('div', { class: 'track-row' }, range, bubble), ticks);
      paint();
      if (has) range.setAttribute('aria-valuetext', v + ' من ' + scale + '، ' + levelOf(Number(v), scale));
      box.append(el('div', { class: 'crit' },
        el('div', { class: 'crit-head' }, el('b', { text: c.label }), el('span', { class: 'tnum', text: 'الوزن ' + c.weight + '%' })),
        c.desc ? el('p', { text: c.desc }) : null,
        wrap,
        el('div', { class: 'scale-ends' }, el('span', { text: 'ضعيف' }), level, el('span', { text: 'ممتاز' }))));
    }

    const yes = el('button', { type: 'button', 'data-v': 'yes', 'aria-pressed': String(d.worthy === true), disabled: !editable }, 'نعم، جدير بالفوز');
    const no = el('button', { type: 'button', 'data-v': 'no', 'aria-pressed': String(d.worthy === false), disabled: !editable }, 'لا');
    const setW = (val) => { d.worthy = val; d.dirty = true; yes.setAttribute('aria-pressed', String(val === true)); no.setAttribute('aria-pressed', String(val === false)); markDraft(); refresh(); };
    yes.addEventListener('click', () => setW(true)); no.addEventListener('click', () => setW(false));
    box.append(el('div', { class: 'crit' }, el('div', { class: 'crit-head' }, el('b', { text: 'هل ترى أن المشروع جدير بالفوز؟' })), el('div', { class: 'worthy', role: 'group', 'aria-label': 'جدير بالفوز' }, yes, no)));
    const note = el('textarea', { id: 'note-' + team.id, rows: '2', placeholder: 'ملاحظة للفريق أو للجنة (اختياري)', disabled: !editable });
    note.value = d.note;
    note.addEventListener('input', () => { d.note = note.value; d.dirty = true; markDraft(); refresh(); });
    box.append(note);

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'جارٍ الحفظ…';
      const vals = {}; e.criteria.forEach((c) => { vals[c.key] = Number(d.v[c.key]); });
      try {
        const res = await API.submitScore(S.code, team.id, vals, d.worthy, d.note.trim());
        S.js.scores = { ...S.js.scores, [team.id]: { v: vals, worthy: d.worthy, note: d.note.trim(), at: res && res.at } };
        delete S.drafts[key];
        toast('حُفظ تقييم ' + team.name);
        const nxt = e.teams.slice(idx + 1).concat(e.teams.slice(0, idx)).find((t) => !S.js.scores[t.id]);
        if (nxt) S.selTeam = nxt.id;
        render();
        if (nxt) scrollToForm();
      } catch (err) {
        const m = errCode(err);
        toast(m.includes('not_open') ? 'أُغلق باب التقييم، لم يُحفظ التقييم' : m.includes('invalid_code') ? 'رابطك لم يعد صالحاً، تواصل مع المنظّم' : 'تعذّر الحفظ، تحقق من الاتصال وحاول مرة أخرى');
        if (m.includes('not_open')) { await loadJudge(); render(); } else refresh();
      }
    });
    box.append(el('div', { class: 'form-foot' }, el('span', { class: 'total-preview' }, 'درجة المشروع عندك: ', totalB, ' من 100'), saveBtn), hint);
    refresh();
    return box;
  }
  function flushDeferred() { if (S.deferred) { S.deferred = false; render(true); } }

  // ---------- live ----------
  let lastPositions = new Map();
  const stat = (k, v) => el('div', { class: 'stat' }, el('span', { text: k }), el('b', { text: v }));
  function renderLive(root) {
    const page = el('section', { class: 'page', id: 'live' });
    root.append(page);
    const { event: e, results: R } = viewed();
    if (!e) return page.append(noEvent());
    page.append(el('div', { class: 'page-head' },
      el('div', {}, el('h1', { text: 'النتائج المباشرة' }), el('p', { class: 'lead', text: e.name + (e.city ? ' — ' + e.city : '') })),
      el('span', { class: 'live-dot', text: e.status === 'open' ? 'تحديث مباشر' : 'آخر نتيجة' })));
    if (!R) { page.append(el('div', { class: 'card empty' }, el('h2', { text: 'جارٍ تحميل النتائج…' }))); return; }
    const pct = R.expected ? R.received / R.expected * 100 : 0;
    const top = R.rows && R.rows[0];
    page.append(el('div', { class: 'stats' },
      stat('التقييمات المستلمة', R.received + ' من ' + R.expected),
      stat('المشاريع', String(e.teams.length)),
      stat('المحكّمون النشطون', String(R.judges.filter((j) => j.count > 0).length)),
      stat('متصدّر الترتيب', top && e.live_visible !== false ? top.name : '—')));
    page.append(el('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'نسبة اكتمال التقييم' }, el('i', { style: 'width:' + pct + '%' })));

    const jp = el('div', { class: 'judges-prog' });
    for (const j of R.judges) {
      jp.append(el('div', { class: 'jp' },
        el('div', { class: 'jp-top' }, el('b', { text: j.name }), el('span', { class: 'tnum muted', text: j.count + ' من ' + e.teams.length })),
        el('div', { class: 'bar' }, el('i', { style: 'width:' + (e.teams.length ? Math.min(100, j.count / e.teams.length * 100) : 0) + '%' }))));
    }
    if (R.judges.length) page.append(el('div', {}, el('h2', { class: 'sec-h', text: 'تقدّم لجنة التحكيم' }), jp));

    if (!R.rows) {
      page.append(el('div', { class: 'card empty' }, el('h2', { text: 'الترتيب مخفي حتى الإعلان' }), el('p', { text: 'تابع اكتمال التقييمات أعلاه، وتُعلن النتائج في صفحة الفائزين.' })));
      return;
    }
    if (e.live_visible === false) page.append(el('div', { class: 'notice' }, el('p', { text: 'الترتيب مخفي عن الجمهور ويظهر لك لأنك من المنظّمين. يمكنك إظهاره من الإدارة.' })));
    if (!R.rows.length) {
      page.append(el('div', { class: 'card empty' }, el('h2', { text: 'بانتظار أول تقييم' }), el('p', { text: 'سيظهر ترتيب المشاريع هنا فور حفظ أول تقييم.' })));
      return;
    }
    const notes = tieNotes(R.rows);
    const board = el('div', { class: 'board', id: 'board' });
    for (const r of R.rows) {
      const crit = el('div', { class: 'crit-mini' });
      for (const c of e.criteria) crit.append(el('span', {}, c.label + ' ', el('b', { text: fmt(r.per && r.per[c.key], 1) })));
      board.append(el('div', { class: 'brow' + (r.rank <= 3 ? ' m' + r.rank : ''), 'data-id': r.id },
        el('div', { class: 'rank', text: String(r.rank) }),
        el('div', { class: 'bname' }, el('b', { text: r.name }),
          el('span', { text: 'جدير بالفوز: ' + r.yes + ' من ' + r.n + ' · ' + r.n + ' ' + (r.n === 1 ? 'تقييم' : 'تقييمات') + (notes[r.id] ? ' · ' + notes[r.id] : '') })),
        el('div', { class: 'bscore' }, el('div', { class: 'bar' }, el('i', { style: 'width:' + r.score + '%' })), crit),
        el('div', { class: 'bnum', text: fmt(r.score) })));
    }
    for (const r of (R.unscored || [])) {
      board.append(el('div', { class: 'brow pending', 'data-id': r.id },
        el('div', { class: 'rank', text: '–' }), el('div', { class: 'bname' }, el('b', { text: r.name }), el('span', { text: 'لم يُقيّم بعد' })),
        el('div', { class: 'bscore' }), el('div', { class: 'bnum', text: '—' })));
    }
    page.append(el('div', {}, el('h2', { class: 'sec-h', text: 'ترتيب المشاريع' }), board));
    page.append(el('p', { class: 'small muted', style: 'margin:0', text: 'الدرجة من 100 = مجموع (متوسط المحكّمين للمعيار ÷ ' + e.scale + ' × وزنه). كسر التعادل: أصوات الجدارة ثم توافق المحكّمين. الأرقام بجانب المعايير متوسطات من ' + e.scale + '.' }));
    const judgesActive = R.judges.filter((j) => j.count > 0).length;
    const normTop = [...R.rows].sort((a, b) => a.z_rank - b.z_rank).slice(0, 3);
    if (R.rows.length >= 3 && judgesActive >= 2 && normTop.map((r) => r.id).join() !== R.rows.slice(0, 3).map((r) => r.id).join()) {
      page.append(el('div', { class: 'notice warn' }, el('p', { text: 'للجنة: بعد توحيد مقاييس المحكّمين (لأن بعضهم أكثر تشدداً من غيره) يصبح ترتيب الثلاثة الأوائل: ' + normTop.map((r) => r.name).join('، ثم ') + '. الترتيب الرسمي يبقى وفق الدرجة الموزونة.' })));
    }
    flip(board);
  }
  function flip(board) {
    const now = new Map();
    board.querySelectorAll('.brow').forEach((n) => now.set(n.dataset.id, n));
    requestAnimationFrame(() => {
      const pos = new Map();
      now.forEach((n, id) => pos.set(id, n.getBoundingClientRect().top + window.scrollY));
      if (!reduced() && typeof Element.prototype.animate === 'function') {
        now.forEach((n, id) => {
          const old = lastPositions.get(id), cur = pos.get(id);
          if (old != null && Math.abs(old - cur) > 2) n.animate([{ transform: 'translateY(' + (old - cur) + 'px)' }, { transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2,.8,.2,1)' });
        });
      }
      lastPositions = pos;
    });
  }

  // ---------- winners ----------
  function renderWinners(root) {
    const page = el('section', { class: 'page', id: 'winners' });
    root.append(page);
    const { event: e, results: R } = viewed();
    if (!e) return page.append(noEvent());
    const reveal = Number(e.reveal || 0);
    const stage = el('div', { class: 'stage' });
    stage.append(el('div', { class: 'stage-head' },
      el('span', { class: 'eyebrow', text: [e.city, fmtDate(e.event_date)].filter(Boolean).join(' · ') || 'إعلان النتائج' }),
      el('h1', { text: 'الفائزون في ' + e.name })));
    const pod = el('div', { class: 'podium' });
    for (const p of [1, 2, 3]) {
      const w = R && R.winners.find((x) => x.place === p);
      const shown = reveal >= 4 - p && w && !w.hidden;
      const who = el('div', { class: 'who' });
      if (shown) who.append(el('b', { text: w.name }), el('span', { text: fmt(w.score) + ' من 100 · جدير بالفوز ' + w.yes + '/' + w.n }));
      else who.append(el('span', { class: 'q', text: '؟' }));
      pod.append(el('div', { class: 'slot ' + (shown ? 'revealed' : 'hidden-slot'), 'data-p': String(p) }, who, el('div', { class: 'plinth', 'aria-label': PLACE[p] }, String(p))));
    }
    stage.append(pod, el('p', { class: 'stage-foot', text: reveal >= 3 ? 'مبارك للفائزين، وشكراً لجميع الفرق المشاركة' : 'يُكشف عن الفائزين تباعاً من المركز الثالث إلى الأول' }));
    page.append(stage);

    if (S.isAdmin && R) {
      const rows = R.rows || [];
      const notes = tieNotes(rows);
      const fullTie = rows.filter((r) => r.rank <= 3 && (notes[r.id] || '').startsWith('تعادل تام')).map((r) => r.name);
      const ctl = el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px' });
      ctl.append(el('div', { class: 'sec-title' }, el('h2', { text: 'التحكم في الإعلان' }), el('span', { class: 'small muted', text: 'يظهر للمنظّمين فقط' })));
      if (e.status === 'open') ctl.append(el('div', { class: 'notice warn' }, el('p', { text: 'التقييم ما زال مفتوحاً. يُفضّل إغلاقه من الإدارة قبل الإعلان حتى لا تتغيّر النتائج.' })));
      if (R.scored_count < 3) ctl.append(el('p', { class: 'muted', style: 'margin:0', text: 'يلزم تقييم ثلاثة مشاريع على الأقل قبل الإعلان.' }));
      if (fullTie.length) ctl.append(el('div', { class: 'notice warn' }, el('p', { text: 'يوجد تعادل تام ضمن المراكز الثلاثة الأولى: ' + fullTie.join(' و') + '. يُرجى حسمه قبل الإعلان.' })));
      const nextLabel = ['اكشف المركز الثالث', 'اكشف المركز الثاني', 'اكشف المركز الأول'][reveal];
      ctl.append(el('div', { class: 'reveal-ctl' },
        reveal < 3 ? el('button', { class: 'btn primary', type: 'button', id: 'revealNext', disabled: R.scored_count < 3, onclick: () => patchEvent(e.id, { reveal: reveal + 1 }) }, nextLabel) : null,
        reveal > 0 ? el('button', { class: 'btn', type: 'button', onclick: () => patchEvent(e.id, { reveal: 0 }) }, 'إخفاء الفائزين') : null));
      ctl.append(el('p', { class: 'small muted', style: 'margin:0', text: 'افتح صفحة الفائزين على شاشة القاعة؛ كل كشف هنا يظهر عليها خلال ثوانٍ.' }));
      page.append(ctl);
    }
    if (S.lastReveal != null && reveal > S.lastReveal && !reduced()) confetti(stage, reveal === 3 ? 260 : 120);
    S.lastReveal = reveal;
  }
  function confetti(host, count) {
    const c = el('canvas', { class: 'confetti', 'aria-hidden': 'true' });
    host.append(c);
    const dpr = window.devicePixelRatio || 1;
    const w = c.width = host.clientWidth * dpr, h = c.height = host.clientHeight * dpr;
    const ctx = c.getContext('2d');
    const cs = getComputedStyle(document.documentElement);
    const cols = ['--gold', '--accent', '--silver', '--bronze', '--stage-fg'].map((v) => cs.getPropertyValue(v).trim() || '#fff');
    const ps = Array.from({ length: count }, () => ({ x: w / 2 + (Math.random() - .5) * w * .3, y: h * .65, vx: (Math.random() - .5) * 14 * dpr, vy: -(8 + Math.random() * 12) * dpr, s: (4 + Math.random() * 5) * dpr, r: Math.random() * 6, c: cols[Math.floor(Math.random() * cols.length)] }));
    let t = 0;
    const tick = () => {
      ctx.clearRect(0, 0, w, h); t++;
      for (const p of ps) { p.vy += .35 * dpr; p.x += p.vx; p.y += p.vy; p.vx *= .99; p.r += .15; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); }
      if (t < 160) requestAnimationFrame(tick); else c.remove();
    };
    requestAnimationFrame(tick);
  }

  // ---------- admin ----------
  function renderLogin(page) {
    page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', { text: 'دخول المنظّمين' }),
      el('p', { class: 'lead', text: 'هذه الصفحة لإدارة الهاكاثونات. يستخدم المحكّمون روابطهم الخاصة ولا يحتاجون إلى تسجيل الدخول.' }))));
    const email = el('input', { type: 'email', id: 'loginEmail', autocomplete: 'username', placeholder: 'name@example.com', dir: 'ltr' });
    const pass = el('input', { type: 'password', id: 'loginPass', autocomplete: 'current-password', dir: 'ltr' });
    const err = el('p', { class: 'err', hidden: true });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, 'دخول');
    const form = el('form', { class: 'card login' },
      el('label', { class: 'f' }, 'البريد الإلكتروني', email),
      el('label', { class: 'f' }, 'كلمة المرور', pass), err, btn);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault(); err.hidden = true; btn.disabled = true;
      try {
        await API.signIn(email.value.trim(), pass.value);
        await refreshAuth();
        if (S.isAdmin) { await loadAdmin(true); toast('أهلاً بك'); }
        render();
      } catch { err.textContent = 'البريد أو كلمة المرور غير صحيحة.'; err.hidden = false; }
      btn.disabled = false;
    });
    page.append(form);
  }
  function blankEvent() {
    return { id: null, name: '', city: '', event_date: new Date().toISOString().slice(0, 10), scale: 5, status: 'draft', live_visible: true, criteria: DEFAULT_CRITERIA.map((c) => ({ ...c })), teams: [], judges: [] };
  }
  function draftFrom(e) {
    const d = JSON.parse(JSON.stringify(e));
    d.judges = (S.admin.judges[e.id] || []).map((j) => ({ id: j.id, name: j.name, code: j.code }));
    d.removedJudges = [];
    return d;
  }
  function renderAdmin(root) {
    const page = el('section', { class: 'page', id: 'admin' });
    root.append(page);
    if (!S.user) return renderLogin(page);
    if (!S.isAdmin) {
      page.append(el('div', { class: 'card empty' }, el('h2', { text: 'حسابك ليس ضمن المنظّمين' }),
        el('p', { text: 'سجّلت الدخول بالبريد ' + (S.user.email || '') + '. أضفه إلى جدول المنظّمين (admins) في Supabase كما في دليل الإعداد.' }),
        el('button', { class: 'btn', type: 'button', onclick: async () => { await API.signOut(); await refreshAuth(); render(); } }, 'تسجيل الخروج')));
      return;
    }
    const a = S.admin;
    const e = a.events.find((x) => x.id === a.viewId) || null;
    if (!S.adminDraft) S.adminDraft = e ? draftFrom(e) : blankEvent();
    const d = S.adminDraft;
    const mark = () => { S.adminDirty = true; updateSaveBar(); };

    page.append(el('div', { class: 'page-head' },
      el('div', {}, el('h1', { text: 'إدارة الهاكاثون' }), el('p', { class: 'lead', text: 'أنشئ هاكاثوناً جديداً لكل فعالية، وحدّد المعايير والأوزان والمشاريع والمحكّمين، ثم افتح باب التقييم.' })),
      el('div', { class: 'row' },
        el('button', { class: 'btn', type: 'button', onclick: () => { S.adminDraft = blankEvent(); S.adminDirty = true; render(); } }, '+ هاكاثون جديد'),
        el('button', { class: 'btn ghost', type: 'button', onclick: async () => { await API.signOut(); S.adminDraft = null; S.adminDirty = false; await refreshAuth(); render(); } }, 'خروج'))));

    const grid = el('div', { class: 'admin-grid' });
    const left = el('div', { class: 'stack' }), right = el('div', { class: 'stack' });
    grid.append(left, right); page.append(grid);

    // Basic info
    const fName = el('input', { type: 'text', id: 'evName', placeholder: 'مثال: جادة ثون مكة المكرمة' }); fName.value = d.name;
    fName.addEventListener('input', () => { d.name = fName.value; mark(); });
    const fCity = el('input', { type: 'text', id: 'evCity', placeholder: 'المدينة أو الفرع' }); fCity.value = d.city || '';
    fCity.addEventListener('input', () => { d.city = fCity.value; mark(); });
    const fDate = el('input', { type: 'date', id: 'evDate' }); fDate.value = d.event_date || '';
    fDate.addEventListener('change', () => { d.event_date = fDate.value || null; mark(); });
    const fScale = el('select', { id: 'evScale' }, ...[5, 10].map((n) => el('option', { value: String(n), text: 'من 1 إلى ' + n, selected: Number(d.scale) === n })));
    fScale.addEventListener('change', () => { d.scale = Number(fScale.value); mark(); });
    left.append(el('div', { class: 'card' },
      el('div', { class: 'sec-title' }, el('h2', { text: d.id ? 'بيانات الهاكاثون' : 'هاكاثون جديد' })),
      el('div', { class: 'fields' },
        el('label', { class: 'f', style: 'grid-column:1/-1' }, 'اسم الهاكاثون', fName),
        el('label', { class: 'f' }, 'المدينة', fCity),
        el('label', { class: 'f' }, 'التاريخ', fDate),
        el('label', { class: 'f' }, 'مقياس التقييم', fScale))));

    // Criteria
    const sumEl = el('span', { class: 'weight-sum' });
    const updSum = () => { const s = d.criteria.reduce((x, c) => x + Number(c.weight || 0), 0); sumEl.textContent = 'مجموع الأوزان: ' + s + '%'; sumEl.classList.toggle('bad', s !== 100); };
    const cl = el('div', { class: 'list-edit' });
    d.criteria.forEach((c, i) => {
      const lab = el('input', { type: 'text', id: 'crit-l-' + i, 'aria-label': 'اسم المعيار', placeholder: 'اسم المعيار' }); lab.value = c.label;
      lab.addEventListener('input', () => { c.label = lab.value; mark(); });
      const wt = el('input', { type: 'number', id: 'crit-w-' + i, min: '0', max: '100', 'aria-label': 'الوزن %' }); wt.value = c.weight;
      wt.addEventListener('input', () => { c.weight = Number(wt.value) || 0; updSum(); mark(); });
      const ds = el('textarea', { id: 'crit-d-' + i, 'aria-label': 'وصف المعيار', placeholder: 'وصف يساعد المحكّم على فهم المعيار' }); ds.value = c.desc || '';
      ds.addEventListener('input', () => { c.desc = ds.value; mark(); });
      cl.append(el('div', { class: 'crit-row' }, lab, wt,
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'حذف المعيار', disabled: d.criteria.length <= 1, onclick: () => { d.criteria.splice(i, 1); mark(); render(); } }, '✕'), ds));
    });
    left.append(el('div', { class: 'card' },
      el('div', { class: 'sec-title' }, el('h2', { text: 'معايير التقييم وأوزانها' }), sumEl), cl,
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'btn ghost', type: 'button', onclick: () => { d.criteria.push({ key: 'c' + Date.now().toString(36), label: '', desc: '', weight: 0 }); mark(); render(); } }, '+ إضافة معيار'),
        el('button', { class: 'btn ghost', type: 'button', onclick: () => { const n = d.criteria.length, base = Math.floor(100 / n); d.criteria.forEach((c, i) => { c.weight = base + (i < 100 - base * n ? 1 : 0); }); mark(); render(); } }, 'توزيع الأوزان بالتساوي')),
      d.id ? el('p', { class: 'small muted', style: 'margin:10px 0 0', text: 'تغيير المعايير بعد بدء التقييم يجعل التقييمات السابقة غير مكتملة حتى يعيدها المحكّمون.' }) : null));
    updSum();

    // Teams
    const tl = el('div', { class: 'list-edit' });
    d.teams.forEach((t, i) => {
      const inp = el('input', { type: 'text', id: 'team-' + t.id, 'aria-label': 'اسم المشروع ' + (i + 1) }); inp.value = t.name;
      inp.addEventListener('input', () => { t.name = inp.value; mark(); });
      tl.append(el('div', { class: 'le-row' }, el('span', { class: 'idx', text: String(i + 1) }), inp,
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'حذف المشروع', onclick: () => { d.teams.splice(i, 1); mark(); render(); } }, '✕')));
    });
    const bulk = el('textarea', { id: 'teamsBulk', rows: '3', placeholder: 'أضف عدة مشاريع دفعة واحدة: اسم في كل سطر' });
    right.append(el('div', { class: 'card' },
      el('div', { class: 'sec-title' }, el('h2', { text: 'المشاريع المشاركة' }), el('span', { class: 'small muted tnum', text: d.teams.length + ' مشروعاً' })),
      tl, el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:12px' }, bulk,
        el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: () => {
          const names = bulk.value.split('\n').map((s) => s.trim()).filter(Boolean);
          names.forEach((n, k) => d.teams.push({ id: 't' + Date.now().toString(36) + k, name: n }));
          if (names.length) { mark(); render(); }
        } }, 'إضافة المشاريع'), el('span', { class: 'small muted', text: 'تعديل اسم مشروع لا يمس درجاته؛ حذفه يخفي درجاته من النتائج.' })))));

    // Judges
    const progress = new Map(((e && a.results[e.id] && a.results[e.id].judges) || []).map((j) => [j.name, j.count]));
    const countIn = el('input', { type: 'number', id: 'judgeCount', min: '0', max: '60', style: 'width:84px', 'aria-label': 'عدد المحكّمين' });
    countIn.value = d.judges.length;
    countIn.addEventListener('change', () => {
      const n = Math.max(0, Math.min(60, Math.round(Number(countIn.value) || 0)));
      while (d.judges.length < n) d.judges.push({ id: null, name: '' });
      while (d.judges.length > n) { const r = d.judges.pop(); if (r.id) d.removedJudges.push(r.id); }
      mark(); render();
    });
    const jl = el('div', { class: 'list-edit' });
    d.judges.forEach((j, i) => {
      const inp = el('input', { type: 'text', id: 'judge-' + i, placeholder: 'اسم المحكّم ' + (i + 1), 'aria-label': 'اسم المحكّم ' + (i + 1) }); inp.value = j.name;
      inp.addEventListener('input', () => { j.name = inp.value; mark(); });
      const c = j.id ? (progress.get(j.name) || 0) : null;
      jl.append(el('div', { class: 'le-row judge' },
        el('span', { class: 'idx', text: String(i + 1) }), inp,
        el('span', { class: 'small muted tnum jstat', style: 'white-space:nowrap', text: c == null ? 'جديد' : 'قيّم ' + c + '/' + ((e && e.teams.length) || 0) }),
        j.code ? el('button', { class: 'btn ghost small', type: 'button', onclick: () => copyText(judgeLink(j.code)) }, 'نسخ رابطه') : el('span', { class: 'small muted', text: 'احفظ لإنشاء رابطه' }),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'حذف المحكّم', onclick: () => { const r = d.judges.splice(i, 1)[0]; if (r.id) d.removedJudges.push(r.id); mark(); render(); } }, '✕')));
    });
    if (!d.judges.length) jl.append(el('p', { class: 'muted small', style: 'margin:0', text: 'لا يوجد محكّمون بعد. حدّد العدد أو أضف الأسماء.' }));
    const jBulk = el('textarea', { id: 'judgesBulk', rows: '2', placeholder: 'أضف عدة أسماء دفعة واحدة: اسم في كل سطر' });
    const jCard = el('div', { class: 'card', id: 'judgesCard' },
      el('div', { class: 'sec-title' }, el('h2', { text: 'لجنة التحكيم' }), el('label', { class: 'row small muted', style: 'gap:8px' }, 'عدد المحكّمين', countIn)),
      jl,
      el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:12px' },
        el('div', { class: 'row' }, el('button', { class: 'btn ghost', type: 'button', onclick: () => { d.judges.push({ id: null, name: '' }); mark(); render(); const ins = document.querySelectorAll('#judgesCard .le-row input'); if (ins.length) ins[ins.length - 1].focus(); } }, '+ إضافة محكّم')),
        jBulk,
        el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: () => {
          const names = jBulk.value.split('\n').map((x) => x.trim()).filter(Boolean);
          const empties = d.judges.filter((j) => !j.name.trim());
          names.forEach((n) => { if (empties.length) empties.shift().name = n; else d.judges.push({ id: null, name: n }); });
          if (names.length) { mark(); render(); }
        } }, 'إضافة الأسماء'))));
    const saved = (S.admin.judges[d.id] || []).filter((j) => j.code);
    if (d.id && saved.length) jCard.append(el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', { class: 'btn', type: 'button', onclick: () => copyText(saved.map((j) => j.name + ': ' + judgeLink(j.code)).join('\n')) }, 'نسخ روابط جميع المحكّمين')));
    if (e && a.results[e.id]) {
      const listed = new Set((S.admin.judges[e.id] || []).map((j) => j.name));
      const extra = a.results[e.id].judges.filter((j) => !listed.has(j.name) && j.count > 0);
      if (extra.length) jCard.append(el('div', { class: 'notice warn', style: 'margin-top:12px' }, el('p', { text: 'تقييمات محفوظة لمحكّمين حُذفوا من القائمة وما زالت تُحتسب: ' + extra.map((j) => j.name + ' (' + j.count + ')').join('، ') + '.' })));
    }
    jCard.append(el('p', { class: 'small muted', style: 'margin:12px 0 0', text: 'لكل محكّم رابط خاص باسمه؛ أرسله له ليقيّم مباشرة دون تسجيل دخول. تصحيح اسم المحكّم يبقي رابطه وتقييماته، وحذفه يلغي رابطه مع بقاء تقييماته محسوبة.' }));
    right.append(jCard);

    // Status
    const stSel = el('select', { id: 'evStatus' }, ...Object.entries(STATUS).map(([k, v]) => el('option', { value: k, text: v, selected: d.status === k })));
    stSel.addEventListener('change', () => { d.status = stSel.value; mark(); });
    const lv = el('input', { type: 'checkbox', id: 'liveVisible' }); lv.checked = d.live_visible !== false;
    lv.addEventListener('change', () => { d.live_visible = lv.checked; mark(); });
    right.append(el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px' },
      el('div', { class: 'sec-title' }, el('h2', { text: 'حالة التقييم والعرض' })),
      el('label', { class: 'f' }, 'حالة التقييم', stSel),
      el('label', { class: 'switch' }, lv, 'إظهار الترتيب للجمهور في صفحة النتائج المباشرة')));

    // Save bar
    const note = el('span', { class: 'small muted', id: 'dirtyNote' });
    const discard = el('button', { class: 'btn ghost', type: 'button', id: 'discardEvent', onclick: () => { S.adminDraft = null; S.adminDirty = false; render(); } }, 'تجاهل التعديلات');
    page.append(el('div', { class: 'card row', id: 'saveBar', style: 'justify-content:space-between' }, note,
      el('div', { class: 'row' }, discard,
        d.id && a.current !== d.id ? el('button', { class: 'btn', type: 'button', onclick: () => setCurrent(d.id) }, 'جعله الهاكاثون النشط') : null,
        el('button', { class: 'btn primary', type: 'button', id: 'saveEvent', onclick: () => saveEvent(d) }, d.id ? 'حفظ التعديلات' : 'إنشاء الهاكاثون'))));
    function updateSaveBar() {
      note.textContent = S.adminDirty ? 'لديك تعديلات غير محفوظة' : (d.id ? 'كل التعديلات محفوظة' : '');
      discard.hidden = !S.adminDirty;
    }
    updateSaveBar();

    // Events + export
    const evl = el('div', { class: 'events-list' });
    for (const x of a.events) {
      evl.append(el('button', { class: 'ev-item', type: 'button', 'aria-pressed': String(x.id === a.viewId), onclick: async () => { a.viewId = x.id; S.adminDraft = null; S.adminDirty = false; await loadAdmin(true); render(); } },
        el('span', {}, el('b', { text: x.name }), ' ', el('small', { text: [x.city, fmtDate(x.event_date)].filter(Boolean).join(' · ') })),
        el('span', { class: 'pill ' + (x.status || 'draft'), text: x.id === a.current ? 'النشط' : (STATUS[x.status] || '') })));
    }
    if (!a.events.length) evl.append(el('p', { class: 'muted', style: 'margin:0', text: 'لا توجد هاكاثونات بعد.' }));
    const ex = el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px' }, el('div', { class: 'sec-title' }, el('h2', { text: 'التصدير والروابط' })));
    if (e && d.id) ex.append(el('div', { class: 'row' },
      el('button', { class: 'btn', type: 'button', onclick: () => exportCsv(e, 'ranking') }, 'تنزيل الترتيب (CSV)'),
      el('button', { class: 'btn', type: 'button', onclick: () => exportCsv(e, 'raw') }, 'تنزيل كل التقييمات (CSV)')));
    ex.append(el('div', { class: 'link-box' },
      el('span', { text: 'شاشة القاعة (النتائج المباشرة):' }), el('code', { text: siteBase() + '#live' }),
      el('span', { text: 'شاشة إعلان الفائزين:' }), el('code', { text: siteBase() + '#winners' }),
      el('span', { class: 'muted', text: 'روابط المحكّمين في قسم لجنة التحكيم أعلاه. الصفحات العامة تعرض الهاكاثون النشط دائماً.' })));
    page.append(el('div', { class: 'admin-grid' }, el('div', { class: 'card' }, el('div', { class: 'sec-title' }, el('h2', { text: 'كل الهاكاثونات' })), evl), ex));
  }

  async function saveEvent(d) {
    if (!d.name.trim()) { toast('اكتب اسم الهاكاثون أولاً'); return; }
    if (d.criteria.some((c) => !c.label.trim())) { toast('اكتب اسم كل معيار'); return; }
    if (d.criteria.reduce((a, c) => a + Number(c.weight || 0), 0) !== 100) { toast('مجموع الأوزان يجب أن يكون 100%'); return; }
    const btn = $('#saveEvent'); if (btn) btn.disabled = true;
    const row = {
      name: d.name.trim(), city: (d.city || '').trim(), event_date: d.event_date || null, scale: Number(d.scale) || 5,
      status: d.status, live_visible: d.live_visible !== false,
      criteria: d.criteria.map((c) => ({ key: c.key, label: c.label.trim(), desc: (c.desc || '').trim(), weight: Number(c.weight) || 0 })),
      teams: d.teams.filter((t) => t.name.trim()).map((t) => ({ id: t.id, name: t.name.trim() }))
    };
    try {
      let id = d.id;
      if (id) await API.updateEvent(id, row);
      else { const created = await API.createEvent(row); id = created.id; }
      const judges = d.judges.filter((j) => j.name.trim()).map((j, i) => ({ id: j.id, name: j.name.trim(), position: i }));
      const removed = (d.removedJudges || []).concat(d.judges.filter((j) => j.id && !j.name.trim()).map((j) => j.id));
      await API.syncJudges(id, judges, removed);
      if (!d.id && !S.admin.current) await API.setCurrent(id);
      S.admin.viewId = id; S.adminDraft = null; S.adminDirty = false;
      await loadAdmin(true); await loadPublic();
      toast(d.id ? 'حُفظت التعديلات' : 'أُنشئ الهاكاثون');
      render();
    } catch (err) { console.warn(err); toast('تعذّر الحفظ: ' + errCode(err)); if (btn) btn.disabled = false; }
  }
  async function patchEvent(id, patch) {
    try { await API.updateEvent(id, patch); await loadAdmin(false); await loadPublic(); render(); }
    catch (err) { toast('تعذّر التحديث: ' + errCode(err)); }
  }
  async function setCurrent(id) {
    try { await API.setCurrent(id); await loadAdmin(false); await loadPublic(); toast('أصبح الهاكاثون النشط للجميع'); render(); }
    catch (err) { toast('تعذّر التحديث: ' + errCode(err)); }
  }
  async function exportCsv(e, kind) {
    const q = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    let rows;
    try {
      if (kind === 'ranking') {
        const R = S.admin.results[e.id] || await API.eventResults(e.id);
        const notes = tieNotes(R.rows || []);
        rows = [['المركز', 'المشروع', 'الدرجة من 100', ...e.criteria.map((c) => c.label + ' (متوسط)'), 'جدير بالفوز', 'عدد التقييمات', 'ملاحظة']];
        for (const r of R.rows || []) rows.push([r.rank, r.name, r.score, ...e.criteria.map((c) => fmt(r.per && r.per[c.key], 2)), r.yes, r.n, notes[r.id] || '']);
      } else {
        const raw = await API.rawScores(e.id);
        const tname = new Map(e.teams.map((t) => [t.id, t.name]));
        rows = [['المحكّم', 'المشروع', ...e.criteria.map((c) => c.label), 'جدير بالفوز', 'ملاحظة', 'وقت الحفظ']];
        for (const s of raw || []) rows.push([s.judge_name, tname.get(s.team_id) || s.team_id, ...e.criteria.map((c) => (s.vals || {})[c.key] ?? ''), s.worthy ? 'نعم' : 'لا', s.note || '', s.updated_at || '']);
      }
      downloadFile((e.name || 'hackathon') + (kind === 'ranking' ? ' - الترتيب' : ' - التقييمات') + '.csv', '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'));
    } catch (err) { toast('تعذّر التصدير: ' + errCode(err)); }
  }

  function noEvent() {
    return el('div', { class: 'card empty' },
      el('h2', { text: !S.loaded ? 'جارٍ التحميل…' : S.pubErr ? 'تعذّر الاتصال بقاعدة البيانات' : 'لا يوجد هاكاثون نشط حالياً' }),
      S.loaded && !S.pubErr ? el('p', { text: S.isAdmin ? 'أنشئ أول هاكاثون من صفحة الإدارة.' : 'سيظهر هنا عندما يفعّله المنظّم.' }) : null,
      S.loaded && S.isAdmin ? el('a', { class: 'btn primary', href: '#admin' }, 'الانتقال إلى الإدارة') : null);
  }
  function notConfigured(root) {
    root.append(el('section', { class: 'page' }, el('div', { class: 'card empty' },
      el('h2', { text: 'المنصة غير مرتبطة بقاعدة البيانات بعد' }),
      el('p', { text: 'افتح الملف config.js وضع فيه رابط مشروع Supabase ومفتاح anon، كما في دليل الإعداد (README).' }))));
  }

  // ---------- render & routing ----------
  function render(fromData) {
    const main = $('#main');
    if (fromData === true) {
      if (S.route === 'admin' && S.adminDirty && main.querySelector('#admin')) { renderHeader(); return; }
      const ae = document.activeElement;
      if (S.route === 'judge' && (S.dragging || (ae && ae.tagName === 'TEXTAREA' && ae.closest('#scoreForm')))) { S.deferred = true; return; }
      if (S.route === 'admin' && ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && main.contains(ae)) { renderHeader(); return; }
    }
    const keepY = window.scrollY;
    const active = document.activeElement && document.activeElement.id;
    renderHeader();
    main.replaceChildren();
    if (!API.configured) notConfigured(main);
    else if (S.route === 'live') renderLive(main);
    else if (S.route === 'winners') renderWinners(main);
    else if (S.route === 'admin') renderAdmin(main);
    else renderJudge(main);
    if (active) { const n = document.getElementById(active); if (n) n.focus({ preventScroll: true }); }
    window.scrollTo(0, keepY);
  }
  async function route() {
    const h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    const jm = /^j-([0-9a-f]{32})$/i.exec(h);
    const prevCode = S.code;
    S.code = jm ? jm[1].toLowerCase() : null;
    S.route = jm ? 'judge' : (['judge', 'live', 'winners', 'admin'].includes(h) ? h : 'judge');
    if (S.code !== prevCode) { S.js = null; S.jsErr = null; S.selTeam = null; }
    S.lastReveal = null;
    render();
    window.scrollTo(0, 0);
    if (API.configured && S.loaded) { lastSig = ''; await poll(); }
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('focusout', () => setTimeout(flushDeferred, 0));
  window.addEventListener('beforeunload', (ev) => {
    if (S.adminDirty || Object.values(S.drafts).some((x) => x.dirty)) { ev.preventDefault(); ev.returnValue = ''; }
  });

  async function boot() {
    await route();
    if (!API.configured) return;
    await refreshAuth();
    if (API.onAuth) API.onAuth(async (u) => {
      const changed = (u && u.id) !== (S.user && S.user.id);
      if (!changed) return;
      await refreshAuth(); if (S.isAdmin) await loadAdmin(true); render();
    });
    const tasks = [loadPublic()];
    if (S.isAdmin) tasks.push(loadAdmin(true));
    if (S.code) tasks.push(loadJudge());
    await Promise.all(tasks);
    S.loaded = true;
    render();
    lastSig = '';
    pollT = setTimeout(poll, 4000);
  }
  boot();
})();
