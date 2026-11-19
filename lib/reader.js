/* Lib.reader - PDF reader with selectable text and persistent highlight overlays.
 *
 *   var r = Lib.reader.mount(containerEl, { night:true, onSelection, onPage, onHighlightTap, onReady, onError });
 *   r.load(arrayBuffer | Blob | File | Uint8Array | url)  -> Promise<{numPages, title, fingerprint}>
 *   r.setHighlights([{id, page, rects:[[x,y,w,h]], hl}])  r.goTo(page, {highlightId, smooth})
 *   r.page()  r.numPages()  r.setZoom('fit'|number)  r.zoomBy(+1|-1)  r.setNight(bool)
 *   r.getText(page) -> Promise<string>   r.destroy()
 * Extras: r.clearSelection() r.getSelection() r.promptGoTo() r.zoom() r.night() r.whenIdle() r.stats() r.el, options onZoom({mode,scale,percent}),
 *   onPageError(msg, page) (a page would not draw: shown quietly in the reader, never through onError) and onNoText(page) (a drag or long press on a scanned page with no text).
 * sel may carry clipped:{kept,through} when the drag ran on past the first page (only the part on page `kept` is returned; the reader says so).
 * onError(msg, {fatal:true}) is only for a file that cannot be opened; load() rejects with the same message.
 * load() resolves null when a newer load() or destroy() replaced it; otherwise it rejects with an Error whose message is plain words.
 * In 'fit' mode every page is fitted to the width on its own; a number zoom uses one scale for all pages.
 *
 * Needs window.pdfjsLib (PDF.js 3.11.x, with workerSrc set by the page). ES5, no other dependencies.
 * Layers inside every page, bottom to top: canvas, highlight overlay, transparent text layer.
 * Highlight rects are stored as fractions of the page box, so they follow zoom and resize for free.
 */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : globalThis;
  root.Lib = root.Lib || {};

  var PDFJS_VER = '3.11.174';
  var WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.worker.min.js';
  var CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VER + '/cmaps/';
  var FONT_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VER + '/standard_fonts/';

  var PAD_Y = 14;            // space above the first and below the last page (css px)
  var GAP = 12;              // space between pages
  var MIN_ZOOM = 0.25, MAX_ZOOM = 5;
  var DPR_CAP = 2.5;
  var MAX_CANVAS_PX = 10000000;   // per canvas; iOS Safari refuses canvases above ~16.7M pixels
  var MAX_CANVAS_SIDE = 16000;    // longest canvas side in pixels (browsers stop at 16384 or 32767)
  var MAX_PARALLEL = 2;           // page renders in flight at once
  var HL_KINDS = { idea: 1, evidence: 1, quote: 1, question: 1 };

  /* ------------------------------------------------------------------ */
  /* CSS (injected once). Colours come from the site's variables, with   */
  /* the night palette as fallback.                                      */
  /* ------------------------------------------------------------------ */
  var CSS = [
    '.lib-reader{position:relative;overflow:hidden;background:var(--lib-gutter,var(--paper,#17113a));color:var(--ink,#F2EEFF);',
    '  --lib-surface:var(--surface,#211852);--lib-cream:#E9E1CF;--lib-accent:var(--accent,#C9B8FF);}',
    '.lib-rd-scroll{position:absolute;left:0;top:0;right:0;bottom:0;overflow-y:scroll;overflow-x:auto;',
    '  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-x pan-y;overflow-anchor:none;outline:none;',
    '  scrollbar-color:rgba(201,184,255,.35) transparent;}',
    '.lib-rd-scroll:focus-visible{box-shadow:inset 0 0 0 2px var(--lib-accent);}',
    '.lib-rd-pages{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;width:max-content;min-width:100%;transform-origin:0 0;}',
    '.lib-page{position:relative;flex:none;margin:0 0 12px;isolation:isolate;overflow:hidden;border-radius:2px;',
    '  background:var(--lib-page-bg,var(--lib-surface));box-shadow:0 0 0 1px var(--line,rgba(201,184,255,.16)),0 8px 26px rgba(6,3,24,.5);}',
    '.lib-page:last-child{margin-bottom:0;}',
    '.lib-page::before{content:attr(data-n);position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;',
    '  justify-content:center;font:600 28px/1 "IBM Plex Serif",Georgia,serif;color:var(--muted,#BDB4E3);opacity:.28;pointer-events:none;}',
    '.lib-page.lib-done::before,.lib-page.lib-failed::before{display:none;}',
    '.lib-page.lib-failed::after{content:"This page would not draw";position:absolute;left:0;right:0;top:45%;text-align:center;',
    '  font:13px/1.4 "IBM Plex Sans",system-ui,sans-serif;color:var(--muted,#BDB4E3);}',
    '.lib-cv{position:absolute;left:0;top:0;width:100%;height:100%;-webkit-user-select:none;user-select:none;pointer-events:none;}',
    '.lib-cv canvas{display:block;width:100%;height:100%;}',
    /* night: the white page becomes soft light text on the surface violet, never pure white */
    '.lib-night .lib-cv canvas{filter:invert(.9) hue-rotate(180deg) brightness(.9) sepia(.2);mix-blend-mode:lighten;}',
    /* paper: warm cream, never #fff */
    '.lib-paper .lib-page{background:var(--lib-paper,var(--lib-cream));}',
    '.lib-paper .lib-page::before{color:#5b5348;}',
    '.lib-paper .lib-cv canvas{mix-blend-mode:multiply;}',
    /* highlight overlay: between canvas and text layer, never takes pointer events so text stays selectable */
    '.lib-hl{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;-webkit-user-select:none;user-select:none;}',
    '.lib-hl-r{position:absolute;border-radius:2px;opacity:var(--lib-hl-alpha,.34);background:var(--c,#FFE9A8);}',
    '.lib-hl-idea{--c:var(--hl-idea,#FFE9A8);}.lib-hl-evidence{--c:var(--hl-evidence,#8FE8B5);}',
    '.lib-hl-quote{--c:var(--hl-quote,#FFB6D2);}.lib-hl-question{--c:var(--hl-question,#C9B8FF);}',
    '.lib-paper .lib-hl-r{mix-blend-mode:multiply;opacity:.6;}',
    '.lib-hl-r.lib-hl-pulse{animation:lib-hl-pulse 1.6s ease-out 1;}',
    '@keyframes lib-hl-pulse{0%{opacity:.9;box-shadow:0 0 0 3px var(--c);}100%{opacity:var(--lib-hl-alpha,.34);box-shadow:0 0 0 0 transparent;}}',
    '@media (prefers-reduced-motion:reduce){.lib-hl-r.lib-hl-pulse{animation:none;outline:2px solid var(--c);}}',
    /* text layer (from PDF.js, trimmed): transparent text positioned over the canvas */
    '.lib-text{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;line-height:1;text-align:initial;',
    '  -webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:2;',
    '  -webkit-user-select:text;user-select:text;}',
    /* PDF.js lays the text out in the page's own (unrotated) space and marks the layer with data-main-rotation; turn it to match the canvas */
    '.lib-text[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%);}',
    '.lib-text[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%);}',
    '.lib-text[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%);}',
    '.lib-text span,.lib-text br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0;}',
    '.lib-text ::selection{background:rgba(201,184,255,.42);}',
    '.lib-paper .lib-text ::selection{background:rgba(92,70,200,.28);}',
    '.lib-text br::selection{background:transparent;}',
    '.lib-text .endOfContent{display:block;position:absolute;left:0;right:0;top:100%;bottom:0;z-index:-1;cursor:default;-webkit-user-select:none;user-select:none;}',
    '.lib-text .endOfContent.active{top:0;}',
    /* small messages and the go-to-page box */
    '.lib-rd-msg{position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);max-width:80%;text-align:center;padding:10px 16px;',
    '  border-radius:10px;background:var(--lib-surface);color:var(--ink,#F2EEFF);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif;',
    '  box-shadow:0 0 0 1px var(--line,rgba(201,184,255,.16));pointer-events:none;}',
    '.lib-rd-msg.lib-rd-hint{top:auto;bottom:18px;transform:translateX(-50%);}',
    '.lib-goto{position:absolute;right:14px;top:12px;z-index:5;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;',
    '  background:var(--lib-surface);color:var(--ink,#F2EEFF);font:13px/1 "IBM Plex Sans",system-ui,sans-serif;',
    '  box-shadow:0 0 0 1px var(--line-strong,rgba(201,184,255,.3)),0 6px 20px rgba(6,3,24,.5);}',
    '.lib-goto[hidden]{display:none;}',
    '.lib-goto input{width:5.2em;font:inherit;font-size:16px;color:var(--ink,#F2EEFF);background:var(--paper,#17113a);',
    '  border:1px solid var(--line-strong,rgba(201,184,255,.3));border-radius:6px;padding:5px 8px;}',
    '.lib-goto input:focus{outline:2px solid var(--lib-accent);outline-offset:1px;}'
  ].join('\n');

  function injectCss(doc) {
    if (doc.getElementById('lib-reader-css')) { return; }
    var st = doc.createElement('style');
    st.id = 'lib-reader-css';
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------------------ */
  /* Pure helpers (also used by node tests via reader._pure)             */
  /* ------------------------------------------------------------------ */
  var LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u1E00-\u1EFF]/;
  function isLowerLetter(ch) { return LETTER.test(ch) && ch === ch.toLowerCase() && ch !== ch.toUpperCase(); }

  /* Arabic presentation forms (what many PDFs store) and Latin ligatures back to plain letters, so the text can be searched. */
  var FORMS = /[\uFB00-\uFB06\uFB50-\uFDFF\uFE70-\uFEFE]/g;
  function foldForms(s) {
    if (!String.prototype.normalize) { return s; }
    return s.replace(FORMS, function (c) { return c.normalize('NFKC'); });
  }

  /* Join hyphenated line breaks, collapse whitespace, fold presentation forms. */
  function cleanText(s) {
    s = foldForms(String(s == null ? '' : s)).replace(/\uFEFF/g, '');
    s = s.replace(/\u00AD[ \t]*\r?\n[ \t]*/g, '').replace(/\u00AD/g, '');
    s = s.replace(/(\S)[-\u2010\u2011][ \t]*\r?\n[ \t]*(\S)/g, function (m, a, b) {
      if (LETTER.test(a) && isLowerLetter(b)) { return a + b; }   // extra-\nordinary -> extraordinary
      return a + '-' + b;                                          // Greco-\nRoman, 45-\n67 keep the hyphen
    });
    return s.replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  /* rs: [{l,t,r,b}] in any one coordinate space (turned: the lines run top to bottom). Merges rects that sit on the same line and touch,
     drops zero-area rects, returns lines top to bottom. */
  function mergeRects(rs, turned) {
    var items = [], i, r;
    for (i = 0; i < rs.length; i++) {
      r = rs[i];
      if (!r || !isFinite(r.l) || !isFinite(r.t) || !isFinite(r.r) || !isFinite(r.b)) { continue; }
      if (r.r - r.l < 0.5 || r.b - r.t < 0.5) { continue; }
      // a page turned 90 or 270 degrees: its lines run top to bottom, so merge in swapped coordinates
      items.push(turned ? { l: r.t, t: r.l, r: r.b, b: r.r } : { l: r.l, t: r.t, r: r.r, b: r.b });
    }
    items.sort(function (a, b) { return (a.t + a.b) - (b.t + b.b); });
    var lines = [];
    items.forEach(function (it) {
      var line = null, k, L, ov;
      for (k = lines.length - 1; k >= 0 && k >= lines.length - 3; k--) {
        L = lines[k];
        ov = Math.min(L.b, it.b) - Math.max(L.t, it.t);
        if (ov >= 0.5 * Math.min(L.b - L.t, it.b - it.t)) { line = L; break; }
      }
      if (!line) { line = { t: it.t, b: it.b, items: [] }; lines.push(line); }
      line.items.push(it);
      line.t = Math.min(line.t, it.t);
      line.b = Math.max(line.b, it.b);
    });
    var out = [];
    lines.forEach(function (L) {
      L.items.sort(function (a, b) { return a.l - b.l; });
      var cur = L.items[0], j, n, mh, gap;
      for (j = 1; j < L.items.length; j++) {
        n = L.items[j];
        mh = Math.min(cur.b - cur.t, n.b - n.t);
        gap = n.l - cur.r;
        if (gap <= 0.6 * mh) {
          cur = { l: Math.min(cur.l, n.l), t: Math.min(cur.t, n.t), r: Math.max(cur.r, n.r), b: Math.max(cur.b, n.b) };
        } else { out.push(cur); cur = n; }
      }
      out.push(cur);
    });
    return turned ? out.map(function (q) { return { l: q.t, t: q.l, r: q.b, b: q.r }; }) : out;
  }

  /* What goes between two neighbouring PDF text items: '\n' for a new line, ' ' for a real gap, '' otherwise.
     prev / it are PDF.js text items ({str, transform, width, height, hasEOL}); soFar is the text built so far and
     str the text about to be added. Used by getText() and by selections, so both read the same. Returns null
     when an item has no geometry (the caller then falls back to measuring the page). */
  function itemSep(prev, it, soFar, str) {
    if (!prev || !it || !prev.transform || !it.transform) { return null; }
    var h = Math.max(1, Math.abs(it.transform[3]) || it.height || 1);
    if (prev.hasEOL || Math.abs(it.transform[5] - prev.transform[5]) > 0.5 * h) { return /\n$/.test(soFar) ? '' : '\n'; }
    var gap = Math.min(Math.abs(it.transform[4] - (prev.transform[4] + prev.width)), Math.abs(prev.transform[4] - (it.transform[4] + it.width)));
    return (gap > 0.15 * h && !/\s$/.test(soFar) && !/^\s/.test(str)) ? ' ' : '';
  }

  function round5(v) { return Math.round(v * 100000) / 100000; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* client-space rects -> [[x,y,w,h]] fractions of the page box */
  function normRects(rs, box) {
    var out = [], i, x0, y0, x1, y1;
    if (!box || !(box.width > 0) || !(box.height > 0)) { return out; }
    for (i = 0; i < rs.length; i++) {
      x0 = clamp01((rs[i].l - box.left) / box.width);
      y0 = clamp01((rs[i].t - box.top) / box.height);
      x1 = clamp01((rs[i].r - box.left) / box.width);
      y1 = clamp01((rs[i].b - box.top) / box.height);
      if (x1 - x0 > 0 && y1 - y0 > 0) { out.push([round5(x0), round5(y0), round5(x1 - x0), round5(y1 - y0)]); }
    }
    return out;
  }

  function validRects(rects) {
    var out = [], i, r;
    if (!rects || !rects.length) { return out; }
    for (i = 0; i < rects.length && out.length < 2000; i++) {
      r = rects[i];
      if (r && r.length >= 4 && isFinite(r[0]) && isFinite(r[1]) && isFinite(r[2]) && isFinite(r[3]) && r[2] > 0 && r[3] > 0) {
        out.push([+r[0], +r[1], +r[2], +r[3]]);
      }
    }
    return out;
  }

  function friendlyError(err) {
    var n = err && err.name, m = String((err && err.message) || '');
    if (n === 'PasswordException') { return 'This PDF is locked with a password, so it cannot be opened here.'; }
    if (n === 'InvalidPDFException') { return 'This file does not look like a PDF.'; }
    if (n === 'MissingPDFException') { return 'That PDF could not be found.'; }
    if (/Failed to fetch|NetworkError|Load failed|UnexpectedResponse/i.test(m + ' ' + n)) { return 'The PDF could not be loaded. Check the connection and try again.'; }
    if (/not.*loaded|pdfjsLib/i.test(m)) { return 'The PDF reader is still loading. Try again in a moment.'; }
    return 'This PDF could not be opened.';
  }

  /* ------------------------------------------------------------------ */
  /* mount                                                               */
  /* ------------------------------------------------------------------ */
  var reader = { version: '1.0' };
  reader._pure = { cleanText: cleanText, mergeRects: mergeRects, normRects: normRects, friendlyError: friendlyError, itemSep: itemSep };

  reader.mount = function (container, opts) {
    if (!container || !container.appendChild) { throw new Error('Lib.reader.mount needs an element'); }
    var o = opts || {};
    var doc = container.ownerDocument || document;
    var win = doc.defaultView || root;
    injectCss(doc);

    var destroyed = false;
    var night = o.night !== false;
    var pdf = null, loadingTask = null, loadToken = 0;
    var numPages = 0;
    var sizes = [];          // page size at scale 1 (css px)
    var tops = [];           // top offset of each page inside the scroller's content
    var wraps = [];          // .lib-page elements
    var parts = [];          // {cv, hl, text} per page
    var pst = [];            // render state per page
    var live = {};           // page index -> true while it has a canvas / is rendering
    var zoomMode = 'fit';
    var scales = [];         // draw scale of each page (fit mode: every page fits the width on its own)
    var curPage = 0;
    var hlByPage = {};
    var hlAll = [];
    var pendingGo = null;
    var holdUntil = 0;
    var lastW = 0;
    var lastAnchor = null;
    var lastSelKey = '';
    var lastSel = null;
    var mouseDown = false, lastPointerType = 'mouse', snapNext = false;
    var activeEnd = null;
    var idleWaiters = [];
    var errorShown = false;
    var timers = {};
    var listeners = [];
    var io = null, ro = null, pulseTimer = 0;
    var pinch = null, wheelAcc = null;
    var gotoEl = null, gotoInput = null, gotoHint = null;

    /* ---------- DOM ---------- */
    var prevPosition = null;
    try {
      if (win.getComputedStyle(container).position === 'static') { prevPosition = container.style.position; container.style.position = 'relative'; }
    } catch (e) { /* ignore */ }
    container.classList.add('lib-reader');
    function setModeClass() {
      container.classList.toggle('lib-night', night);
      container.classList.toggle('lib-paper', !night);
    }
    setModeClass();

    function el(tag, cls) { var e = doc.createElement(tag); if (cls) { e.className = cls; } return e; }
    var scroller = el('div', 'lib-rd-scroll');
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', 'PDF pages');
    var pagesEl = el('div', 'lib-rd-pages');
    var msgEl = el('div', 'lib-rd-msg');
    msgEl.hidden = true;
    msgEl.setAttribute('role', 'status');
    scroller.appendChild(pagesEl);
    container.appendChild(scroller);
    container.appendChild(msgEl);

    function showMsg(text) { msgEl.textContent = text || ''; msgEl.hidden = !text; msgEl.classList.remove('lib-rd-hint'); }

    /* A short, gentle note at the bottom of the reader that goes away by itself. Only while a document is open. */
    var hintTimer = 0;
    function hint(text) {
      if (!numPages || destroyed) { return; }
      showMsg(text);
      msgEl.classList.add('lib-rd-hint');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(function () { if (!destroyed && msgEl.classList.contains('lib-rd-hint') && msgEl.textContent === text) { showMsg(''); } }, 4200);
    }

    function on(target, type, fn, capOrOpts) {
      target.addEventListener(type, fn, capOrOpts);
      listeners.push([target, type, fn, capOrOpts]);
    }

    /* throttle: first call arms a timer, later calls before it fires are ignored */
    function soon(key, fn, ms) {
      if (timers[key]) { return; }
      timers[key] = setTimeout(function () { timers[key] = 0; if (!destroyed) { fn(); } }, ms);
    }
    /* debounce: each call restarts the timer */
    function later(key, fn, ms) {
      if (timers[key]) { clearTimeout(timers[key]); }
      timers[key] = setTimeout(function () { timers[key] = 0; if (!destroyed) { fn(); } }, ms);
    }

    /* ---------- geometry ---------- */
    function padX() { return scroller.clientWidth < 520 ? 8 : 20; }
    function availW() { return Math.max(60, scroller.clientWidth - 2 * padX()); }
    function fitOf(i) { return availW() / (sizes[i] ? sizes[i].w : 612); }
    function pageH(i) { return sizes[i].h * scales[i]; }
    /* the scale of the page being read: what the zoom buttons and the percent label talk about */
    function refScale() {
      if (!numPages) { return 1; }
      return scales[Math.min(numPages - 1, Math.max(0, (curPage || 1) - 1))] || 1;
    }

    function pageAtY(y) {
      var lo = 0, hi = numPages - 1, mid;
      while (lo < hi) {
        mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) { lo = mid; } else { hi = mid - 1; }
      }
      return lo;
    }

    /* The text layer has the page's own width and height (swapped for a page turned 90 or 270 degrees). */
    function sizeText(i) {
      var tl = pst[i].textEl;
      if (!tl) { return; }
      var turned = (+tl.getAttribute('data-main-rotation') || 0) % 180 !== 0;
      var w = sizes[i].w * scales[i], h = sizes[i].h * scales[i];
      tl.style.width = (turned ? h : w) + 'px';
      tl.style.height = (turned ? w : h) + 'px';
      tl.style.setProperty('--scale-factor', String(scales[i]));
    }

    function layout() {
      if (!numPages) { return; }
      var y = PAD_Y, i, w, h, px = padX();
      pagesEl.style.padding = PAD_Y + 'px ' + px + 'px';
      for (i = 0; i < numPages; i++) {
        scales[i] = zoomMode === 'fit' ? fitOf(i) : zoomMode;
        w = sizes[i].w * scales[i];
        h = sizes[i].h * scales[i];
        wraps[i].style.width = w + 'px';
        wraps[i].style.height = h + 'px';
        tops[i] = y;
        y += h + GAP;
        // text layers already on screen follow the new size straight away (their font sizes use this variable)
        if (pst[i].textEl) { sizeText(i); }
      }
      lastW = scroller.clientWidth;
    }

    function captureAnchor(cx, cy) {
      if (!numPages) { return null; }
      var r = scroller.getBoundingClientRect();
      if (cx == null) { cx = r.left + scroller.clientWidth / 2; }
      if (cy == null) { cy = r.top + scroller.clientHeight / 2; }
      var p = pageAtY(scroller.scrollTop + (cy - r.top));
      var wr = wraps[p].getBoundingClientRect();
      return { p: p, fx: wr.width ? (cx - wr.left) / wr.width : 0, fy: wr.height ? (cy - wr.top) / wr.height : 0, cx: cx, cy: cy };
    }
    function restoreAnchor(a) {
      if (!a) { return; }
      var wr = wraps[a.p].getBoundingClientRect();
      scroller.scrollLeft += (wr.left + a.fx * wr.width) - a.cx;
      scroller.scrollTop += (wr.top + a.fy * wr.height) - a.cy;
    }

    function relayout(anchor) {
      var a = anchor || captureAnchor(null, scroller.getBoundingClientRect().top + 2);
      layout();
      restoreAnchor(a);
      tick();
    }

    function saveAnchor() {
      if (!numPages || !scroller.clientHeight) { return; }
      var st = scroller.scrollTop, p = pageAtY(st);
      lastAnchor = { p: p, f: (st - tops[p]) / Math.max(1, pageH(p)) };
    }

    function computePage() {
      var st = scroller.scrollTop, H = scroller.clientHeight;
      if (st > 0 && st + H >= scroller.scrollHeight - 2) { return numPages; }
      var line = st + H * 0.25, i = pageAtY(line);
      if (tops[i] + pageH(i) <= line && i < numPages - 1) { i++; }
      return i + 1;
    }

    /* ---------- render scheduling ---------- */
    function dprNow() { return Math.min(DPR_CAP, win.devicePixelRatio || 1); }
    /* Bitmap pixels per css pixel. Never above the device ratio, and never so large that the canvas passes the
       pixel cap (iOS refuses ~16.7M pixels) or the side cap (16384): a huge page is drawn softer instead of not at all. */
    function outScale(i, scale) {
      var os = dprNow(), w = sizes[i].w * scale, h = sizes[i].h * scale, px = w * h * os * os;
      if (px > MAX_CANVAS_PX) { os = Math.sqrt(MAX_CANVAS_PX / (w * h)); }
      if (Math.max(w, h) * os > MAX_CANVAS_SIDE) { os = MAX_CANVAS_SIDE / Math.max(w, h); }
      return Math.max(0.001, os);
    }

    function needs(i) {
      var st = pst[i];
      if (st.failed) { return false; }
      if (st.busy) { return Math.abs(st.renderScale - scales[i]) > 1e-4; }
      return !st.canvas || Math.abs(st.scale - scales[i]) > 1e-4 || Math.abs(st.os - outScale(i, scales[i])) > 0.01;
    }

    function visRange(margin) {
      var st = scroller.scrollTop, H = scroller.clientHeight;
      var top = st - margin, bot = st + H + margin;
      var a = pageAtY(top), b = pageAtY(bot);
      while (a < numPages - 1 && tops[a] + pageH(a) < top) { a++; }
      if (b < a) { b = a; }
      return [a, b];
    }

    function cancelTasks(st) {
      try { if (st.task) { st.task.cancel(); } } catch (e) { /* ignore */ }
      try { if (st.textTask) { st.textTask.cancel(); } } catch (e) { /* ignore */ }
      st.task = null;
      st.textTask = null;
    }

    function freeCanvas(c) {
      if (!c) { return; }
      try { c.width = 0; c.height = 0; } catch (e) { /* ignore */ }   // frees the bitmap right away on iOS
      if (c.parentNode) { c.parentNode.removeChild(c); }
    }

    function release(i) {
      var st = pst[i];
      if (!st) { return; }
      st.tok++;
      cancelTasks(st);
      st.busy = false;
      freeCanvas(st.canvas);
      st.canvas = null;
      if (st.textEl) {
        var fresh = el('div', 'lib-text');
        if (parts[i].text.parentNode) { parts[i].text.parentNode.replaceChild(fresh, parts[i].text); }
        parts[i].text = fresh;
        st.textEl = null;
      }
      if (st.page) { try { st.page.cleanup(); } catch (e) { /* ignore */ } st.page = null; }
      st.scale = 0;
      wraps[i].classList.remove('lib-done');
      delete live[i];
    }

    function countBusy() {
      var n = 0, k;
      for (k in live) { if (pst[k] && pst[k].busy) { n++; } }
      return n;
    }

    function noteSize(i, page) {
      var v = page.getViewport({ scale: 1 });
      if (Math.abs(v.width - sizes[i].w) > 0.5 || Math.abs(v.height - sizes[i].h) > 0.5) {
        sizes[i] = { w: v.width, h: v.height };
        later('relayout', function () { relayout(); }, 60);
      }
    }


    /* ---------- scanned pages: line the hidden text up with the printed words ----------
       A scanned paper (JSTOR and the like) has an invisible text layer whose line widths do not match the ink on the page,
       so a drag over the words selects the wrong letters and a saved highlight spills past the line.
       After a page is drawn, each line of text is measured against the ink in the picture. When most lines are clearly
       off, every off line is stretched or squeezed to the width of its ink. Born-digital pages match already and are left alone. */
    function fitTextToInk(i) {
      var st = pst[i], cv = st.canvas, tl = st.textEl, info = { lines: 0, off: 0, fitted: 0, median: 1 };
      st.fit = info;
      if (!cv || !tl || destroyed) { return; }
      if ((+tl.getAttribute('data-main-rotation') || 0) % 360 !== 0) { return; }
      var tlr = tl.getBoundingClientRect();
      if (!tlr.width || !tlr.height || cv.width * cv.height > 40e6) { return; }
      var k = cv.width / tlr.width, ctx;
      try { ctx = cv.getContext('2d'); } catch (e) { return; }
      var spans = tl.querySelectorAll('span'), rows = [], n, sp, r, m, txt;
      for (n = 0; n < spans.length; n++) {
        sp = spans[n];
        txt = sp.textContent;
        if (!sp.__libItem || !txt || txt.replace(/\s+/g, '').length < 4) { continue; }
        m = /^scaleX\(([0-9.]+)\)$/.exec(sp.style.transform || 'scaleX(1)');
        if (!m) { continue; }
        r = sp.getBoundingClientRect();
        if (r.width < 4 || r.height < 3) { continue; }
        rows.push({ sp: sp, sx: +m[1], l: (r.left - tlr.left) * k, t: (r.top - tlr.top) * k, w: r.width * k, h: r.height * k });
      }
      if (rows.length < 4) { return; }
      var j, row, W = cv.width, H = cv.height, meas = [], boxes = [], bb;
      for (n = 0; n < spans.length; n++) {
        if (!spans[n].textContent.trim()) { continue; }
        bb = spans[n].getBoundingClientRect();
        if (bb.width >= 1 && bb.height >= 3) { boxes.push({ l: (bb.left - tlr.left) * k, t: (bb.top - tlr.top) * k }); }
      }
      for (j = 0; j < rows.length; j++) {
        row = rows[j];
        var nl = Infinity, b2;   // the next box on the same printed line: the ink search stops there
        for (b2 = 0; b2 < boxes.length; b2++) {
          if (boxes[b2].l > row.l + 0.3 * row.w && Math.abs(boxes[b2].t - row.t) < 0.5 * row.h && boxes[b2].l < nl) { nl = boxes[b2].l; }
        }
        var x0 = Math.max(0, Math.floor(row.l - 1.5 * row.h)), x1 = Math.min(W, Math.ceil(Math.min(row.l + 1.8 * row.w, Math.max(nl - 1, row.l + row.w)) + 2));
        var y0 = Math.max(0, Math.floor(row.t - 0.5 * row.h)), y1 = Math.min(H, Math.ceil(row.t + 1.5 * row.h));
        var ww = x1 - x0, hh = y1 - y0;
        if (ww < 8 || hh < 4) { continue; }
        var data;
        try { data = ctx.getImageData(x0, y0, ww, hh).data; } catch (e2) { return; }
        // paper colour = median brightness of a sample; ink = clearly different from it
        var smp = [], q, lum;
        for (q = 0; q < data.length; q += 4 * 11) { smp.push(data[q] * 0.299 + data[q + 1] * 0.587 + data[q + 2] * 0.114); }
        smp.sort(function (a, b) { return a - b; });
        var bg = smp[smp.length >> 1], cut = 55, x, y, o, cnt;
        var rowCnt = new Array(hh), maxRow = 0;
        for (y = 0; y < hh; y++) {
          cnt = 0;
          for (x = 0; x < ww; x++) {
            o = (y * ww + x) * 4;
            lum = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
            if (Math.abs(lum - bg) > cut) { cnt++; }
          }
          rowCnt[y] = cnt; if (cnt > maxRow) { maxRow = cnt; }
        }
        if (maxRow < 6) { continue; }
        // the text line = the run of dense rows nearest the middle of the box
        var mid = row.t + 0.6 * row.h - y0, best = null, run = null, thr = 0.3 * maxRow, gap = 0;
        for (y = 0; y <= hh; y++) {
          if (y < hh && rowCnt[y] >= thr) { if (!run) { run = { a: y, b: y }; } else { run.b = y; } gap = 0; }
          else if (run && ++gap > Math.max(1, Math.round(0.08 * row.h))) {
            if (run.b - run.a + 1 >= 0.2 * row.h) {
              var d = Math.abs((run.a + run.b) / 2 - mid);
              if (!best || d < best.d) { best = { a: run.a, b: run.b, d: d }; }
            }
            run = null; gap = 0;
          }
        }
        if (!best || best.d > 0.9 * row.h) { continue; }
        // ink columns inside that run, followed to the right across word gaps only
        var first = -1, last = -1, miss = 0, maxGap = Math.round(1.3 * row.h);
        for (x = 0; x < ww; x++) {
          var dark = false;
          for (y = best.a; y <= best.b; y++) {
            o = (y * ww + x) * 4;
            lum = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
            if (Math.abs(lum - bg) > cut) { dark = true; break; }
          }
          if (dark) {
            if (first < 0) { first = x; }
            else if (x - last > maxGap) { break; }
            last = x;
          }
        }
        if (first < 0 || last - first < 6) { continue; }
        var inkL = x0 + first, inkR = x0 + last + 1;
        if (inkL < row.l - 1.5 * row.h || inkL > row.l + 2.5 * row.h) { continue; }
        meas.push({ row: row, inkL: inkL, inkR: inkR, ratio: (inkR - inkL) / row.w, cy: (y0 + (best.a + best.b + 1) / 2 - row.t) / row.h });
      }
      info.lines = meas.length;
      if (meas.length < 4) { return; }
      var rs = meas.map(function (z) { return z.ratio; }).sort(function (a, b) { return a - b; });
      info.median = rs[rs.length >> 1];
      var cys = meas.map(function (z) { return z.cy; }).sort(function (a, b) { return a - b; });
      info.cy = cys[cys.length >> 1];
      var pageW = tlr.width, pageH = tlr.height;
      // Height: some fonts put the hidden text boxes several pixels above or below the printed line. When the whole page
      // agrees (tight spread of where the ink sits inside each box), move every box on the page so the ink is centred in it.
      var spread = cys[Math.floor(cys.length * 0.75)] - cys[Math.floor(cys.length * 0.25)];
      if (meas.length >= 8 && spread <= 0.2 && Math.abs(info.cy - 0.5) > 0.12 && Math.abs(info.cy - 0.5) < 0.9) {
        var hs = rows.map(function (z) { return z.h; }).sort(function (a, b) { return a - b; });
        var dy = (info.cy - 0.5) * (hs[hs.length >> 1] / k);   // css pixels; negative = move the boxes up
        for (j = 0; j < rows.length; j++) {
          var tp = parseFloat(rows[j].sp.style.top);
          if (isFinite(tp)) { rows[j].sp.style.top = (tp + dy / pageH * 100).toFixed(3) + '%'; }
        }
        info.dy = +dy.toFixed(2);
      }
      var off = meas.filter(function (z) { return Math.abs(z.ratio - 1) > 0.06; });
      info.off = off.length;
      if (off.length < 0.5 * meas.length || info.median < 0.4 || info.median > 1.6) { return; }
      for (j = 0; j < off.length; j++) {
        var z = off[j];
        if (z.ratio < 0.35 || z.ratio > 1.8) { continue; }
        z.row.sp.style.transform = 'scaleX(' + (z.row.sx * z.ratio).toFixed(4) + ')';
        z.row.sp.style.left = ((z.inkL / k) / pageW * 100).toFixed(3) + '%';
        info.fitted++;
      }
    }

    function renderPage(i) {
      var st = pst[i], thisDoc = pdf, scale = scales[i];
      var tok = ++st.tok;
      cancelTasks(st);
      st.busy = true;
      st.renderScale = scale;
      live[i] = true;
      function dead() { return destroyed || pdf !== thisDoc || st.tok !== tok; }

      thisDoc.getPage(i + 1).then(function (page) {
        if (dead()) { return null; }
        noteSize(i, page);
        var vp = page.getViewport({ scale: scale });
        var os = outScale(i, scale);
        var canvas = el('canvas');
        canvas.width = Math.max(1, Math.floor(vp.width * os));
        canvas.height = Math.max(1, Math.floor(vp.height * os));
        var ctx = canvas.getContext('2d', { alpha: false });
        var rtask = page.render({ canvasContext: ctx, viewport: vp, transform: os !== 1 ? [os, 0, 0, os, 0, 0] : null });
        st.task = rtask;
        var tl = el('div', 'lib-text');
        tl.style.setProperty('--scale-factor', String(scale));
        var textP = Promise.resolve(null);
        try {
          // The text content is read once and handed to the layer, so every span can be tied to its PDF text item
          // (position, width, end-of-line). A selection is then joined the way getText() joins it, which keeps
          // Arabic words that a PDF stores one glyph per span in one piece and keeps turned pages in line order.
          var divs = [];
          textP = page.getTextContent().then(function (tc) {
            if (dead()) { return null; }
            var ttask = win.pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: divs, textContentItemsStr: [] });
            st.textTask = ttask;
            return ttask.promise.then(function () {
              var items = [], k;
              for (k = 0; k < tc.items.length; k++) { if (tc.items[k].str !== undefined) { items.push(tc.items[k]); } }
              for (k = 0; k < divs.length && k < items.length; k++) { if (divs[k]) { divs[k].__libItem = items[k]; } }
              return null;
            });
          }).then(null, function (e) {
            // a text layer that fails must not hide the page itself
            if (e && (e.name === 'AbortException' || e.name === 'RenderingCancelledException')) { throw e; }
            return null;
          });
        } catch (e) { /* page still draws without selectable text */ }
        return Promise.all([rtask.promise, textP]).then(function () {
          if (dead()) { freeCanvas(canvas); return; }
          var old = st.canvas;
          parts[i].cv.appendChild(canvas);
          freeCanvas(old);
          var end = el('div', 'endOfContent');
          tl.appendChild(end);
          wraps[i].replaceChild(tl, parts[i].text);
          parts[i].text = tl;
          st.canvas = canvas;
          st.textEl = tl;
          st.page = page;
          st.scale = scale;
          st.os = os;
          sizeText(i);
          try { fitTextToInk(i); } catch (e) { /* the hidden text keeps the PDF's own boxes */ }
          wraps[i].classList.add('lib-done');
        }, function (err) { freeCanvas(canvas); throw err; });
      }).catch(function (err) {
        if (dead()) { return; }
        if (err && (err.name === 'RenderingCancelledException' || err.name === 'AbortException')) { return; }
        st.failed = true;
        wraps[i].classList.add('lib-failed');
        // Not a failure to open the file: say it quietly inside the reader (and through onPageError if given), not through onError,
        // because a page that will not draw must not make the caller throw the whole reader away.
        if (!errorShown) {
          errorShown = true;
          hint('Some pages could not be drawn.');
          if (o.onPageError) { try { o.onPageError('Some pages could not be drawn.', i + 1); } catch (e) { /* ignore */ } }
        }
      }).then(function () {
        if (st.tok === tok) { st.busy = false; st.task = null; st.textTask = null; }
        if (!destroyed) { soon('upd', tick, 0); }
      });
    }

    function update() {
      if (destroyed || !numPages || !scroller.clientHeight) { return; }
      var now = Date.now();
      if (holdUntil > now) { soon('upd', tick, holdUntil - now + 5); return; }
      var H = scroller.clientHeight;
      var r = visRange(H * 0.75), a = r[0], b = r[1], i, k;
      var big = sizes[a].w * scales[a] * sizes[a].h * scales[a] > 3e6;
      var pad = big ? 0 : 1;
      var lo = Math.max(0, a - pad), hi = Math.min(numPages - 1, b + pad);
      for (k in live) {
        i = +k;
        if (i < lo || i > hi) { release(i); }
        else if ((i < a || i > b) && !pst[i].busy && needs(i)) { release(i); }   // kept only as a buffer: drop it if the zoom made it stale
      }
      var center = scroller.scrollTop + H / 2, want = [];
      for (i = a; i <= b; i++) { if (needs(i)) { want.push(i); } }
      want.sort(function (x, y) { return Math.abs(tops[x] + pageH(x) / 2 - center) - Math.abs(tops[y] + pageH(y) / 2 - center); });
      var busy = countBusy();
      for (k = 0; k < want.length; k++) {
        i = want[k];
        if (pst[i].busy) { renderPage(i); continue; }          // in flight at the wrong zoom: restart in place
        if (busy >= MAX_PARALLEL) { break; }
        renderPage(i);
        busy++;
      }
      if (!want.length && countBusy() === 0 && idleWaiters.length) {
        var ws = idleWaiters; idleWaiters = [];
        ws.forEach(function (f) { f(); });
      }
    }

    function tick() {
      if (destroyed || !numPages) { return; }
      var p = computePage();
      if (p !== curPage) { curPage = p; if (o.onPage) { try { o.onPage(p, numPages); } catch (e) { /* ignore */ } } }
      saveAnchor();
      update();
    }

    /* ---------- highlights ---------- */
    function drawHl(pageNo) {
      var layer = parts[pageNo - 1] && parts[pageNo - 1].hl;
      if (!layer) { return; }
      layer.textContent = '';
      var list = hlByPage[pageNo];
      if (!list) { return; }
      var frag = doc.createDocumentFragment();
      list.forEach(function (h) {
        h.rects.forEach(function (r) {
          var d = el('div', 'lib-hl-r lib-hl-' + h.hl);
          d.setAttribute('data-hl-id', h.id);
          d.style.left = (r[0] * 100) + '%';
          d.style.top = (r[1] * 100) + '%';
          d.style.width = (r[2] * 100) + '%';
          d.style.height = (r[3] * 100) + '%';
          frag.appendChild(d);
        });
      });
      layer.appendChild(frag);
    }

    function setHighlights(list) {
      var touched = {}, k;
      for (k in hlByPage) { touched[k] = true; }
      hlByPage = {};
      hlAll = [];
      (list || []).forEach(function (h) {
        if (!h) { return; }
        var p = Math.round(+h.page), rects = validRects(h.rects);
        if (!(p >= 1) || !rects.length) { return; }
        var item = { id: String(h.id), page: p, hl: HL_KINDS[h.hl] ? h.hl : 'idea', rects: rects };
        (hlByPage[p] = hlByPage[p] || []).push(item);
        hlAll.push(item);
        touched[p] = true;
      });
      if (numPages) {
        for (k in touched) { if (+k >= 1 && +k <= numPages) { drawHl(+k); } }
      }
      return api;
    }

    function pulse(id) {
      var nodes = pagesEl.querySelectorAll('.lib-hl-r'), i, old = pagesEl.querySelectorAll('.lib-hl-pulse');
      for (i = 0; i < old.length; i++) { old[i].classList.remove('lib-hl-pulse'); }
      void pagesEl.offsetWidth;   // lets the animation start again on a mark that was just flashed
      for (i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('data-hl-id') === id) { nodes[i].classList.add('lib-hl-pulse'); }
      }
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(function () {
        var ns = pagesEl.querySelectorAll('.lib-hl-pulse'), q;
        for (q = 0; q < ns.length; q++) { ns[q].classList.remove('lib-hl-pulse'); }
      }, 1800);
    }

    /* ---------- navigation and zoom ---------- */
    function goTo(p, opt) {
      var o2 = opt || {};
      p = Math.round(+p);
      if (!(p >= 1)) { p = 1; }
      if (!numPages) { pendingGo = { p: p, o: o2 }; return api; }
      if (p > numPages) { p = numPages; }
      var y = p === 1 ? 0 : tops[p - 1] - 8, hlId = o2.highlightId != null ? String(o2.highlightId) : null, found = null;
      if (hlId) {
        (hlByPage[p] || []).forEach(function (h) { if (h.id === hlId && !found) { found = h; } });
        if (found) {
          var minY = 1;
          found.rects.forEach(function (r) { if (r[1] < minY) { minY = r[1]; } });
          y = tops[p - 1] + minY * pageH(p - 1) - scroller.clientHeight * 0.3;
        }
      }
      y = Math.max(0, y);
      if (o2.smooth && scroller.scrollTo) { scroller.scrollTo({ top: y, behavior: 'smooth' }); }
      else { scroller.scrollTop = y; }
      if (curPage !== p) { curPage = p; if (o.onPage) { try { o.onPage(p, numPages); } catch (e) { /* ignore */ } } }
      soon('upd', tick, 0);
      if (found) { pulse(hlId); }
      return api;
    }

    /* Lowest zoom: 25%, or less when the page being read is so wide that 'fit' is already below that (a poster or a map on a phone). */
    function minZoom() {
      if (!numPages) { return MIN_ZOOM; }
      return Math.max(0.02, Math.min(MIN_ZOOM, fitOf(Math.min(numPages - 1, Math.max(0, (curPage || 1) - 1)))));
    }
    function clampZoom(z) { return Math.min(MAX_ZOOM, Math.max(minZoom(), z)); }

    function setZoom(z, where, settle) {
      var next;
      if (z === 'fit') { next = 'fit'; }
      else if (isFinite(+z) && +z > 0) { next = clampZoom(+z); }
      else { return api; }
      if (!numPages) { zoomMode = next; return api; }
      var a = captureAnchor(where && where.clientX, where && where.clientY);
      zoomMode = next;
      layout();
      restoreAnchor(a);
      if (settle) { holdUntil = Date.now() + 140; }
      tick();
      if (o.onZoom) { try { o.onZoom(zoomInfo()); } catch (e) { /* ignore */ } }
      return api;
    }

    function zoomInfo() { return { mode: zoomMode === 'fit' ? 'fit' : 'custom', scale: refScale(), percent: Math.round(refScale() * 100) }; }

    function zoomBy(dir, where, factor, settle) {
      var f = factor || 1.2, s = refScale() * (dir > 0 ? f : 1 / f);
      if (numPages && Math.abs(s / fitOf(Math.max(0, (curPage || 1) - 1)) - 1) < 0.04) { return setZoom('fit', where, settle); }
      return setZoom(s, where, settle);
    }

    function setNight(b) {
      night = !!b;
      setModeClass();
      return api;
    }

    /* ---------- scrolling, resize ---------- */
    on(scroller, 'scroll', function () { soon('upd', tick, 30); later('selscroll', function () { if (lastSel) { emitSel(true); } }, 160); }, { passive: true });

    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(function () { later('resize', onResize, 80); });
      ro.observe(scroller);
    } else {
      on(win, 'resize', function () { later('resize', onResize, 80); });
    }
    function onResize() {
      if (!numPages) { return; }
      var w = scroller.clientWidth;
      if (w < 40) { return; }                       // hidden: keep everything as it is
      if (lastW < 40 && lastAnchor) {                // shown again after being hidden: put the scroll position back
        layout();
        var p = Math.min(lastAnchor.p, numPages - 1);
        scroller.scrollTop = tops[p] + lastAnchor.f * pageH(p);
        tick();
        return;
      }
      if (w !== lastW) { relayout(); } else { tick(); }
    }

    if (typeof win.IntersectionObserver === 'function') {
      // Wakes the scheduler when a page comes within 3/4 of a screen, also after layout changes or when a hidden tab is shown.
      io = new win.IntersectionObserver(function () { soon('upd', tick, 0); }, { root: scroller, rootMargin: '75% 0px 75% 0px' });
    }

    /* ---------- selection ---------- */
    function isTypingTarget(t) {
      if (!t || !t.tagName) { return false; }
      var n = t.tagName;
      return n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT' || t.isContentEditable;
    }

    function readSelection() {
      var s = win.getSelection ? win.getSelection() : null;
      if (!s || s.rangeCount === 0 || s.isCollapsed) { return null; }
      var range = s.getRangeAt(0);
      if (!scroller.contains(range.startContainer) && !scroller.contains(range.endContainer) && !scroller.contains(range.commonAncestorContainer)) { return null; }
      var i, layer, pieces = null, pageIdx = -1;
      for (i = 0; i < numPages; i++) {
        layer = pst[i].textEl;
        if (!layer || !range.intersectsNode(layer)) { continue; }
        pieces = collectPieces(layer, range);
        if (pieces.length) { pageIdx = i; break; }
      }
      if (pageIdx < 0) { return null; }

      var rects = [], text = '', prev = null;
      pieces.forEach(function (pc) {
        if (prev) {
          var sep = itemSep(prev.item, pc.item, text, pc.text);   // from the PDF's own text items when the span is tied to one
          if (sep !== null) { text += sep; }
          else {                                                   // otherwise measure the boxes on screen
            var h = Math.min(pc.box.b - pc.box.t, prev.box.b - prev.box.t);
            var ov = Math.min(prev.box.b, pc.box.b) - Math.max(prev.box.t, pc.box.t);
            if (ov < 0.5 * h) { text += '\n'; }
            else {
              var gap = Math.max(pc.box.l - prev.box.r, prev.box.l - pc.box.r);
              if (gap > 0.15 * h && !/\s$/.test(text) && !/^\s/.test(pc.text)) { text += ' '; }
            }
          }
        }
        text += pc.text;
        rects = rects.concat(pc.rects);
        prev = pc;
      });
      text = cleanText(text);
      if (!text) { return null; }

      var box = wraps[pageIdx].getBoundingClientRect();
      var merged = mergeRects(rects, (+pst[pageIdx].textEl.getAttribute('data-main-rotation') || 0) % 180 !== 0);
      var norm = normRects(merged, box);
      if (!norm.length) { return null; }
      var u = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
      rects.forEach(function (r) { u.l = Math.min(u.l, r.l); u.t = Math.min(u.t, r.t); u.r = Math.max(u.r, r.r); u.b = Math.max(u.b, r.b); });
      var sr = scroller.getBoundingClientRect();
      var vl = Math.max(u.l, sr.left), vt = Math.max(u.t, sr.top), vr = Math.min(u.r, sr.right), vb = Math.min(u.b, sr.bottom);
      var anchor = (vr > vl && vb > vt) ? { x: vl, y: vt, w: vr - vl, h: vb - vt } : { x: u.l, y: u.t, w: u.r - u.l, h: u.b - u.t };
      var sel = { page: pageIdx + 1, text: text, rects: norm, anchor: anchor };
      // A highlight lives on one page. If the drag ran on into later pages, only the part on the first page is kept: say so.
      if (!pst[pageIdx].textEl.contains(range.endContainer)) {
        var through = pageIdx, j, lay;
        for (j = pageIdx + 1; j < numPages; j++) {
          lay = pst[j].textEl;
          if (lay && range.intersectsNode(lay) && collectPieces(lay, range).length) { through = j; }
        }
        if (through > pageIdx) { sel.clipped = { kept: pageIdx + 1, through: through + 1 }; }
      }
      return sel;
    }

    /* Walks the text nodes of one text layer that the range covers; one piece per node with its client rects. */
    function collectPieces(layer, range) {
      var walker = doc.createTreeWalker(layer, 4 /* SHOW_TEXT */, null, false);
      var out = [], tn, so, eo, r, list, rs, k, box, rc;
      while ((tn = walker.nextNode())) {
        if (!range.intersectsNode(tn)) { continue; }
        so = tn === range.startContainer ? range.startOffset : 0;
        eo = tn === range.endContainer ? range.endOffset : tn.length;
        if (eo <= so) { continue; }
        r = doc.createRange();
        r.setStart(tn, so);
        r.setEnd(tn, eo);
        list = r.getClientRects();
        rs = [];
        box = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
        for (k = 0; k < list.length; k++) {
          rc = list[k];
          if (rc.width < 0.5 || rc.height < 0.5) { continue; }
          rs.push({ l: rc.left, t: rc.top, r: rc.right, b: rc.bottom });
          box.l = Math.min(box.l, rc.left); box.t = Math.min(box.t, rc.top);
          box.r = Math.max(box.r, rc.right); box.b = Math.max(box.b, rc.bottom);
        }
        if (!rs.length) { continue; }
        out.push({ text: tn.data.slice(so, eo), rects: rs, box: box, item: (tn.parentNode && tn.parentNode.__libItem) || null });
      }
      return out;
    }

    /* A drag with the mouse can end inside a word. Grow the selection to whole words, as a book reader does: on scanned
       papers the letter positions are only approximate, and whole words are what she means anyway. (Touch screens already
       select by word, and changing their selection while the handles are held would fight them.) */
    function snapToWords() {
      try {
        var s = win.getSelection();
        if (!s || !s.rangeCount || s.isCollapsed) { return; }
        var r = s.getRangeAt(0), sc = r.startContainer, ec = r.endContainer, so = r.startOffset, eo = r.endOffset, ch = false, d;
        function inLayer(n) { var p = n && n.parentNode; return !!(p && p.nodeType === 1 && p.closest && p.closest('.lib-text') && scroller.contains(p)); }
        if (sc.nodeType === 3 && inLayer(sc)) {
          d = sc.data;
          while (so > 0 && !/\s/.test(d.charAt(so - 1))) { so--; ch = true; }
        }
        if (ec.nodeType === 3 && inLayer(ec)) {
          d = ec.data;
          while (eo < d.length && !/\s/.test(d.charAt(eo))) { eo++; ch = true; }
        }
        if (!ch) { return; }
        if (s.direction === 'backward' && s.setBaseAndExtent) { s.setBaseAndExtent(ec, eo, sc, so); }
        else { r.setStart(sc, so); r.setEnd(ec, eo); s.removeAllRanges(); s.addRange(r); }
      } catch (e) { /* the selection stays as the browser made it */ }
    }

    function emitSel(force) {
      if (destroyed) { return; }
      if (!force && snapNext && !mouseDown && lastPointerType !== 'touch') { snapNext = false; snapToWords(); }
      var sel = null;
      try { sel = readSelection(); } catch (e) { sel = null; }
      var key = sel ? sel.page + '|' + sel.text + '|' + JSON.stringify(sel.rects) : '';
      if (!force && key === lastSelKey) { return; }
      if (force && key === '' && lastSelKey === '') { return; }
      lastSelKey = key;
      lastSel = sel;
      if (sel && sel.clipped && !force) { hint('That runs on to page ' + sel.clipped.through + '. Only the part on page ' + sel.clipped.kept + ' is kept.'); }
      if (o.onSelection) { try { o.onSelection(sel); } catch (e) { /* ignore */ } }
    }

    function clearSelection() {
      try {
        var s = win.getSelection();
        if (s && s.rangeCount && (scroller.contains(s.anchorNode) || scroller.contains(s.focusNode))) { s.removeAllRanges(); }
      } catch (e) { /* ignore */ }
      emitSel(true);
      return api;
    }

    on(doc, 'selectionchange', function () {
      if (mouseDown) { return; }                    // wait for the mouse button to come up
      later('sel', emitSel, lastPointerType === 'touch' ? 350 : 160);
    });

    /* PDF.js trick: a block after the last span keeps mouse selection from jumping across the page */
    on(scroller, 'mousedown', function (e) {
      var t = e.target, layer = null;
      while (t && t !== scroller) { if (t.classList && t.classList.contains('lib-text')) { layer = t; break; } t = t.parentNode; }
      if (!layer) { return; }
      var end = layer.querySelector('.endOfContent');
      if (!end) { return; }
      if (e.target !== layer && (layer.getAttribute('data-main-rotation') || '0') === '0') {   // (turned pages keep the plain behaviour)
        var b = layer.getBoundingClientRect();
        end.style.top = (Math.max(0, (e.clientY - b.top) / b.height) * 100).toFixed(2) + '%';
      }
      end.classList.add('active');
      activeEnd = end;
    });
    on(doc, 'mouseup', function () {
      if (activeEnd) { activeEnd.style.top = ''; activeEnd.classList.remove('active'); activeEnd = null; }
    }, true);

    /* ---------- pointer: tap on a highlight ---------- */
    var ptr = null;
    on(scroller, 'pointerdown', function (e) {
      lastPointerType = e.pointerType || 'mouse';
      if (e.pointerType === 'mouse') { if (e.button !== 0) { return; } mouseDown = true; snapNext = true; }
      ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
    });
    on(scroller, 'pointermove', function (e) {
      if (!ptr || e.pointerId !== ptr.id || ptr.moved) { return; }
      var dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
      if (dx * dx + dy * dy > 64) { ptr.moved = true; }
    });
    on(scroller, 'pointercancel', function () { ptr = null; });
    /* A mouse drag, or a long press with a finger, on a page that has no text (a scan): say why nothing gets selected. */
    function noTextHint(p, e) {
      if (!numPages) { return; }
      var held = Date.now() - p.t;
      if (!(e.pointerType === 'mouse' ? (p.moved && held > 120) : (!p.moved && held >= 450))) { return; }
      var r = scroller.getBoundingClientRect();
      if (p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) { return; }
      var idx = pageAtY(scroller.scrollTop + (p.y - r.top)), st = pst[idx], wr = wraps[idx].getBoundingClientRect();
      if (p.x < wr.left || p.x > wr.right || p.y < wr.top || p.y > wr.bottom) { return; }
      if (!st || !st.textEl || /\S/.test(st.textEl.textContent)) { return; }       // not drawn yet, or it has text
      var s = win.getSelection && win.getSelection();
      if (s && !s.isCollapsed) { return; }
      hint('This page is a picture of text, so it cannot be selected.');
      if (o.onNoText) { try { o.onNoText(idx + 1); } catch (e2) { /* ignore */ } }
    }
    on(scroller, 'pointerup', function (e) {
      var p = ptr;
      ptr = null;
      if (p && e.pointerId === p.id) { noTextHint(p, e); }
      if (!p || p.moved || e.pointerId !== p.id || Date.now() - p.t > 600) { return; }
      setTimeout(function () {
        if (destroyed) { return; }
        var s = win.getSelection && win.getSelection();
        if (s && !s.isCollapsed) { return; }
        hitTest(p.x, p.y);
      }, 0);
    });
    on(doc, 'pointerup', function (e) {
      if (e.pointerType === 'mouse' && mouseDown) { mouseDown = false; later('sel', emitSel, 20); }
    }, true);
    on(doc, 'mouseup', function () { if (mouseDown) { mouseDown = false; later('sel', emitSel, 20); } }, true);

    function hitTest(cx, cy) {
      if (!numPages || !o.onHighlightTap) { return; }
      var r = scroller.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) { return; }
      var p = pageAtY(scroller.scrollTop + (cy - r.top)), wr = wraps[p].getBoundingClientRect();
      if (cx < wr.left || cx > wr.right || cy < wr.top || cy > wr.bottom) { return; }
      var nx = (cx - wr.left) / wr.width, ny = (cy - wr.top) / wr.height, best = null, bestRect = null, bestArea = Infinity;
      (hlByPage[p + 1] || []).forEach(function (h) {
        h.rects.forEach(function (q) {
          if (nx >= q[0] && nx <= q[0] + q[2] && ny >= q[1] && ny <= q[1] + q[3] && q[2] * q[3] < bestArea) { best = h; bestRect = q; bestArea = q[2] * q[3]; }
        });
      });
      if (!best) { return; }
      var L = wr.left + bestRect[0] * wr.width, T = wr.top + bestRect[1] * wr.height, W = bestRect[2] * wr.width, Hh = bestRect[3] * wr.height;
      try { o.onHighlightTap(best.id, { x: L, y: T, width: W, height: Hh, left: L, top: T, right: L + W, bottom: T + Hh }); } catch (e) { /* ignore */ }
    }

    /* ---------- pinch (touch) and ctrl+wheel (trackpad pinch) zoom ---------- */
    function dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
    on(scroller, 'touchstart', function (e) {
      if (e.touches.length === 2 && numPages) {
        var cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var r = scroller.getBoundingClientRect();
        pinch = { d0: dist(e.touches) || 1, s0: refScale(), r: 1, cx: cx, cy: cy };
        pagesEl.style.transformOrigin = (scroller.scrollLeft + cx - r.left) + 'px ' + (scroller.scrollTop + cy - r.top) + 'px';
      }
    }, { passive: true });
    on(scroller, 'touchmove', function (e) {
      if (!pinch || e.touches.length !== 2) { return; }
      if (e.cancelable) { e.preventDefault(); }
      var r = dist(e.touches) / pinch.d0;
      r = Math.max(minZoom() / pinch.s0, Math.min(MAX_ZOOM / pinch.s0, r));
      pinch.r = r;
      pinch.cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinch.cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      pagesEl.style.transform = 'scale(' + r + ')';
    }, { passive: false });
    function endPinch() {
      if (!pinch) { return; }
      var p = pinch;
      pinch = null;
      pagesEl.style.transform = '';
      pagesEl.style.transformOrigin = '';
      if (Math.abs(p.r - 1) > 0.01) { setZoom(p.s0 * p.r, { clientX: p.cx, clientY: p.cy }, true); }
    }
    on(scroller, 'touchend', function (e) { if (pinch && e.touches.length < 2) { endPinch(); } }, { passive: true });
    on(scroller, 'touchcancel', function () { endPinch(); }, { passive: true });
    // Safari's own page-zoom gesture must not fight the reader
    on(scroller, 'gesturestart', function (e) { if (e.cancelable) { e.preventDefault(); } });
    on(scroller, 'gesturechange', function (e) { if (e.cancelable) { e.preventDefault(); } });

    on(scroller, 'wheel', function (e) {
      if (!e.ctrlKey || !numPages) { return; }
      e.preventDefault();
      var k = e.deltaMode === 1 ? 0.05 : 0.012;
      wheelAcc = wheelAcc || { f: 1, x: e.clientX, y: e.clientY };
      wheelAcc.f *= Math.exp(-e.deltaY * k);
      wheelAcc.x = e.clientX; wheelAcc.y = e.clientY;
      soon('wheel', function () {
        var w = wheelAcc; wheelAcc = null;
        if (w) { setZoom(refScale() * w.f, { clientX: w.x, clientY: w.y }, true); }
      }, 30);
    }, { passive: false });

    /* ---------- keyboard ---------- */
    function promptGoTo() {
      if (!numPages) { return api; }
      if (!gotoEl) {
        gotoEl = el('form', 'lib-goto');
        var lab = el('label'); lab.textContent = 'Go to page';
        gotoInput = el('input');
        gotoInput.type = 'number';
        gotoInput.min = '1';
        gotoInput.setAttribute('inputmode', 'numeric');
        gotoInput.setAttribute('aria-label', 'Go to page');
        gotoHint = el('span');
        lab.appendChild(doc.createTextNode(' '));
        gotoEl.appendChild(lab);
        gotoEl.appendChild(gotoInput);
        gotoEl.appendChild(gotoHint);
        gotoEl.hidden = true;
        container.appendChild(gotoEl);
        on(gotoEl, 'submit', function (e) {
          e.preventDefault();
          var v = parseInt(gotoInput.value, 10);
          hideGoto();
          if (isFinite(v)) { goTo(v); }
        });
        on(gotoInput, 'keydown', function (e) {
          if (e.key === 'Escape') { e.preventDefault(); hideGoto(); }
          e.stopPropagation();
        });
        on(gotoInput, 'blur', function () { later('gotoblur', hideGoto, 150); });
      }
      gotoInput.max = String(numPages);
      gotoInput.placeholder = String(curPage || 1);
      gotoHint.textContent = 'of ' + numPages;
      gotoInput.value = '';
      gotoEl.hidden = false;
      gotoInput.focus();
      return api;
    }
    function hideGoto() {
      if (gotoEl && !gotoEl.hidden) {
        var had = doc.activeElement === gotoInput;
        gotoEl.hidden = true;
        if (had) { try { scroller.focus({ preventScroll: true }); } catch (e) { scroller.focus(); } }
      }
    }

    function scrollByY(dy) { scroller.scrollTop += dy; soon('upd', tick, 0); }

    on(doc, 'keydown', function (e) {
      if (destroyed || !numPages || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.shiftKey && /^(Arrow|Home$|End$|Page)/.test(e.key))) { return; }
      var t = e.target;
      if (isTypingTarget(t)) { return; }
      var inside = scroller.contains(t) || container.contains(t), onBody = t === doc.body || t === doc.documentElement || !t;
      if (!inside && !onBody) { return; }
      if (!scroller.clientHeight) { return; }          // hidden
      var H = scroller.clientHeight, handled = true;
      switch (e.key) {
        case 'ArrowDown': scrollByY(48); break;
        case 'ArrowUp': scrollByY(-48); break;
        case 'PageDown': scrollByY(H * 0.9); break;
        case 'PageUp': scrollByY(-H * 0.9); break;
        case ' ': scrollByY(e.shiftKey ? -H * 0.9 : H * 0.9); break;
        case 'ArrowRight':
          if (scroller.scrollWidth > scroller.clientWidth + 2) { scroller.scrollLeft += 48; } else { goTo((curPage || 1) + 1); }
          break;
        case 'ArrowLeft':
          if (scroller.scrollWidth > scroller.clientWidth + 2) { scroller.scrollLeft -= 48; } else { goTo((curPage || 1) - 1); }
          break;
        case 'Home': goTo(1); break;
        case 'End': goTo(numPages); break;
        case '+': case '=': zoomBy(1); break;
        case '-': case '_': zoomBy(-1); break;
        case '0': setZoom('fit'); break;
        case 'g': case 'G': promptGoTo(); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); }
    });

    /* ---------- loading ---------- */
    function closeDoc() {
      var i;
      for (i = 0; i < numPages; i++) { if (pst[i]) { cancelTasks(pst[i]); freeCanvas(pst[i].canvas); } }
      if (io) { io.disconnect(); }
      pagesEl.textContent = '';
      wraps = []; parts = []; pst = []; sizes = []; tops = []; scales = []; live = {};
      numPages = 0; curPage = 0; lastAnchor = null; lastSelKey = ''; lastSel = null; errorShown = false;
      var task = loadingTask, d = pdf;
      pdf = null; loadingTask = null;
      try { if (d) { d.destroy(); } else if (task) { task.destroy(); } } catch (e) { /* ignore */ }
      if (task && d) { try { task.destroy(); } catch (e2) { /* ignore */ } }
    }

    function toBytes(src) {
      // PDF.js hands the bytes to its worker and detaches them, so it always gets its own copy.
      if (typeof src === 'string') {
        return fetch(src).then(function (r) {
          if (!r.ok) { throw new Error('Failed to fetch'); }
          return r.arrayBuffer();
        }).then(function (b) { return { buf: b, url: null }; }, function () { return { buf: null, url: src }; });
      }
      if (src instanceof ArrayBuffer) { return Promise.resolve({ buf: src.slice(0), url: null }); }
      if (ArrayBuffer.isView && ArrayBuffer.isView(src)) {
        return Promise.resolve({ buf: src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength), url: null });
      }
      if (typeof Blob !== 'undefined' && src instanceof Blob) {
        if (src.arrayBuffer) { return src.arrayBuffer().then(function (b) { return { buf: b, url: null }; }); }
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve({ buf: fr.result, url: null }); };
          fr.onerror = function () { reject(new Error('read failed')); };
          fr.readAsArrayBuffer(src);
        });
      }
      return Promise.reject(new Error('Unsupported source'));
    }

    function fail(err, token) {
      var msg = friendlyError(err);
      if (token === loadToken) {
        pendingGo = null;                          // a jump asked for before a load that failed must not leak into the next file
        showMsg(msg);
        if (o.onError) { try { o.onError(msg, { fatal: true }); } catch (e) { /* ignore */ } }
      }
      var e2 = new Error(msg);
      e2.cause = err;
      return Promise.reject(e2);
    }

    function load(src) {
      if (destroyed) { return Promise.reject(new Error('This reader was closed.')); }
      var token = ++loadToken, lib = win.pdfjsLib;
      closeDoc();
      if (!lib || typeof lib.getDocument !== 'function') { return fail(new Error('pdfjsLib is not loaded'), token); }
      try { if (!lib.GlobalWorkerOptions.workerSrc) { lib.GlobalWorkerOptions.workerSrc = WORKER_URL; } } catch (e) { /* ignore */ }
      showMsg('Opening\u2026');
      var fingerprint = '', info = null;

      return toBytes(src).then(function (b) {
        if (token !== loadToken) { return null; }
        var fp = b.buf && win.Lib && win.Lib.files && win.Lib.files.fingerprint ? win.Lib.files.fingerprint(b.buf) : Promise.resolve('');
        return fp.then(function (f) {
          if (token !== loadToken || destroyed) { return null; }      // replaced while the fingerprint was computed: do not start a second worker
          fingerprint = f || '';
          var params = { cMapUrl: o.cMapUrl || CMAP_URL, cMapPacked: true, standardFontDataUrl: o.standardFontDataUrl || FONT_URL };
          if (b.buf) { params.data = new Uint8Array(b.buf); } else { params.url = b.url; }
          loadingTask = lib.getDocument(params);
          return loadingTask.promise;
        });
      }).then(function (d) {
        if (!d) { return null; }
        if (token !== loadToken || destroyed) { try { d.destroy(); } catch (e) { /* ignore */ } return null; }
        pdf = d;
        if (!fingerprint && d.fingerprints && d.fingerprints[0]) { fingerprint = 'pdfjs-' + String(d.fingerprints[0]).slice(0, 10); }
        return Promise.all([d.getPage(1), d.getMetadata().then(function (m) {
          var t = (m && m.info && m.info.Title) || '';
          try { if (!t && m && m.metadata && m.metadata.get) { t = m.metadata.get('dc:title') || ''; } } catch (e) { /* ignore */ }
          return String(t || '').replace(/\s+/g, ' ').trim();
        }, function () { return ''; })]).then(function (res) {
          if (token !== loadToken || destroyed) { return null; }
          var v = res[0].getViewport({ scale: 1 });
          buildPages(d.numPages, v.width, v.height);
          info = { numPages: d.numPages, title: res[1], fingerprint: fingerprint };
          showMsg('');
          layout();
          drawAllHl();
          var go = pendingGo; pendingGo = null;
          scroller.scrollTop = 0;
          curPage = 0;
          if (go) { goTo(go.p, go.o); } else { tick(); }
          if (!curPage) { tick(); }
          if (o.onReady) { try { o.onReady(info); } catch (e) { /* ignore */ } }
          prefetchSizes(d, token);
          return info;
        });
      }).then(function (r) { return r; }, function (err) {
        if (err && err.message === 'This reader was closed.') { return Promise.reject(err); }
        // a newer load() or destroy() replaced this one (it tore this one's task down, which looks like a failure): resolve null, as documented
        if (token !== loadToken || destroyed) { return null; }
        return fail(err, token);
      });
    }

    function buildPages(n, w0, h0) {
      var frag = doc.createDocumentFragment(), i, w, cv, hl, tx;
      numPages = n;
      for (i = 0; i < n; i++) {
        w = el('div', 'lib-page');
        w.setAttribute('data-n', String(i + 1));
        w.setAttribute('role', 'group');
        w.setAttribute('aria-label', 'Page ' + (i + 1));
        cv = el('div', 'lib-cv');
        hl = el('div', 'lib-hl');
        tx = el('div', 'lib-text');
        w.appendChild(cv); w.appendChild(hl); w.appendChild(tx);
        frag.appendChild(w);
        wraps.push(w);
        parts.push({ cv: cv, hl: hl, text: tx });
        sizes.push({ w: w0, h: h0 });
        tops.push(0);
        scales.push(1);
        pst.push({ tok: 0, busy: false, canvas: null, textEl: null, page: null, scale: 0, os: 0, renderScale: 0, task: null, textTask: null, failed: false });
      }
      pagesEl.appendChild(frag);
      if (io) { for (i = 0; i < n; i++) { io.observe(wraps[i]); } }
    }

    function drawAllHl() {
      var k;
      for (k in hlByPage) { if (+k >= 1 && +k <= numPages) { drawHl(+k); } }
    }

    /* Page sizes of the other pages, read in the background so the scroll length is right. */
    function prefetchSizes(d, token) {
      var next = 1, changed = false, BATCH = 8;
      function alive() { return !destroyed && token === loadToken && pdf === d; }
      function applyChanges() {
        if (!changed) { return; }
        changed = false;
        relayout();
      }
      function step() {
        if (!alive()) { return; }
        if (next >= numPages) { applyChanges(); return; }
        var batch = [], k;
        for (k = 0; k < BATCH && next < numPages; k++) { batch.push(next++); }
        Promise.all(batch.map(function (idx) {
          return d.getPage(idx + 1).then(function (pg) {
            var v = pg.getViewport({ scale: 1 });
            if (alive() && (Math.abs(v.width - sizes[idx].w) > 0.5 || Math.abs(v.height - sizes[idx].h) > 0.5)) {
              sizes[idx] = { w: v.width, h: v.height };
              changed = true;
            }
          }, function () { /* a broken page is reported when it is drawn */ });
        })).then(function () {
          if (!alive()) { return; }
          if (changed && (next % 64 === 0 || next >= numPages)) { applyChanges(); }
          setTimeout(step, 0);
        });
      }
      setTimeout(step, 0);
    }

    function getText(n) {
      n = Math.round(+n);
      var d = pdf;
      if (!d || !(n >= 1) || n > numPages) { return Promise.resolve(''); }
      return d.getPage(n).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
        var s = '', prev = null;
        tc.items.forEach(function (it) {
          if (it.str === undefined) { return; }
          s += itemSep(prev, it, s, it.str) || '';
          s += it.str;
          prev = it;
        });
        return cleanText(s);
      }).then(null, function () { return ''; });
    }

    /* ---------- diagnostics ---------- */
    function stats() {
      var canv = container.querySelectorAll('canvas').length, texts = 0, k;
      for (k in live) { if (pst[k] && pst[k].textEl) { texts++; } }
      return { pages: numPages, canvases: canv, textLayers: texts, busy: countBusy(), scale: refScale(), zoomMode: zoomMode, page: curPage, scrollTop: scroller.scrollTop };
    }

    function whenIdle() {
      return new Promise(function (resolve) {
        if (!numPages) { resolve(); return; }
        idleWaiters.push(resolve);
        soon('upd', tick, 0);
        setTimeout(function () { var i = idleWaiters.indexOf(resolve); if (i >= 0) { idleWaiters.splice(i, 1); resolve(); } }, 15000);
      });
    }

    /* ---------- destroy ---------- */
    function destroy() {
      if (destroyed) { return; }
      destroyed = true;
      var k, i;
      for (k in timers) { if (timers[k]) { clearTimeout(timers[k]); } }
      clearTimeout(pulseTimer);
      clearTimeout(hintTimer);
      for (i = 0; i < listeners.length; i++) {
        try { listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]); } catch (e) { /* ignore */ }
      }
      listeners = [];
      if (io) { io.disconnect(); io = null; }
      if (ro) { ro.disconnect(); ro = null; }
      closeDoc();
      if (scroller.parentNode) { scroller.parentNode.removeChild(scroller); }
      if (msgEl.parentNode) { msgEl.parentNode.removeChild(msgEl); }
      if (gotoEl && gotoEl.parentNode) { gotoEl.parentNode.removeChild(gotoEl); }
      container.classList.remove('lib-reader', 'lib-night', 'lib-paper');
      if (prevPosition !== null) { container.style.position = prevPosition; }
      idleWaiters.forEach(function (f) { f(); });
      idleWaiters = [];
      hlByPage = {}; hlAll = [];
    }

    var api = {
      el: scroller,
      load: load,
      setHighlights: setHighlights,
      goTo: goTo,
      page: function () { return curPage || (numPages ? 1 : 0); },
      numPages: function () { return numPages; },
      setZoom: function (z) { return setZoom(z); },
      zoomBy: function (d) { return zoomBy(d); },
      zoom: zoomInfo,
      setNight: setNight,
      night: function () { return night; },
      getText: getText,
      getSelection: function () { try { return readSelection(); } catch (e) { return null; } },
      clearSelection: clearSelection,
      promptGoTo: promptGoTo,
      whenIdle: whenIdle,
      stats: stats,
      fitInfo: function (p) { var s2 = pst[(p | 0) - 1]; return s2 && s2.fit ? s2.fit : null; },
      destroy: destroy
    };
    return api;
  };

  root.Lib.reader = reader;
  if (typeof module !== 'undefined') { module.exports = root.Lib.reader; }
})();
