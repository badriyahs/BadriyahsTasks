/* Library screens: Shelf, Notes, Cite, search and the reader overlay. Talks to Lib.store, Lib.cite, Lib.search, Lib.files, Lib.reader. */
(function(){
  "use strict";
  var Lib = window.Lib || {};
  var S = Lib.store, C = Lib.cite, Q = Lib.search, F = Lib.files, R = Lib.reader;
  var KINDS = [{k: 'idea', w: 'Idea'}, {k: 'evidence', w: 'Evidence'}, {k: 'quote', w: 'Quote'}, {k: 'question', w: 'Question'}];
  var STATUS = {'not-started': 'To read', 'reading': 'Reading', 'finished': 'Finished'};
  var STYLES = [{k: 'apa', w: 'APA'}, {k: 'chicago', w: 'Chicago'}, {k: 'mla', w: 'MLA'}, {k: 'bibtex', w: 'BibTeX'}];
  var TYPES = [['article', 'Article'], ['book', 'Book'], ['chapter', 'Chapter'], ['thesis', 'Thesis'], ['web', 'Web page'], ['other', 'Other']];
  var KEY_STYLE = 'badriyah-library-style', KEY_NIGHT = 'badriyah-library-night', KEY_TIP = 'badriyah-library-tip';
  var tipSeen = false; try { tipSeen = !!localStorage.getItem(KEY_TIP); } catch(e){}

  var state = {view: 'shelf', filter: 'all', scope: '', nextSkip: 0, notesFilter: 'all', notesProject: '', citeProject: '', citeStyle: 'apa', citeScope: 'marked', q: ''};
  try { var st = localStorage.getItem(KEY_STYLE); if(st) state.citeStyle = st; } catch(e){}

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function iso(){ return new Date().toISOString(); }
  function debounce(fn, ms){ var t; var f = function(){ var a = arguments, me = this; clearTimeout(t); t = setTimeout(function(){ fn.apply(me, a); }, ms); }; f.flush = function(){ clearTimeout(t); }; return f; }
  function hlWord(k){ for(var i = 0; i < KINDS.length; i++) if(KINDS[i].k === k) return KINDS[i].w; return 'Highlight'; }
  function byId(list, id){ for(var i = 0; i < list.length; i++) if(list[i].id === id) return list[i]; return null; }
  function sources(){ return (S && S.sources) || []; }
  function srcById(id){ return byId(sources(), id); }
  function plain(html){ var d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; }
  // text typed by her can be Arabic: let each line run in its own direction
  function dirA(t){ return ' dir="auto"' + (/[\u0600-\u06FF]/.test(t || '') ? ' lang="ar"' : ''); }
  // a write that fails must say so in plain words, never pretend it worked
  function failed(e){ toast((e && e.message) || 'That could not be saved. Try again.'); }
  function guard(p){ if(p && typeof p.then === 'function') p.then(null, failed); return p; }
  // keep the keyboard where it was when a screen redraws
  function focusKey(el){
    if(!el || el === document.body || !el.getAttribute || !$('lb').contains(el)) return '';
    var a = ['data-filter', 'data-nfilter', 'data-cstyle'], i;
    for(i = 0; i < a.length; i++) if(el.hasAttribute(a[i])) return '[' + a[i] + '="' + el.getAttribute(a[i]) + '"]';
    if(el.id) return '#' + el.id;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    return act ? '[data-act="' + act + '"]' + (id ? '[data-id="' + id + '"]' : '') : '';
  }
  function refocus(key){ if(!key) return; var n = $('lb').querySelector(key); if(n && n !== document.activeElement) try { n.focus(); } catch(e){} }
  // while a sheet or the reader is open, the page behind it cannot be tabbed into
  function syncInert(){
    var sheet = !$('lbsheet').hidden, reader = !$('lbreader').hidden, bg = document.querySelectorAll('#lb, .tabbar, .topbar'), i;
    for(i = 0; i < bg.length; i++) bg[i].inert = sheet || reader;
    $('lbreader').inert = sheet;
  }

  /* ---------- small helpers ---------- */
  function shortBy(s){
    var names = [];
    try { names = C.parseAuthors(s.author || '').map(function(a){ return a.family || a.literal || ''; }).filter(Boolean); } catch(e){}
    var by = names.length > 2 ? names[0] + ' et al.' : names.join(' & ');
    return [by, s.year].filter(Boolean).join(' · ');
  }
  function toast(msg, undo){
    var el = $('lbtoast'); clearTimeout(toast.t);
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button type="button">Undo</button>' : '');
    el.hidden = false;
    if(undo) el.querySelector('button').onclick = function(){ el.hidden = true; undo(); };
    toast.t = setTimeout(function(){ el.hidden = true; }, undo ? 7000 : 2600);
  }
  function copy(text, html){
    function legacy(){ var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch(e){} document.body.removeChild(ta); return ok ? Promise.resolve() : Promise.reject(new Error('copy')); }
    try {
      if(html && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write){
        return navigator.clipboard.write([new ClipboardItem({'text/plain': new Blob([text], {type: 'text/plain'}), 'text/html': new Blob([html], {type: 'text/html'})})]).catch(legacy);
      }
      if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(legacy);
    } catch(e){}
    return legacy();
  }
  function download(name, text, type){
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type: type || 'text/plain'})); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
  }
  function setStatusLine(){
    var line = $('lbstatus'), dot = $('syncdot'), txt = $('syncstate');
    var ok = S && S.status === 'ok', err = S && S.status === 'err';
    if(dot){ dot.className = 'dot ' + (ok ? '' : err ? 'err' : 'off'); }
    if(txt) txt.textContent = ok ? 'Synced' : err ? 'Not connected' : 'Connecting…';
    if(line){ line.hidden = !err; line.textContent = err ? (S.error || 'The library could not load. Check the connection and try again.') : ''; }
  }

  /* ---------- sheet ---------- */
  var sheetClose = null, sheetBack = '';
  function openSheet(html, onClose){
    var sh = $('lbsheet');
    if(sh.hidden){ sheetBack = focusKey(document.activeElement); }
    sh.innerHTML = '<button type="button" class="lb-close" data-act="closesheet" aria-label="Close">×</button>' + html;
    sh.hidden = false; $('lbscrim').hidden = false; sh.scrollTop = 0; sheetClose = onClose || null;
    syncInert();
    var f = sh.querySelector('[data-autofocus]') || sh.querySelector('.lb-close'); if(f) try { f.focus(); } catch(e){}
    return sh;
  }
  function closeSheet(){
    var sh = $('lbsheet'); if(sh.hidden) return;
    var cb = sheetClose; sheetClose = null; if(cb) cb();   // a note saves itself while its fields still exist
    sh.hidden = true; $('lbscrim').hidden = true; sh.innerHTML = ''; sh.removeAttribute('data-sid');
    syncInert();
    if($('lbreader').hidden){ refocus(sheetBack); } else { try { $('rback').focus(); } catch(e){} }
    sheetBack = '';
  }

  /* ---------- derived data ---------- */
  var counts = {hl: {}, notes: {}}, NOTES = [], HL = [];   // NOTES = notes made in the Library (the old quick notes stay on the Notes page)
  var index = null, indexDirty = true;
  function recount(){
    counts = {hl: {}, notes: {}};
    NOTES = (S.notes || []).filter(function(n){ return !!n.createdAt; });
    HL = (S.highlights || []).filter(function(h){ return !h.sourceId || !!srcById(h.sourceId); });
    HL.forEach(function(h){ if(h.sourceId) counts.hl[h.sourceId] = (counts.hl[h.sourceId] || 0) + 1; });
    NOTES.forEach(function(n){ if(n.sourceId) counts.notes[n.sourceId] = (counts.notes[n.sourceId] || 0) + 1; });
  }
  function getIndex(){
    if(!indexDirty && index) return index;
    var items = [];
    sources().forEach(function(s){ items.push({id: s.id, kind: 'source', title: s.title, author: s.author, tags: s.tags || [], project: s.project || '', text: [s.note, s.venue, s.category, s.year].filter(Boolean).join(' '), updatedAt: s.addedAt || ''}); });
    NOTES.forEach(function(n){ items.push({id: n.id, kind: 'note', title: n.title, tags: n.tags || [], project: n.project || '', text: n.text, sourceId: n.sourceId, updatedAt: n.updatedAt || n.createdAt || ''}); });
    HL.forEach(function(h){ items.push({id: h.id, kind: 'highlight', title: '', tags: h.tags || [], project: h.project || '', text: h.text, quote: h.quote, page: h.page, sourceId: h.sourceId, updatedAt: h.updatedAt || h.createdAt || ''}); });
    index = Q.build(items); indexDirty = false; return index;
  }
  function projects(){ try { return S.projects(); } catch(e){ return []; } }
  function categories(){
    var seen = {}, out = [];
    sources().forEach(function(s){ if(s.category && !seen[s.category]){ seen[s.category] = 1; out.push(s.category); } });
    return out.sort();
  }

  /* ---------- shelf ---------- */
  function isHigh(s){ return /^high$/i.test(String((s && s.priority) || '').trim()); }
  function statusRank(s){ return s.status === 'reading' ? 0 : s.status === 'finished' ? 3 : (isHigh(s) ? 1 : 2); }
  function shelfList(){
    var list = sources().filter(function(s){
      if(state.filter === 'reading' && s.status !== 'reading') return false;
      if(state.filter === 'todo' && s.status !== 'not-started') return false;
      if(state.filter === 'finished' && s.status !== 'finished') return false;
      if(state.scope.indexOf('c:') === 0 && s.category !== state.scope.slice(2)) return false;
      if(state.scope.indexOf('p:') === 0 && s.project !== state.scope.slice(2)) return false;
      return true;
    });
    list.sort(function(a, b){ return statusRank(a) - statusRank(b) || (a.order || 0) - (b.order || 0); });
    return list;
  }
  function pickNext(){
    var cand = sources().filter(function(s){ return s.status !== 'finished'; });
    cand.sort(function(a, b){ return statusRank(a) - statusRank(b) || (a.order || 0) - (b.order || 0); });
    if(!cand.length) return null;
    return cand[state.nextSkip % cand.length];
  }
  function renderShelf(){
    var all = sources(), el = $('v-shelf');
    var nRead = all.filter(function(s){ return s.status === 'reading'; }).length, nTodo = all.filter(function(s){ return s.status === 'not-started'; }).length, nDone = all.filter(function(s){ return s.status === 'finished'; }).length;
    var nx = pickNext(), html = '';
    if(!tipSeen && all.length){ html += '<p class="lb-tip">Tap a paper, then Read. Select any text to mark it as an Idea, Evidence, Quote or Question. <button type="button" data-act="tipoff">Got it</button></p>'; }
    if(nx){
      html += '<div class="lb-next"><p class="k">' + (nx.status === 'reading' ? 'Keep reading' : 'Read next') + '</p><h2' + dirA(nx.title) + '>' + esc(nx.title || 'Untitled') + '</h2><p class="by"' + dirA(shortBy(nx)) + '>' + esc(shortBy(nx)) + '</p>' +
        '<div class="acts"><button type="button" class="lb-btn primary" data-act="read" data-id="' + esc(nx.id) + '">' + (nx.lastPage > 1 ? 'Continue on page ' + nx.lastPage : 'Begin') + '</button>' +
        '<button type="button" class="lb-btn" data-act="another">Another</button></div></div>';
    }
    var pills = [['all', 'All', all.length], ['reading', 'Reading', nRead], ['todo', 'To read', nTodo], ['finished', 'Finished', nDone]];
    html += '<div class="lb-pills" role="group" aria-label="Show">' + pills.map(function(p){ return '<button type="button" data-filter="' + p[0] + '"' + (state.filter === p[0] ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + p[1] + ' ' + p[2] + '</button>'; }).join('') + '</div>';
    var cats = categories(), pr = projects();
    if(state.scope && (state.scope.indexOf('c:') === 0 ? cats : pr).indexOf(state.scope.slice(2)) < 0) state.scope = '';
    if(cats.length || pr.length){
      html += '<div class="lb-bar"><select class="lb-select" id="scope" aria-label="Collection"><option value="">Everything</option>' +
        (cats.length ? '<optgroup label="Shelves">' + cats.map(function(c){ return '<option value="c:' + esc(c) + '"' + (state.scope === 'c:' + c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</optgroup>' : '') +
        (pr.length ? '<optgroup label="Projects">' + pr.map(function(p){ return '<option value="p:' + esc(p) + '"' + (state.scope === 'p:' + p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</optgroup>' : '') + '</select>' +
        (F && F.folder && F.folder.available && F.folder.available() ? '<button type="button" class="lb-btn small quiet" data-act="folder">' + (F.folder.name && F.folder.name() ? 'PDF folder: ' + esc(F.folder.name()) : 'Connect my PDF folder') + '</button>' : '') + '</div>';
    }
    var list = shelfList();
    if(!all.length) html += '<p class="lb-empty">' + (S.status === 'ok' ? 'Your shelf is empty. Tap Add to bring in a paper.' : 'Loading your shelf…') + '</p>';
    else if(!list.length) html += '<p class="lb-empty">Nothing here yet.</p>';
    else html += '<div class="lb-list-rows" role="list">' + list.map(function(s){
      var meta = [];
      if(counts.hl[s.id]) meta.push(counts.hl[s.id] + (counts.hl[s.id] === 1 ? ' highlight' : ' highlights'));
      if(counts.notes[s.id]) meta.push(counts.notes[s.id] + (counts.notes[s.id] === 1 ? ' note' : ' notes'));
      if(/^\d+$/.test(String(s.pagesCount || ''))) meta.push(s.pagesCount + (+s.pagesCount === 1 ? ' page' : ' pages'));
      if(s.project) meta.push(s.project);
      if(s.status === 'reading' || s.status === 'finished') meta.unshift(STATUS[s.status]);
      return '<div class="lb-row" role="listitem" data-act="source" data-id="' + esc(s.id) + '"><span class="lb-dot ' + (s.status === 'reading' ? 'reading' : s.status === 'finished' ? 'finished' : '') + '" role="img" aria-label="' + esc(STATUS[s.status] || 'To read') + '"></span>' +
        '<div><h3' + dirA(s.title) + '><button type="button" class="lb-open" data-act="source" data-id="' + esc(s.id) + '">' + esc(s.title || 'Untitled') + '</button></h3><p class="by"' + dirA(shortBy(s)) + '>' + esc(shortBy(s)) + '</p>' + (meta.length ? '<p class="meta">' + esc(meta.join(' · ')) + '</p>' : '') + '</div>' +
        '<button type="button" class="star' + (isHigh(s) ? ' on' : '') + '" data-act="star" data-id="' + esc(s.id) + '" aria-label="' + (isHigh(s) ? 'Remove from read next' : 'Read this next') + '" title="Read this next">' + (isHigh(s) ? '★' : '☆') + '</button></div>';
    }).join('') + '</div>';
    html += '<p class="lb-foot"><a href="reading.html">Classic list and podcasts</a> · <a href="notes.html">Quick notes</a></p>';
    el.innerHTML = html;
  }

  /* ---------- reader ---------- */
  var rd = {reader: null, src: null, info: null, saveTimer: null, pending: 0, popId: null, sel: null, token: 0};
  var HL_STYLE_ID = 'lb-hlpop';

  function highlightsOf(id){ return (S.highlights || []).filter(function(h){ return h.sourceId === id; }).sort(function(a, b){ return (a.page || 0) - (b.page || 0) || (a.order || 0) - (b.order || 0); }); }
  function refreshMarks(){
    if(!rd.src) return;
    var hs = highlightsOf(rd.src.id);
    if(rd.reader) try { rd.reader.setHighlights(hs.map(function(h){ return {id: h.id, page: h.page, rects: h.rects || [], hl: h.hl}; })); } catch(e){}
    $('rcount').textContent = String(hs.length);
    if(!$('rpanel').hidden) renderPanel();
  }
  function renderPanel(){
    var s = rd.src; if(!s) return;
    var hs = highlightsOf(s.id), ns = NOTES.filter(function(n){ return n.sourceId === s.id; });
    var html = '<div class="lb-acts"><button type="button" class="lb-btn small" data-act="note-for" data-id="' + esc(s.id) + '">Write a note about this paper</button></div>';
    html += '<h4>Highlights</h4>' + (hs.length ? '<ul class="lb-list">' + hs.map(function(h){
      return '<li><button type="button" class="lnk" data-act="goto" data-page="' + (h.page || 1) + '" data-id="' + esc(h.id) + '"><span class="qt hl-' + esc(h.hl) + '">' + esc(h.quote || '') + '</span>' + (h.text ? '<span class="pg">' + esc(h.text) + '</span>' : '') + '<span class="pg">' + esc(hlWord(h.hl)) + ' · page ' + (h.page || '?') + '</span></button></li>';
    }).join('') + '</ul>' : '<p class="lb-empty" style="padding:8px 0;text-align:left">Select any text in the paper to mark it.</p>');
    if(ns.length) html += '<h4>Notes</h4><ul class="lb-list">' + ns.map(function(n){ return '<li><button type="button" class="lnk" data-act="note" data-id="' + esc(n.id) + '">' + esc(n.title || (n.text || '').split('\n')[0] || 'Note') + '</button></li>'; }).join('') + '</ul>';
    $('rpanel').innerHTML = html;
  }
  function hideSelTb(){ var tb = $('seltb'); tb.hidden = true; rd.sel = null; }
  function showSelTb(sel){
    var tb = $('seltb'); rd.sel = sel; tb.hidden = false;
    if(window.innerWidth <= 700){ tb.style.left = '50%'; tb.style.top = 'auto'; tb.style.bottom = 'calc(18px + env(safe-area-inset-bottom))'; tb.style.transform = 'translateX(-50%)'; return; }
    var a = sel.anchor || {x: 200, y: 200, w: 0, h: 0}, w = tb.offsetWidth || 360, h = tb.offsetHeight || 54;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, a.x + a.w / 2 - w / 2));
    var top = a.y - h - 10; if(top < 56) top = a.y + a.h + 10;
    tb.style.bottom = 'auto'; tb.style.transform = 'none'; tb.style.left = left + 'px'; tb.style.top = top + 'px';
  }
  function citeStyle(){ return state.citeStyle === 'bibtex' ? 'apa' : state.citeStyle; }
  // the same paper listed twice (two PDFs of one text) is cited once; works by one author in one year get a / b
  function dedupe(list){
    var seen = {};
    return list.filter(function(s){ var k = ''; try { k = C.format(s, 'apa').text; } catch(e){} if(!k) return true; if(seen[k]) return false; seen[k] = 1; return true; });
  }
  function yearLetters(style){
    var m = {};
    try { C.bibliography(dedupe(sources()), style === 'bibtex' ? 'apa' : style).entries.forEach(function(e){ if(e.id && e.suffix) m[e.id] = e.suffix; }); } catch(e){}
    return m;
  }
  function fmt(s, st){ var l = yearLetters(st)[s.id]; return C.format(s, st, l ? {suffix: l} : undefined); }
  function inTextOf(s, st, page){ var l = yearLetters(st)[s.id]; return C.inText(s, st, page, l ? {suffix: l} : undefined); }
  function quoteWithCite(src, quote, page){ var c = ''; try { c = inTextOf(src, citeStyle(), page); } catch(e){} return '“' + (quote || '').replace(/\s+/g, ' ').trim() + '” ' + c; }

  function closePopover(){ var p = document.getElementById(HL_STYLE_ID); if(p && p.parentNode) p.parentNode.removeChild(p); rd.popId = null; }
  function openPopover(id, rect){
    closePopover(); var h = byId(S.highlights || [], id); if(!h) return; rd.popId = id;
    var p = document.createElement('div'); p.className = 'lb-hlpop'; p.id = HL_STYLE_ID;
    p.innerHTML = '<div class="row">' + KINDS.map(function(k){ return '<button type="button" data-hl="' + k.k + '" class="hl-' + k.k + (h.hl === k.k ? ' cur' : '') + '">' + k.w + '</button>'; }).join('') + '</div>' +
      '<textarea placeholder="Add a thought (optional)" aria-label="Comment">' + esc(h.text || '') + '</textarea>' +
      '<div class="lb-acts" style="margin-top:8px"><button type="button" class="lb-btn small" data-pop="cite">Copy with citation</button><button type="button" class="lb-btn small" data-pop="note">Make a note</button><button type="button" class="lb-btn small quiet" data-pop="remove">Remove</button></div>';
    document.body.appendChild(p);
    var w = p.offsetWidth, ph = p.offsetHeight, r = rect || {left: 100, top: 100, bottom: 130, width: 0};
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, (r.left || 0) + (r.width || 0) / 2 - w / 2));
    var top = (r.bottom || 120) + 8; if(top + ph > window.innerHeight - 8) top = Math.max(8, (r.top || 100) - ph - 8);
    p.style.left = left + 'px'; p.style.top = top + 'px';
    var ta = p.querySelector('textarea');
    function saveCmt(){ var c0 = byId(S.highlights || [], id); if(c0 && ta.value !== (c0.text || '')) guard(S.updateHighlight(id, {text: ta.value})); }
    var save = debounce(saveCmt, 600);
    ta.addEventListener('input', save); ta.addEventListener('blur', function(){ save.flush(); saveCmt(); });
    p.addEventListener('click', function(e){
      var b = e.target.closest('button'); if(!b) return;
      if(b.getAttribute('data-hl')){ saveCmt(); guard(S.updateHighlight(id, {hl: b.getAttribute('data-hl')})); closePopover(); }
      else if(b.getAttribute('data-pop') === 'cite'){ copy(quoteWithCite(rd.src, h.quote, h.page)).then(function(){ toast('Copied'); }, function(){ toast('Could not copy'); }); }
      else if(b.getAttribute('data-pop') === 'note'){ saveCmt(); var cmt = ta.value; closePopover(); openNoteSheet(null, {sourceId: h.sourceId, text: '“' + (h.quote || '') + '” (p. ' + (h.page || '?') + ')\n\n' + cmt, title: ''}); }
      else if(b.getAttribute('data-pop') === 'remove'){ saveCmt(); S.archiveHighlight(id).then(function(){ closePopover(); toast('Highlight removed', function(){ guard(S.restoreHighlight(id)); }); }, failed); }
    });
  }

  function resolveFile(s){
    return F.cache.get(s.id).then(function(blob){
      if(blob){ try { blob.__fromCache = true; } catch(e){} return blob; }
      if(F.folder && F.folder.available && F.folder.available() && s.link && s.link.charAt(0) === '/'){
        return F.folder.find(s.link).then(function(f){ return f || null; }, function(){ return null; });
      }
      return null;
    }).then(function(found){
      if(found) return found;
      var u = /^https?:\/\/\S+\.pdf(\?|#|$)/i.test(s.link || '') ? s.link : (/^https?:\/\/\S+\.pdf(\?|#|$)/i.test(s.url || '') ? s.url : '');
      if(!u) return null;
      return fetch(u).then(function(r){ if(!r.ok) throw new Error('x'); return r.blob(); }).catch(function(){ return null; });
    });
  }
  function showChoose(s){
    var wantsName = s.link && s.link.charAt(0) === '/' ? s.link.split('/').pop() : '';
    var online = /^https?:\/\//i.test(s.link || s.url || '');
    var e = $('rempty'); e.hidden = false;
    e.innerHTML = '<p>' + (wantsName ? 'This paper is on your computer as <b>' + esc(wantsName) + '</b>.' : 'Choose the PDF for this paper.') + '<br>I remember it on this device after that.</p>' +
      '<div class="lb-acts" style="justify-content:center"><button type="button" class="lb-btn primary" data-act="pickpdf">Choose the PDF</button>' +
      (online ? '<a class="lb-btn" target="_blank" rel="noopener" href="' + esc(s.link || s.url) + '">Open the web page</a>' : '') + '</div>' +
      (F.folder && F.folder.available && F.folder.available() ? '<p style="margin-top:12px"><button type="button" class="lb-btn small quiet" data-act="folder">Connect my PDF folder to skip this</button></p>' : '');
  }
  function quiet(p){ if(p && typeof p.then === 'function') p.then(null, function(){}); return p; }   // background saves: no message
  function loadBlob(blob, s0, tok0){
    var s = s0 || rd.src, tok = tok0 == null ? rd.token : tok0;
    if(!s || !rd.reader || tok !== rd.token) return Promise.resolve();
    $('rempty').hidden = true;
    return (blob.arrayBuffer ? blob.arrayBuffer() : new Response(blob).arrayBuffer()).then(function(buf){
      return rd.reader.load(buf);
    }).then(function(info){
      if(tok !== rd.token) return;
      rd.info = info || {};
      var up = {};
      if(info && info.fingerprint && info.fingerprint !== s.fingerprint) up.fingerprint = info.fingerprint;
      if(info && info.numPages && !s.pagesCount) up.pagesCount = info.numPages;   // what she typed stays; the reader shows the real total
      if(Object.keys(up).length) quiet(S.updateSource(s.id, up));
      if(!blob.__fromCache) F.cache.put(s.id, blob);
      refreshMarks();
      var p = rd.startPage || (s.lastPage > 1 ? s.lastPage : 1);
      if(p > 1 || rd.startHl) try { rd.reader.goTo(p, {highlightId: rd.startHl}); } catch(e){}
      rd.startPage = 0; rd.startHl = null;
    }).catch(function(err){
      if(tok !== rd.token) return;
      showChoose(s); if(!rd.errShown) toast('That file would not open. Try choosing it again.');
    });
  }
  function openReader(id, opts){
    opts = opts || {};
    var s = srcById(id); if(!s) return;
    if(!R || !window.pdfjsLib){ toast('The reader could not load. Check the connection and refresh.'); return; }
    var backKey = focusKey(document.activeElement) || sheetBack;
    closeSheet(); closePopover();
    rd.backKey = backKey;
    rd.token++; rd.errShown = false; rd.src = s; rd.info = null; rd.startPage = opts.page || 0; rd.startHl = opts.highlightId || null;
    var rdEl = $('lbreader'); rdEl.hidden = false; document.documentElement.style.overflow = 'hidden'; syncInert(); try { $('rback').focus(); } catch(e){}
    $('rtitle').textContent = s.title || '';
    $('rpage').value = String(s.lastPage || 1); $('rtotal').textContent = '/ ' + (s.pagesCount || '…');
    $('rempty').hidden = true; $('rpanel').hidden = window.innerWidth < 900; if(!$('rpanel').hidden) renderPanel();
    var night = true; try { night = localStorage.getItem(KEY_NIGHT) !== 'paper'; } catch(e){}
    $('rnight').textContent = night ? 'Night' : 'Paper';
    if(rd.reader){ try { rd.reader.destroy(); } catch(e){} rd.reader = null; }
    $('rhost').innerHTML = '';
    rd.reader = R.mount($('rhost'), {
      night: night,
      onSelection: function(sel){ if(!sel || !sel.text){ hideSelTb(); } else { closePopover(); showSelTb(sel); } },
      onPage: function(n, total){ $('rpage').value = String(n); if(total) $('rtotal').textContent = '/ ' + total; scheduleSavePage(n); },
      onHighlightTap: function(hid, rect){ hideSelTb(); openPopover(hid, rect); },
      onError: function(msg){ rd.errShown = true; showChoose(s); toast(msg || 'That file would not open.'); }
    });
    $('rcount').textContent = String(highlightsOf(s.id).length);
    if(location.hash !== '#read/' + id) { try { history.replaceState(null, '', '#read/' + id); } catch(e){} }
    var tok0 = rd.token;
    resolveFile(s).then(function(blob){ if(tok0 !== rd.token) return; if(blob) loadBlob(blob, s, tok0); else showChoose(s); });
  }
  function scheduleSavePage(n){
    var s = rd.src; if(!s) return; rd.pending = n;
    clearTimeout(rd.saveTimer);
    rd.saveTimer = setTimeout(function(){ flushPage(); }, 4000);
  }
  function flushPage(){
    clearTimeout(rd.saveTimer); var s = rd.src; if(!s || !rd.pending) return;
    var cur = srcById(s.id) || s;   // the copy from when the reader opened may be out of date
    var up = {lastPage: rd.pending}; if(cur.status === 'not-started' && rd.pending > 1) up.status = 'reading';
    if(rd.pending !== cur.lastPage || up.status) quiet(S.updateSource(s.id, up));
    rd.pending = 0;
  }
  function closeReader(){
    flushPage(); hideSelTb(); closePopover();
    $('lbreader').hidden = true; document.documentElement.style.overflow = '';
    rd.token++;
    if(rd.reader){ try { rd.reader.destroy(); } catch(e){} rd.reader = null; }
    $('rhost').innerHTML = ''; rd.src = null;
    if(/^#read\//.test(location.hash)){ try { history.replaceState(null, '', '#' + state.view); } catch(e){} }
    syncInert();
    render();
    refocus(rd.backKey);
  }

  /* ---------- source sheet ---------- */
  function sourceSheet(id){
    var s = srcById(id); if(!s) return;
    var hs = highlightsOf(id), ns = NOTES.filter(function(n){ return n.sourceId === id; });
    var style = citeStyle(), cite = '';
    try { cite = fmt(s, style).html; } catch(e){}
    var pr = projects();
    var html = '<h2' + dirA(s.title) + '>' + esc(s.title || 'Untitled') + '</h2><p class="by"' + dirA(shortBy(s)) + '>' + esc(shortBy(s)) + '</p>' +
      '<div class="lb-acts"><button type="button" class="lb-btn primary" data-act="read" data-id="' + esc(id) + '">' + (s.lastPage > 1 ? 'Continue on page ' + s.lastPage : 'Read') + '</button>' +
      (/^https?:\/\//i.test(s.link || s.url || '') ? '<a class="lb-btn" target="_blank" rel="noopener" href="' + esc(s.link || s.url) + '">Open link</a>' : '') +
      '<button type="button" class="lb-btn" data-act="note-for" data-id="' + esc(id) + '">Add a note</button></div>' +
      '<div class="lb-pills" style="margin-top:12px" role="group" aria-label="Status">' + ['not-started', 'reading', 'finished'].map(function(k){ return '<button type="button" data-setstatus="' + k + '"' + (s.status === k ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + STATUS[k] + '</button>'; }).join('') + '</div>';
    if(s.note) html += '<h4>Summary</h4><div class="lb-note">' + esc(s.note) + '</div>';
    html += '<h4>Highlights ' + (hs.length ? hs.length : '') + '</h4>';
    html += hs.length ? '<ul class="lb-list">' + hs.map(function(h){ return '<li><button type="button" class="lnk" data-act="read" data-id="' + esc(id) + '" data-page="' + (h.page || 1) + '" data-hl="' + esc(h.id) + '"><span class="qt hl-' + esc(h.hl) + '">' + esc(h.quote || '') + '</span>' + (h.text ? '<span class="pg">' + esc(h.text) + '</span>' : '') + '<span class="pg">' + esc(hlWord(h.hl)) + ' · page ' + (h.page || '?') + '</span></button></li>'; }).join('') + '</ul>' : '<p class="lb-note">Nothing marked yet. Open the paper and select text.</p>';
    if(ns.length) html += '<h4>Notes</h4><ul class="lb-list">' + ns.map(function(n){ return '<li><button type="button" class="lnk" data-act="note" data-id="' + esc(n.id) + '">' + esc(n.title || (n.text || '').split('\n')[0] || 'Note') + '</button></li>'; }).join('') + '</ul>';
    html += '<h4>Cite</h4><div class="lb-cite" id="srccite">' + cite + '</div><div class="lb-acts">' + STYLES.map(function(st){ return '<button type="button" class="lb-btn small' + (st.k === style ? ' primary' : '') + '" data-cp="' + st.k + '">Copy ' + st.w + '</button>'; }).join('') + '</div>';
    html += '<h4>Details</h4><div class="lb-grid">' +
      field('title', 'Title', s.title, 'wide') + field('author', 'Authors (Family, Given; Family, Given)', s.author, 'wide') + field('year', 'Year', s.year) +
      '<label class="lb-field"><span>Type</span><select class="lb-select" data-f="type">' + TYPES.map(function(t){ return '<option value="' + t[0] + '"' + ((s.type || 'article') === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></label>' +
      field('venue', 'Journal or book', s.venue, 'wide') + field('volume', 'Volume', s.volume) + field('issue', 'Issue', s.issue) + field('pageRange', 'Pages (from–to)', s.pageRange) + field('publisher', 'Publisher', s.publisher) + field('place', 'Place', s.place) +
      '<label class="lb-field wide"><span>DOI</span><div style="display:flex;gap:8px"><input class="lb-input" data-f="doi" value="' + esc(s.doi || '') + '" style="flex:1"><button type="button" class="lb-btn small" data-act="lookup" data-id="' + esc(id) + '">Look up</button></div></label>' +
      field('url', 'Web link', s.url, 'wide') +
      '<label class="lb-field"><span>Project</span><select class="lb-select" data-f="project"><option value="">None</option>' + pr.map(function(p){ return '<option' + (s.project === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + (s.project && pr.indexOf(s.project) < 0 ? '<option selected>' + esc(s.project) + '</option>' : '') + '<option value="__new">New project…</option></select></label>' +
      field('tags', 'Tags (commas)', (s.tags || []).join(', ')) +
      '</div><div class="lb-acts" style="margin-top:18px"><button type="button" class="lb-btn small quiet" data-act="archive-source" data-id="' + esc(id) + '">Remove from shelf</button></div>';
    var sh = openSheet(html);
    sh.setAttribute('data-sid', id);
  }
  function field(f, label, val, cls){ return '<label class="lb-field' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + '</span><input class="lb-input" data-f="' + f + '" value="' + esc(String(val == null ? '' : val).replace(/\s*[\r\n]+\s*/g, ' ')) + '"></label>'; }
  function saveSourceField(id, f, v){
    var up = {};
    if(f === 'tags') up.tags = v.split(',').map(function(x){ return x.trim().replace(/^#/, ''); }).filter(Boolean);
    else up[f] = v.trim();
    return S.updateSource(id, up);
  }
  function refreshCiteBox(id){
    var s = srcById(id), box = $('srccite'); if(!s || !box) return;
    try { box.innerHTML = fmt(s, citeStyle()).html; } catch(e){}
  }

  /* ---------- add ---------- */
  var addBusy = false;
  function addSheet(){
    addBusy = false;
    openSheet('<h2>Add to your shelf</h2><p class="by">Paste a DOI, a link or a title.</p>' +
      '<input class="lb-input" id="addin" style="width:100%" placeholder="10.1000/xyz123, https://…, or a title" data-autofocus aria-label="DOI, link or title">' +
      '<div class="lb-acts" style="margin-top:14px"><button type="button" class="lb-btn primary" data-act="addgo">Add</button><button type="button" class="lb-btn" data-act="addpdf">Add from a PDF</button><button type="button" class="lb-btn" data-act="newnote">New note</button></div>' +
      '<p class="lb-note" id="addmsg" style="margin-top:10px">A DOI fills in the authors, year and journal for you.</p>');
    var inp = $('addin'); inp.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); addGo(); } });
  }
  function addGo(){
    var v = ($('addin').value || '').trim(), msg = $('addmsg'); if(!v || addBusy) return;
    if(S.status !== 'ok'){ msg.textContent = 'Not connected yet. Try again when the top says Synced.'; return; }
    addBusy = true;
    var idle = function(){ addBusy = false; };
    var bad = function(err){ idle(); msg.textContent = (err && err.message) || 'That could not be added. Try again.'; };
    var doi = ''; try { doi = C.normDOI(v); } catch(e){}
    if(doi){
      var dup = sources().filter(function(x){ var d = ''; try { d = C.normDOI(x.doi || ''); } catch(e){} return d && d.toLowerCase() === doi.toLowerCase(); })[0];
      if(dup){ idle(); toast('That one is already on your shelf'); closeSheet(); sourceSheet(dup.id); return; }
      msg.textContent = 'Looking it up…';
      C.lookup(doi).then(function(f){
        f.doi = doi; if(!f.url) f.url = 'https://doi.org/' + doi;
        return S.addSource(f);
      }).then(function(id){ idle(); toast('Added'); closeSheet(); sourceSheet(id); }, function(err){
        var why = (err && err.message ? err.message : 'I could not find that DOI.') + ' Added with just the DOI.';
        S.addSource({title: 'DOI ' + doi, doi: doi, url: 'https://doi.org/' + doi}).then(function(id){ idle(); closeSheet(); sourceSheet(id); toast(why); }, bad);
      });
    } else if(/^https?:\/\//i.test(v)){
      var host = v.replace(/^https?:\/\//i, '').replace(/^www\./, '').split(/[/?#]/)[0];
      S.addSource({title: host, url: v, link: v, type: /\.pdf(\?|#|$)/i.test(v) ? 'article' : 'web'}).then(function(id){ idle(); toast('Added. Fill in the title.'); closeSheet(); sourceSheet(id); }, bad);
    } else {
      S.addSource({title: v}).then(function(id){ idle(); toast('Added'); closeSheet(); sourceSheet(id); }, bad);
    }
  }
  function addFromPdf(){
    F.pickPdf().then(function(file){
      if(!file) return;
      $('addmsg') && ($('addmsg').textContent = 'Reading the file…');
      return file.arrayBuffer().then(function(buf){
        return F.fingerprint(buf).then(function(fp){
          var have = sources().filter(function(s){ return s.fingerprint && s.fingerprint === fp; })[0];
          if(have){ F.cache.put(have.id, file); toast('That one is already on your shelf'); closeSheet(); openReader(have.id); return; }
          var base = file.name.toLowerCase();
          var same = sources().filter(function(s){ return s.link && String(s.link).split('/').pop().toLowerCase() === base; })[0];
          if(same){ quiet(S.updateSource(same.id, {fingerprint: fp})); F.cache.put(same.id, file); toast('That one is already on your shelf'); closeSheet(); openReader(same.id); return; }
          var meta = {};
          var p = window.pdfjsLib ? pdfjsLib.getDocument({data: buf.slice(0)}).promise.then(function(doc){ return doc.getMetadata().then(function(m){ meta = (m && m.info) || {}; doc.destroy(); }); }).catch(function(){}) : Promise.resolve();
          return p.then(function(){
            var title = (meta.Title || '').trim() || file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
            var author = (meta.Author || '').trim();
            var tn = Q.norm(title), dupT = tn && sources().filter(function(s){ return Q.norm(s.title) === tn; })[0];
            if(dupT){ quiet(S.updateSource(dupT.id, {fingerprint: fp})); F.cache.put(dupT.id, file); toast('That one is already on your shelf'); closeSheet(); openReader(dupT.id); return null; }
            return S.addSource({title: title, author: author, fingerprint: fp, link: file.name}).then(function(id){ F.cache.put(id, file); closeSheet(); toast('Added'); openReader(id); });
          });
        });
      });
    }).then(null, failed);
  }

  /* ---------- notes ---------- */
  function noteList(){
    var all = [];
    if(state.notesFilter !== 'highlights') all = all.concat(NOTES);
    if(state.notesFilter !== 'notes') all = all.concat(HL);
    if(state.notesProject) all = all.filter(function(n){ return n.project === state.notesProject; });
    all.sort(function(a, b){ return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')) || (b.order || 0) - (a.order || 0); });
    return all;
  }
  function renderNotes(){
    if(state.notesProject && projects().indexOf(state.notesProject) < 0) state.notesProject = '';
    var list = noteList(), pr = projects(), nN = NOTES.length, nH = HL.length;
    var html = '<div class="lb-pills" role="group" aria-label="Show">' + [['all', 'All', nN + nH], ['notes', 'Notes', nN], ['highlights', 'Highlights', nH]].map(function(p){ return '<button type="button" data-nfilter="' + p[0] + '"' + (state.notesFilter === p[0] ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + p[1] + ' ' + p[2] + '</button>'; }).join('') + '</div>' +
      '<div class="lb-bar">' + (pr.length ? '<select class="lb-select" id="nproj" aria-label="Project"><option value="">All projects</option>' + pr.map(function(p){ return '<option' + (state.notesProject === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select>' : '') + '<button type="button" class="lb-btn primary" data-act="newnote">New note</button></div>';
    if(!list.length) html += '<p class="lb-empty">' + (nN + nH ? 'Nothing here yet.' : 'Your notes and highlights will gather here.') + '</p>';
    else html += '<div class="lb-cards">' + list.map(function(n){
      var src = n.sourceId ? srcById(n.sourceId) : null;
      var foot = [];
      if(n.kind === 'highlight') foot.push(hlWord(n.hl) + (n.page ? ' · p. ' + n.page : ''));
      if(src) foot.push(src.title.length > 38 ? src.title.slice(0, 36) + '…' : src.title);
      if(n.project) foot.push(n.project);
      var tags = (n.tags || []).slice(0, 4).map(function(t){ return '<span class="lb-tag">#' + esc(t) + '</span>'; }).join('');
      if(n.kind === 'highlight') return '<button type="button" class="lb-card hl-' + esc(n.hl) + '" data-act="hl" data-id="' + esc(n.id) + '"><p class="q"' + dirA(n.quote) + '>' + esc(n.quote || '') + '</p>' + (n.text ? '<p style="margin-top:6px"' + dirA(n.text) + '>' + esc(n.text) + '</p>' : '') + '<div class="foot"><span>' + esc(foot.join(' · ')) + '</span></div></button>';
      var first = (n.text || '').split('\n').filter(function(x){ return x.trim(); });
      return '<button type="button" class="lb-card" data-act="note" data-id="' + esc(n.id) + '"><h3' + dirA(n.title || first[0]) + '>' + esc(n.title || first[0] || 'Untitled note') + '</h3>' + (n.title && first.length ? '<p' + dirA(first.join(' ')) + '>' + esc(first.join(' ')) + '</p>' : (first.length > 1 ? '<p' + dirA(first.slice(1).join(' ')) + '>' + esc(first.slice(1).join(' ')) + '</p>' : '')) + '<div class="foot">' + tags + (foot.length ? '<span>' + esc(foot.join(' · ')) + '</span>' : '') + '</div></button>';
    }).join('') + '</div>';
    $('v-notes').innerHTML = html;
  }

  function openNoteSheet(id, preset){
    var n = id ? byId(NOTES, id) : null; preset = preset || {};
    var cur = {id: n ? n.id : null, creating: false};
    var pr = projects(), sel = n ? n.sourceId : preset.sourceId || '';
    var title = n ? n.title : preset.title || '', text = n ? n.text : preset.text || '', project = n ? n.project : preset.project || '';
    var html = '<h2>' + (n ? 'Note' : 'New note') + '<span class="lb-saved" id="nsaved"></span></h2>' +
      '<input class="lb-input" id="ntitle" style="width:100%;margin:10px 0 8px" placeholder="Title (optional)" value="' + esc(title) + '" aria-label="Title">' +
      '<div class="lb-sugg"><textarea class="lb-area" id="ntext" rows="9" placeholder="Write here. [[ links to a note or paper. #word tags it." aria-label="Note" ' + (n ? '' : 'data-autofocus') + '>' + esc(text) + '</textarea><ul id="nsugg" hidden></ul></div>' +
      '<div class="lb-grid" style="margin-top:10px"><label class="lb-field"><span>Project</span><select class="lb-select" id="nproject"><option value="">None</option>' + pr.map(function(p){ return '<option' + (project === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + (project && pr.indexOf(project) < 0 ? '<option selected>' + esc(project) + '</option>' : '') + '<option value="__new">New project…</option></select></label>' +
      '<label class="lb-field"><span>About paper</span><select class="lb-select" id="nsource"><option value="">None</option>' + sources().map(function(s){ return '<option value="' + esc(s.id) + '"' + (sel === s.id ? ' selected' : '') + '>' + esc((s.title || '').replace(/\s+/g, ' ').slice(0, 60)) + '</option>'; }).join('') + (sel && !srcById(sel) ? '<option value="' + esc(sel) + '" selected>A removed paper</option>' : '') + '</select></label></div>' +
      '<div id="nback"></div>' + (n ? '<div class="lb-acts" style="margin-top:16px"><button type="button" class="lb-btn small quiet" data-act="archive-note" data-id="' + esc(n.id) + '">Remove note</button></div>' : '');
    var sh = openSheet(html, function(){ save.flush(); doSave(); });
    var ti = $('ntitle'), tx = $('ntext'), pj = $('nproject'), so = $('nsource'), sg = $('nsugg');
    function setSaved(t){ var el = $('nsaved'); if(el) el.textContent = t; }
    function backlinks(){
      var nb = $('nback'); if(!nb) return;
      var t = ti.value.trim(); if(!t || !S.backlinks) { nb.innerHTML = ''; return; }
      var bl = []; try { bl = S.backlinks(t).filter(function(x){ return x.id !== cur.id; }); } catch(e){}
      nb.innerHTML = bl.length ? '<h4>Linked from</h4><ul class="lb-list">' + bl.map(function(x){ return '<li><button type="button" class="lnk" data-act="note" data-id="' + esc(x.id) + '">' + esc(x.title || (x.text || '').split('\n')[0]) + '</button></li>'; }).join('') + '</ul>' : '';
    }
    function fields(){ var text = tx.value; var tags = []; try { tags = S.parseTags(text); } catch(e){} return {title: ti.value.trim(), text: text, tags: tags, project: pj.value === '__new' ? '' : pj.value, sourceId: so.value}; }
    var lastKey = n ? JSON.stringify(fields()) : '';   // what is stored: looking at a note must not rewrite it
    var doSave = function(){
      var f = fields();
      if(!cur.id){
        if(!f.title && !f.text.trim()) return;
        if(cur.creating){ cur.dirty = true; return; }   // the first save is still on its way: save again when it lands
        cur.creating = true;
        S.addNote(f).then(function(nid){ cur.id = nid; cur.creating = false; lastKey = JSON.stringify(f); setSaved('Saved'); if(cur.dirty){ cur.dirty = false; doSave(); } }, function(err){ cur.creating = false; setSaved('Not saved yet'); failed(err); });
      } else {
        var key = JSON.stringify(f); if(key === lastKey) return;
        S.updateNote(cur.id, f).then(function(){ lastKey = key; setSaved('Saved'); }, function(err){ setSaved('Not saved yet'); failed(err); });
      }
      backlinks();
    };
    var save = debounce(doSave, 700);
    [ti, tx].forEach(function(e){ e.addEventListener('input', function(){ setSaved(''); save(); }); });
    so.addEventListener('change', doSave);
    var prevProj = pj.value;
    pj.addEventListener('change', function(){ if(pj.value === '__new'){ var name = (prompt('Name the project') || '').trim(); if(!name){ pj.value = prevProj; return; } var o = document.createElement('option'); o.textContent = name; pj.insertBefore(o, pj.querySelector('[value="__new"]')); pj.value = name; } prevProj = pj.value; doSave(); });
    // [[ suggestions
    var sugIdx = -1;
    function suggestions(){
      var v = tx.value, pos = tx.selectionStart, before = v.slice(0, pos), m = /\[\[([^\]\[\n]*)$/.exec(before);
      if(!m){ sg.hidden = true; return; }
      var q = Q.norm(m[1]), pool = [];
      sources().forEach(function(s){ if(s.title) pool.push({t: s.title.replace(/\s+/g, ' '), k: 'Paper'}); });
      NOTES.forEach(function(x){ if(x.title && x.id !== cur.id) pool.push({t: x.title, k: 'Note'}); });
      var hits = pool.filter(function(p){ return !q || Q.norm(p.t).indexOf(q) >= 0; }).slice(0, 6);
      if(!hits.length){ sg.hidden = true; return; }
      sugIdx = 0; sg.innerHTML = hits.map(function(h, i){ return '<li data-t="' + esc(h.t) + '"' + (i === 0 ? ' class="on"' : '') + '>' + esc(h.t.length > 70 ? h.t.slice(0, 68) + '…' : h.t) + ' <span style="color:var(--faint);font-size:12px">' + h.k + '</span></li>'; }).join(''); sg.hidden = false;
    }
    function pickSuggestion(t){
      var v = tx.value, pos = tx.selectionStart, before = v.slice(0, pos), after = v.slice(pos), idx = before.lastIndexOf('[[');
      if(idx < 0){ sg.hidden = true; return; }
      var rest = after.replace(/^[^\]\[\n]*\]\]/, '');
      tx.value = before.slice(0, idx) + '[[' + t + ']]' + (rest === after ? after : rest);
      var np = (before.slice(0, idx) + '[[' + t + ']]').length; tx.setSelectionRange(np, np); sg.hidden = true; tx.focus(); save();
    }
    tx.addEventListener('input', suggestions);
    tx.addEventListener('keydown', function(e){
      if(sg.hidden) return;
      var items = sg.querySelectorAll('li');
      if(e.key === 'ArrowDown'){ e.preventDefault(); sugIdx = (sugIdx + 1) % items.length; }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); sugIdx = (sugIdx - 1 + items.length) % items.length; }
      else if(e.key === 'Enter' || e.key === 'Tab'){
        if(!/\[\[([^\]\[\n]*)$/.test(tx.value.slice(0, tx.selectionStart))){ sg.hidden = true; return; }   // the caret moved away: Enter is a new line again
        e.preventDefault(); pickSuggestion(items[sugIdx].getAttribute('data-t')); return;
      }
      else if(e.key === 'Escape'){ e.stopPropagation(); sg.hidden = true; return; }
      else return;
      for(var i = 0; i < items.length; i++) items[i].className = i === sugIdx ? 'on' : '';
    });
    sg.addEventListener('mousedown', function(e){ var li = e.target.closest('li'); if(li){ e.preventDefault(); pickSuggestion(li.getAttribute('data-t')); } });
    backlinks();
  }

  /* ---------- cite ---------- */
  function citeSources(){
    var list = sources().filter(function(s){
      if(state.citeProject && s.project !== state.citeProject) return false;
      if(state.citeScope === 'marked' && !(counts.hl[s.id] || counts.notes[s.id])) return false;
      return true;
    });
    return dedupe(list);
  }
  function removedList(){
    var gone = [];
    (S.allSources || []).forEach(function(x){ if(x.archived) gone.push(['source', x.id, x.title || 'Untitled paper', 'Paper']); });
    (S.allNotes || []).forEach(function(x){ if(x.archived) gone.push(['note', x.id, x.title || (x.text || '').split('\n').filter(function(l){ return l.trim(); })[0] || 'Note', 'Note']); });
    (S.allHighlights || []).forEach(function(x){ if(x.archived) gone.push(['highlight', x.id, x.quote || 'Highlight', 'Highlight']); });
    if(!gone.length) return '';
    return '<details class="lb-removed"' + (state.removedOpen ? ' open' : '') + '><summary>Removed (' + gone.length + ')</summary><p class="lb-note" style="margin:8px 0">Nothing is deleted. Put anything back here.</p><ul class="lb-list">' + gone.map(function(g){
      return '<li class="lb-gone"><span' + dirA(g[2]) + '>' + esc(String(g[2]).slice(0, 90)) + ' <em>' + g[3] + '</em></span><button type="button" class="lb-btn small quiet" data-act="restore" data-kind="' + g[0] + '" data-id="' + esc(g[1]) + '">Put back</button></li>';
    }).join('') + '</ul></details>';
  }
  function renderCite(){
    if(state.citeProject && projects().indexOf(state.citeProject) < 0) state.citeProject = '';
    var pr = projects(), list = citeSources(), html = '';
    html += '<div class="lb-bar"><select class="lb-select" id="cproj" aria-label="Project"><option value="">Whole shelf</option>' + pr.map(function(p){ return '<option' + (state.citeProject === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select>' +
      '<select class="lb-select" id="cscope" aria-label="Which papers"><option value="marked"' + (state.citeScope === 'marked' ? ' selected' : '') + '>Papers I have marked or noted</option><option value="all"' + (state.citeScope === 'all' ? ' selected' : '') + '>Every paper</option></select></div>' +
      '<div class="lb-pills" role="group" aria-label="Style">' + STYLES.map(function(st){ return '<button type="button" data-cstyle="' + st.k + '"' + (state.citeStyle === st.k ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + st.w + '</button>'; }).join('') + '</div>';
    var body = '', mono = state.citeStyle === 'bibtex';
    try { body = list.length ? (mono ? esc(C.bibtexAll(list)) : C.bibliography(list, state.citeStyle).html) : ''; } catch(e){ body = ''; }
    html += '<div class="lb-biblio' + (mono ? ' mono' : '') + '" id="bib">' + (body || '<span style="color:var(--muted)">' + (sources().length ? 'No papers match yet. Mark or note a paper, or choose “Every paper”.' : 'Add papers to build a bibliography.') + '</span>') + '</div>' +
      '<div class="lb-acts" style="margin-top:12px"><button type="button" class="lb-btn primary" data-act="bibcopy"' + (list.length ? '' : ' disabled') + '>Copy ' + list.length + ' ' + (list.length === 1 ? 'reference' : 'references') + '</button><button type="button" class="lb-btn" data-act="bibdl"' + (list.length ? '' : ' disabled') + '>Download</button></div>' +
      '<h4 style="margin-top:26px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)">Take it with you</h4><div class="lb-acts"><button type="button" class="lb-btn" data-act="mdexport">Notes as Markdown</button><button type="button" class="lb-btn" data-act="backup">Back up everything</button></div>' + removedList();
    $('v-cite').innerHTML = html;
  }
  function slug(s){ return (s || 'library').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'library'; }
  function markdown(project){
    var out = ['# ' + (project || 'My research notes'), '', '_Exported ' + new Date().toLocaleDateString() + '_', ''];
    var ns = NOTES.filter(function(n){ return !project || n.project === project; });
    var hs = HL.filter(function(h){ var s = srcById(h.sourceId); return !project || h.project === project || (s && s.project === project); });
    if(ns.length){ out.push('## Notes', ''); ns.forEach(function(n){ out.push('### ' + (n.title || (n.text || '').split('\n')[0] || 'Note'), '', n.text || '', ''); }); }
    var bySrc = {}; hs.forEach(function(h){ (bySrc[h.sourceId] = bySrc[h.sourceId] || []).push(h); });
    var ids = Object.keys(bySrc); if(ids.length) out.push('## Reading notes', '');
    ids.forEach(function(sid){
      var s = srcById(sid); if(!s) return;
      out.push('### ' + (s.title || 'Untitled') + (shortBy(s) ? ' (' + shortBy(s).replace(' · ', ', ') + ')' : ''), '');
      bySrc[sid].sort(function(a, b){ return (a.page || 0) - (b.page || 0); }).forEach(function(h){
        var cite = ''; try { cite = inTextOf(s, 'apa', h.page); } catch(e){}
        out.push('- ' + hlWord(h.hl) + ' · p. ' + (h.page || '?') + ': “' + (h.quote || '').replace(/\s+/g, ' ').trim() + '” ' + cite + (h.text ? '\n  - ' + h.text.replace(/\n+/g, ' ') : ''));
      });
      out.push('');
    });
    var used = sources().filter(function(s){ return (!project || s.project === project) && (counts.hl[s.id] || counts.notes[s.id]); });
    if(used.length){ out.push('## References (APA)', ''); try { out.push(C.bibliography(dedupe(used), 'apa').text); } catch(e){} }
    return out.join('\n');
  }

  /* ---------- search ---------- */
  function renderSearch(){
    var q = state.q.trim(), el = $('v-search');
    if(!q){ el.hidden = true; return; }
    var res = []; try { res = getIndex().query(q, {limit: 60}); } catch(e){ res = []; }
    var terms = q.split(/\s+/).filter(function(t){ return t && !/^(tag|project|kind):|^-/.test(t); }).map(function(t){ return t.replace(/^"|"$/g, ''); });
    var groups = {source: [], note: [], highlight: []};
    res.forEach(function(r){ (groups[r.item.kind] || []).push(r); });
    function hl(text){ try { return Q.highlightHTML(String(text || ''), terms); } catch(e){ return esc(text); } }
    var html = '';
    if(!res.length) html = '<p class="lb-empty">Nothing found for “' + esc(q) + '”.</p>';
    if(groups.source.length) html += '<h4 class="lb-sh">Papers</h4><div role="list">' + groups.source.map(function(r){ var s = srcById(r.item.id); if(!s) return ''; return '<div class="lb-row" role="listitem" data-act="source" data-id="' + esc(s.id) + '"><span class="lb-dot ' + (s.status === 'reading' ? 'reading' : s.status === 'finished' ? 'finished' : '') + '" role="img" aria-label="' + esc(STATUS[s.status] || 'To read') + '"></span><div><h3' + dirA(s.title) + '><button type="button" class="lb-open" data-act="source" data-id="' + esc(s.id) + '">' + hl(s.title) + '</button></h3><p class="by"' + dirA(shortBy(s)) + '>' + esc(shortBy(s)) + '</p>' + (r.snippet ? '<p class="meta">' + hl(r.snippet) + '</p>' : '') + '</div><span></span></div>'; }).join('') + '</div>';
    if(groups.note.length) html += '<h4 class="lb-sh">Notes</h4><div class="lb-cards">' + groups.note.map(function(r){ var n = byId(NOTES, r.item.id); if(!n) return ''; return '<button type="button" class="lb-card" data-act="note" data-id="' + esc(n.id) + '"><h3' + dirA(n.title) + '>' + hl(n.title || (n.text || '').split('\n')[0] || 'Note') + '</h3><p>' + hl(r.snippet || '') + '</p></button>'; }).join('') + '</div>';
    if(groups.highlight.length) html += '<h4 class="lb-sh">Highlights</h4><div class="lb-cards">' + groups.highlight.map(function(r){ var h = byId(HL, r.item.id); if(!h) return ''; var s = srcById(h.sourceId); return '<button type="button" class="lb-card hl-' + esc(h.hl) + '" data-act="hl" data-id="' + esc(h.id) + '"><p class="q">' + hl(h.quote || '') + '</p>' + (h.text ? '<p style="margin-top:6px">' + hl(h.text) + '</p>' : '') + '<div class="foot"><span>' + esc((s ? s.title.slice(0, 40) : '') + (h.page ? ' · p. ' + h.page : '')) + '</span></div></button>'; }).join('') + '</div>';
    el.innerHTML = html; el.hidden = false;
  }

  /* ---------- render + routing ---------- */
  function render(){
    var fkey = focusKey(document.activeElement);
    setStatusLine();
    var searching = state.q.trim().length > 0;
    ['shelf', 'notes', 'cite'].forEach(function(v){ $('v-' + v).hidden = searching || state.view !== v; });
    var nav = $('lbnav').querySelectorAll('button'); for(var i = 0; i < nav.length; i++){ var on = nav[i].getAttribute('data-view') === state.view; nav[i].classList.toggle('on', on); nav[i].setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if(searching) renderSearch();
    else { $('v-search').hidden = true; if(state.view === 'shelf') renderShelf(); else if(state.view === 'notes') renderNotes(); else renderCite(); }
    refocus(fkey);
  }
  var renderSoon = debounce(function(){ recount(); indexDirty = true; var shs = $('lbsheet'); if(!shs.hidden && shs.getAttribute('data-sid')) refreshCiteBox(shs.getAttribute('data-sid')); var ae = document.activeElement; if(ae && ae.matches && ae.matches('#lbsheet input, #lbsheet textarea, #lbsheet select, .lb-hlpop textarea')){ /* leave an open editor alone */ } render(); if(!$('lbreader').hidden) refreshMarks(); }, 60);
  function setView(v){ state.view = v; state.q = ''; $('lbq').value = ''; try { history.replaceState(null, '', '#' + v); } catch(e){} render(); }

  function onClick(e){
    var t = e.target;
    var cp = t.closest && t.closest('[data-cp]');
    if(cp){ var sid = $('lbsheet').getAttribute('data-sid'), s = srcById(sid); if(s){ var st = cp.getAttribute('data-cp'), f = fmt(s, st); copy(f.text, st === 'bibtex' ? null : f.html).then(function(){ toast('Copied ' + (STYLES.filter(function(x){ return x.k === st; })[0] || {}).w); }, function(){ toast('Could not copy'); }); if(st !== 'bibtex'){ state.citeStyle = st; try { localStorage.setItem(KEY_STYLE, st); } catch(er){} refreshCiteBox(sid); } } return; }
    var fl = t.closest && t.closest('[data-filter]'); if(fl){ state.filter = fl.getAttribute('data-filter'); render(); return; }
    var nf = t.closest && t.closest('[data-nfilter]'); if(nf){ state.notesFilter = nf.getAttribute('data-nfilter'); render(); return; }
    var cs = t.closest && t.closest('[data-cstyle]'); if(cs){ state.citeStyle = cs.getAttribute('data-cstyle'); try { localStorage.setItem(KEY_STYLE, state.citeStyle); } catch(er){} render(); return; }
    var ss = t.closest && t.closest('[data-setstatus]'); if(ss){
      var sid2 = $('lbsheet').getAttribute('data-sid'), want = ss.getAttribute('data-setstatus'), was = (srcById(sid2) || {}).status || 'not-started';
      var setPills = function(k){ var sb = $('lbsheet').querySelectorAll('[data-setstatus]'); for(var i = 0; i < sb.length; i++){ var o = sb[i].getAttribute('data-setstatus') === k; sb[i].classList.toggle('on', o); sb[i].setAttribute('aria-pressed', o ? 'true' : 'false'); } };
      setPills(want); S.setStatus(sid2, want).then(null, function(e){ setPills(was); failed(e); }); return; }
    var a = t.closest && t.closest('[data-act]'); if(!a) return;
    var act = a.getAttribute('data-act'), id = a.getAttribute('data-id');
    if(act === 'closesheet') closeSheet();
    else if(act === 'tipoff'){ tipSeen = true; try { localStorage.setItem(KEY_TIP, '1'); } catch(er){} render(); }
    else if(act === 'source'){ if(t.closest('.star')) return; sourceSheet(id); }
    else if(act === 'star'){ e.stopPropagation(); var s3 = srcById(id); if(s3) guard(S.updateSource(id, {priority: isHigh(s3) ? '' : 'high'})); }
    else if(act === 'another'){ state.nextSkip++; render(); }
    else if(act === 'read'){ openReader(id, {page: +a.getAttribute('data-page') || 0, highlightId: a.getAttribute('data-hl') || null}); }
    else if(act === 'note-for'){ closeSheet(); openNoteSheet(null, {sourceId: id}); }
    else if(act === 'note'){ closeSheet(); openNoteSheet(id); }
    else if(act === 'newnote'){ closeSheet(); openNoteSheet(null); }
    else if(act === 'hl'){ var h = byId(S.highlights || [], id); if(h && h.sourceId) openReader(h.sourceId, {page: h.page, highlightId: h.id}); }
    else if(act === 'lookup'){ var dv = $('lbsheet').querySelector('[data-f="doi"]'), d = ''; try { d = C.normDOI(dv.value); } catch(er){} if(!d){ toast('Add a DOI first'); return; } toast('Looking it up…'); C.lookup(d).then(function(f){ var s4 = srcById(id), up = {}; if(!s4) return; Object.keys(f).forEach(function(k){ if(f[k] && (!s4[k] || k === 'doi' || (k === 'type' && s4.type === 'other'))) up[k] = f[k]; }); S.updateSource(id, up).then(function(){ toast('Filled in what was missing'); setTimeout(function(){ if(!$('lbsheet').hidden && $('lbsheet').getAttribute('data-sid') === id) sourceSheet(id); }, 400); }, failed); }, function(er){ toast(er && er.message ? er.message : 'I could not find that DOI.'); }); }
    else if(act === 'archive-source'){ S.archiveSource(id).then(function(){ closeSheet(); toast('Removed from your shelf. It is kept under Cite, Removed.', function(){ guard(S.restoreSource(id)); }); }, failed); }
    else if(act === 'archive-note'){ S.archiveNote(id).then(function(){ closeSheet(); toast('Note removed. It is kept under Cite, Removed.', function(){ guard(S.restoreNote(id)); }); }, failed); }
    else if(act === 'addgo') addGo();
    else if(act === 'addpdf') addFromPdf();
    else if(act === 'pickpdf'){ F.pickPdf().then(function(f){ if(f) loadBlob(f); }); }
    else if(act === 'folder'){ F.folder.connect().then(function(h){ if(!h){ return; } toast('PDF folder connected'); if(rd.src && !$('lbreader').hidden){ var s0 = rd.src, t0 = rd.token; resolveFile(s0).then(function(b){ if(b) loadBlob(b, s0, t0); }); } render(); }, function(){ toast('The folder was not connected'); }); }
    else if(act === 'goto'){ if(rd.reader) rd.reader.goTo(+a.getAttribute('data-page') || 1, {highlightId: id}); if(window.innerWidth < 900) $('rpanel').hidden = true; }
    else if(act === 'bibcopy'){ var list = citeSources(), b; try { b = state.citeStyle === 'bibtex' ? {text: C.bibtexAll(list)} : C.bibliography(list, state.citeStyle); } catch(er){ b = {text: ''}; } copy(b.text, b.html || null).then(function(){ toast('Copied'); }, function(){ toast('Could not copy'); }); }
    else if(act === 'bibdl'){ var l2 = citeSources(), nm = 'references-' + slug(state.citeProject); if(state.citeStyle === 'bibtex') download(nm + '.bib', C.bibtexAll(l2), 'text/plain'); else download(nm + '-' + state.citeStyle + '.txt', C.bibliography(l2, state.citeStyle).text, 'text/plain'); }
    else if(act === 'restore'){
      var kind = a.getAttribute('data-kind');
      (kind === 'source' ? S.restoreSource(id) : kind === 'note' ? S.restoreNote(id) : S.restoreHighlight(id)).then(function(){ toast('Put back'); }, failed);
    }
    else if(act === 'mdexport'){ if(S.status !== 'ok'){ toast('Not connected yet, so there is nothing to export. Try again when it says Synced.'); return; } download('notes-' + slug(state.citeProject) + '.md', markdown(state.citeProject), 'text/markdown'); }
    else if(act === 'backup'){ if(S.status !== 'ok'){ toast('Not connected yet, so there is nothing to back up. Try again when it says Synced.'); return; } download('library-backup-' + iso().slice(0, 10) + '.json', JSON.stringify(S.exportAll(), null, 1), 'application/json'); }
  }

  function onChange(e){
    var t = e.target;
    if(t.id === 'scope'){ state.scope = t.value; render(); return; }
    if(t.id === 'nproj'){ state.notesProject = t.value; render(); return; }
    if(t.id === 'cproj'){ state.citeProject = t.value; render(); return; }
    if(t.id === 'cscope'){ state.citeScope = t.value; render(); return; }
    var f = t.getAttribute && t.getAttribute('data-f');
    if(f && $('lbsheet').contains(t)){
      var sid = $('lbsheet').getAttribute('data-sid'); if(!sid) return;
      var v = t.value;
      if(f === 'project' && v === '__new'){ var name = (prompt('Name the project') || '').trim(); if(!name){ t.value = (srcById(sid) || {}).project || ''; return; } var o = document.createElement('option'); o.textContent = name; t.insertBefore(o, t.querySelector('[value="__new"]')); t.value = name; v = name; }
      guard(saveSourceField(sid, f, v)); refreshCiteBox(sid);
    }
  }

  function flushAll(){ flushPage(); if(sheetClose){ try { sheetClose(); } catch(e){} } }
  function boot(){
    if(!S || !C || !Q || !F){ var l = $('lbstatus'); l.hidden = false; l.textContent = 'Part of the library did not load. Refresh the page.'; return; }
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    $('lbnav').addEventListener('click', function(e){ var b = e.target.closest('button'); if(b) setView(b.getAttribute('data-view')); });
    $('lbadd').addEventListener('click', addSheet);
    $('lbscrim').addEventListener('click', closeSheet);
    $('lbq').addEventListener('input', debounce(function(){ state.q = $('lbq').value; render(); }, 120));
    $('lbq').addEventListener('keydown', function(e){ if(e.key === 'Escape'){ $('lbq').value = ''; state.q = ''; render(); } });
    $('lbsheet').addEventListener('keydown', function(e){ if(e.key === 'Enter' && e.target.matches && e.target.matches('.lb-row')) e.target.click(); });
    ['v-shelf', 'v-search'].forEach(function(id){ $(id).addEventListener('keydown', function(e){ if((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.lb-row')){ e.preventDefault(); e.target.click(); } }); });
    // reader controls
    $('rback').addEventListener('click', closeReader);
    $('rzin').addEventListener('click', function(){ if(rd.reader) rd.reader.zoomBy(1); });
    $('rzout').addEventListener('click', function(){ if(rd.reader) rd.reader.zoomBy(-1); });
    $('rnight').addEventListener('click', function(){ var paper = $('rnight').textContent === 'Night'; $('rnight').textContent = paper ? 'Paper' : 'Night'; try { localStorage.setItem(KEY_NIGHT, paper ? 'paper' : 'night'); } catch(e){} if(rd.reader) rd.reader.setNight(!paper); });
    $('rside').addEventListener('click', function(){ var p = $('rpanel'); p.hidden = !p.hidden; if(!p.hidden) renderPanel(); });
    $('rpage').addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); var n = parseInt(this.value, 10); if(n > 0 && rd.reader) rd.reader.goTo(n); this.blur(); } });
    $('rpage').addEventListener('blur', function(){ var pg = rd.reader && rd.reader.page ? rd.reader.page() : 0; if(pg > 0) this.value = String(pg); });
    $('rpage').addEventListener('focus', function(){ this.select(); });
    $('seltb').addEventListener('mousedown', function(e){ e.preventDefault(); });
    $('seltb').addEventListener('click', function(e){
      var b = e.target.closest('button'); if(!b || !rd.sel || !rd.src) return;
      var sel = rd.sel, s = rd.src, k = b.getAttribute('data-hl');
      if(k){
        S.addHighlight({sourceId: s.id, page: sel.page, quote: sel.text, rects: sel.rects, hl: k, project: s.project || ''}).then(function(hid){ toast(hlWord(k) + ' saved', function(){ S.archiveHighlight(hid); }); }, function(){ toast('Could not save that. Check the connection.'); });
        hideSelTb(); try { window.getSelection().removeAllRanges(); } catch(er){}
      } else if(b.getAttribute('data-act') === 'cite'){
        copy(quoteWithCite(s, sel.text, sel.page)).then(function(){ toast('Copied with citation'); }, function(){ toast('Could not copy'); }); hideSelTb();
      }
    });
    document.addEventListener('keydown', function(e){
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '');
      if(e.key === 'Escape'){
        if(document.getElementById(HL_STYLE_ID)) closePopover();
        else if(!$('seltb').hidden) hideSelTb();
        else if(!$('lbsheet').hidden) closeSheet();
        else if(!$('lbreader').hidden){ if(!$('rpanel').hidden && window.innerWidth < 900) $('rpanel').hidden = true; else closeReader(); }
      } else if(!typing && $('lbreader').hidden && $('lbsheet').hidden){
        if(e.key === '/'){ e.preventDefault(); $('lbq').focus(); }
        else if(e.key === 'n' && !e.metaKey && !e.ctrlKey){ e.preventDefault(); openNoteSheet(null); }
      } else if(!typing && !$('lbreader').hidden && e.key === 'g'){ e.preventDefault(); $('rpage').focus(); }
    });
    document.addEventListener('mousedown', function(e){ var p = document.getElementById(HL_STYLE_ID); if(p && !p.contains(e.target) && !(e.target.closest && e.target.closest('.lib-hl, [data-hl-id]'))) closePopover(); });
    window.addEventListener('pagehide', flushAll);
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'hidden') flushAll(); });
    document.addEventListener('toggle', function(e){ if(e.target && e.target.classList && e.target.classList.contains('lb-removed')) state.removedOpen = e.target.open; }, true);
    window.addEventListener('hashchange', route);
    S.onChange(function(){ setStatusLine(); renderSoon(); });
    S.init();
    recount(); render(); route();
  }
  function route(){
    var h = location.hash.replace(/^#/, ''), m;
    function once(open){
      var done = false, un = null;
      function tryOpen(){ if(done) return; var s = srcById(open.id); if(s && S.status !== 'connecting'){ done = true; recount(); open.fn(); if(un) un(); } }
      tryOpen(); if(!done) un = S.onChange(function(){ tryOpen(); if(done && un){ un(); un = null; } });
    }
    if((m = /^read\/([^/]+)(?:\/(\d+))?$/.exec(h))){ var rid = m[1], rpg = +m[2] || 0; once({id: rid, fn: function(){ openReader(rid, {page: rpg}); }}); }
    else if(/^(shelf|notes|cite)$/.test(h)){ if(state.view !== h) setView(h); }
    else if((m = /^source\/(.+)$/.exec(h))){ var sid = m[1]; once({id: sid, fn: function(){ sourceSheet(sid); }}); }
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
