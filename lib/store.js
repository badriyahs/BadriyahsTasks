/* Lib.store: the library's data layer (Firestore compat SDK).
 *
 * Two collections, both shared with the older pages:
 *   reading  -> sources (the old reading.html list). Podcast rows (kind 'podcast') are ignored here.
 *   notes    -> notes and highlights (the old notes.html only knows {text, order}).
 *
 * Rules this file keeps (they come from Firestore and from the older pages):
 *   - no orderBy on the listeners, so documents without `order` still arrive; we sort here
 *   - no nested arrays: highlight rects are stored as the JSON string `rectsJson`
 *   - no undefined values: every write goes through toSourceFields / toNoteFields
 *   - a write only touches the fields it was given
 *   - every new document gets order = (largest order over ALL docs, archived and podcast too) + 10
 *   - nothing is ever hard-deleted: delete = archived:true
 *
 * The mapping functions (fromSourceDoc, toSourceFields, fromNoteDoc, toNoteFields,
 * parseLinks, parseTags) are pure and run in node without firebase.
 * Plain ES5 style (var + IIFE), like the rest of the site.
 */
(function(){
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;
  root.Lib = root.Lib || {};

  var TYPES = ['article', 'book', 'chapter', 'thesis', 'web', 'other'];
  var STATUSES = ['not-started', 'reading', 'finished'];
  var HL_KINDS = ['idea', 'evidence', 'quote', 'question'];
  var DEFAULT_PROJECTS = ['Harvard proposal', 'Names of the Sun', 'Reading'];

  /* ------------------------------------------------------------------ small helpers */

  function obj(v){ return v && typeof v === 'object' ? v : {}; }
  function str(v){
    if(typeof v === 'string') return v;
    if(typeof v === 'number') return isFinite(v) ? String(v) : '';
    return '';
  }
  function num(v){            // a finite number, or undefined when it is not one
    if(typeof v === 'number') return isFinite(v) ? v : undefined;
    if(typeof v === 'string' && v.trim() !== ''){ var n = Number(v); return isFinite(n) ? n : undefined; }
    return undefined;
  }
  function numOr0(v){ var n = num(v); return n === undefined ? 0 : n; }
  /* What a write may store for a text field: a string or a finite number as text, null as an explicit clear ('').
     Anything else (NaN, an object, a boolean) is a slip by the caller and is dropped, never turned into ''. */
  function strField(v){
    if(typeof v === 'string') return v;
    if(typeof v === 'number') return isFinite(v) ? String(v) : undefined;
    if(v === null) return '';
    return undefined;
  }
  function nfc(s){ try { return s.normalize ? s.normalize('NFC') : s; } catch(e){ return s; } }
  function squash(s){ return str(s).replace(/\s+/g, ' ').trim(); }
  function keyOf(s){ return nfc(squash(s)).toLowerCase(); }
  function dict(){ return {}; }                      // keys are always prefixed with '$' so 'constructor' etc. are safe
  function now(){ return (store._now || function(){ return new Date().toISOString(); })(); }

  /* ------------------------------------------------------------------ tags and links in text */

  // letters and digits of Latin (with the diacritics used in transliteration) and Arabic scripts
  var WORD = 'A-Za-z0-9' +
    '\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F' +   // Latin-1 letters, Latin Extended-A/B
    '\\u02BB-\\u02BF' +                                  // modifier letters used for ayn / hamza (ʿ ʾ)
    '\\u0300-\\u036F' +                                  // combining marks
    '\\u1E00-\\u1EFF' +                                  // Latin Extended Additional (ḥ ṣ ḍ ṭ ẓ ...)
    '\\u0610-\\u061A\\u0620-\\u0669\\u066E-\\u06D3\\u06D5\\u06F0-\\u06FF' + // Arabic letters, marks, digits (no Arabic punctuation)
    '\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF';
  var TAG_RE = new RegExp('(^|[^' + WORD + '_#&/\\\\=])#([' + WORD + ']+(?:[-_][' + WORD + ']+)*)', 'g');
  var DIGITS_ONLY = /^[0-9\u0660-\u0669\u06F0-\u06F9_\-]+$/;
  var LINK_RE = /\[\[([^\[\]\r\n]+?)\]\]/g;

  /* [[Title]] and [[Title|shown text]] -> the titles, in order, once each. */
  function parseLinks(text){
    var out = [], seen = dict(), m, t, k;
    var s = str(text);
    LINK_RE.lastIndex = 0;
    while((m = LINK_RE.exec(s))){
      t = squash(m[1].split('|')[0]);
      k = '$' + keyOf(t);
      if(!t || seen[k]) continue;
      seen[k] = true;
      out.push(nfc(t));
    }
    return out;
  }

  /* #tag in text (Arabic letters allowed). Not: #123, C#, a/b#c in links, text inside [[...]]. */
  function parseTags(text){
    var s = str(text).replace(LINK_RE, ' ');
    var out = [], seen = dict(), m, t, k;
    TAG_RE.lastIndex = 0;
    while((m = TAG_RE.exec(s))){
      t = nfc(m[2]);
      if(DIGITS_ONLY.test(t)) continue;
      k = '$' + t.toLowerCase();
      if(seen[k]) continue;
      seen[k] = true;
      out.push(t);
    }
    return out;
  }

  /* One tag list from an array, or from a string ("a b, c"). No '#', no spaces, no duplicates (case-insensitive). */
  function normTags(v){
    var list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[\s,;]+/) : []);
    var out = [], seen = dict();
    list.forEach(function(t){
      t = nfc(str(t)).replace(/^[#\s]+/, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
      if(!t) return;
      var k = '$' + t.toLowerCase();
      if(seen[k]) return;
      seen[k] = true;
      out.push(t);
    });
    return out;
  }
  function unionTags(a, b){ return normTags(a.concat(b)); }
  // for writes: a list or a string is a tag list, null clears it, any other type is a slip and is dropped
  function tagsField(v){
    if(Array.isArray(v) || typeof v === 'string') return normTags(v);
    if(v === null) return [];
    return undefined;
  }

  /* ------------------------------------------------------------------ authors */

  var PARTICLE = /^(al|el|ibn|bin|ben|abu|van|von|der|den|de|del|della|di|da|du|la|le|ter|ten)$/i;
  var ORG_WORD = /(university|press|institute|organi[sz]ation|association|society|museum|library|council|committee|ministry|department|academy|foundation|centre|center|unesco|company|group|agency|national|royal)/i;

  function personFromGivenFamily(s){
    var t = s.split(' '), i = t.length - 1;
    if(t.length < 2) return {family: '', given: '', literal: s};
    while(i > 1 && PARTICLE.test(t[i - 1])) i--;
    return {family: t.slice(i).join(' '), given: t.slice(0, i).join(' '), literal: ''};
  }

  // Used only when Lib.cite is not on the page; Lib.cite.parseAuthors is the better parser.
  function fallbackAuthors(s){
    s = s.replace(/\u060C/g, ',').replace(/[\r\n]+/g, ';').replace(/\s+/g, ' ').trim();
    if(!s) return [];
    var parts, list = false;
    if(s.indexOf(';') >= 0){ parts = s.split(';'); list = true; }
    else { parts = s.split(/\s+(?:and|&)\s+/i); list = parts.length > 1; }
    var out = [];
    parts.forEach(function(p){
      p = p.trim();
      if(!p) return;
      var c = p.indexOf(',');
      if(c >= 0){
        var fam = p.slice(0, c).trim(), giv = p.slice(c + 1).trim();
        if(fam) out.push({family: fam, given: giv, literal: ''});
        else if(giv) out.push({family: '', given: '', literal: giv});
        return;
      }
      if(list) { out.push(personFromGivenFamily(p)); return; }
      var tokens = p.split(' ');
      if(tokens.length === 1 || tokens.length > 4 || ORG_WORD.test(p)) out.push({family: '', given: '', literal: p});
      else out.push(personFromGivenFamily(p));
    });
    return out;
  }

  function cleanAuthor(a){
    a = obj(a);
    return {family: str(a.family), given: str(a.given), literal: str(a.literal)};
  }

  function parseAuthors(s){
    s = str(s);
    var cite = root.Lib && root.Lib.cite;
    if(cite && typeof cite.parseAuthors === 'function'){
      try {
        var r = cite.parseAuthors(s);
        if(Array.isArray(r)) return r.map(cleanAuthor);
      } catch(e){ /* fall through to the simple parser */ }
    }
    return fallbackAuthors(s);
  }

  function authorsToString(list){
    return (Array.isArray(list) ? list : []).map(function(a){
      a = cleanAuthor(a);
      if(a.literal) return a.literal;
      if(a.family && a.given) return a.family + ', ' + a.given;
      return a.family || a.given;
    }).filter(Boolean).join('; ');
  }

  /* ------------------------------------------------------------------ value normalisers */

  function normType(t){
    var k = str(t).trim().toLowerCase();
    return TYPES.indexOf(k) >= 0 ? k : 'other';
  }
  // for writes: only a non-empty word counts (an empty or odd value must not turn an Article into Other)
  function typeField(t){
    return typeof t === 'string' && t.trim() ? normType(t) : undefined;
  }
  // canonical status word, or null when it is not a known one (so a write can refuse it)
  function statusWord(s){
    var k = str(s).trim().toLowerCase().replace(/[\s_]+/g, '-');
    if(k === 'not-started' || k === 'to-read' || k === 'unread') return 'not-started';
    if(k === 'reading' || k === 'in-progress') return 'reading';
    if(k === 'finished' || k === 'done' || k === 'complete' || k === 'completed') return 'finished';
    return null;
  }
  function hlWord(s){
    var k = str(s).trim().toLowerCase();
    return HL_KINDS.indexOf(k) >= 0 ? k : '';
  }
  function normRects(v){
    var arr = v;
    if(typeof v === 'string'){ try { arr = JSON.parse(v); } catch(e){ return []; } }
    if(!Array.isArray(arr)) return [];
    var out = [];
    arr.forEach(function(r){
      if(!Array.isArray(r) || r.length < 4) return;
      var a = [num(r[0]), num(r[1]), num(r[2]), num(r[3])];
      for(var i = 0; i < 4; i++) if(a[i] === undefined) return;
      out.push(a);
    });
    return out;
  }
  // for writes: the JSON text of a rect list. Not a list, or a list with no usable rect, is a slip: undefined (nothing is written).
  function rectsField(v){
    var arr = v;
    if(typeof v === 'string'){ try { arr = JSON.parse(v); } catch(e){ return undefined; } }
    if(!Array.isArray(arr)) return undefined;
    var good = normRects(arr);
    if(arr.length && !good.length) return undefined;
    return JSON.stringify(good);
  }

  /* ------------------------------------------------------------------ mapping: sources */

  function fromSourceDoc(id, data){
    data = obj(data);
    var author = str(data.author);
    return {
      id: str(id),
      title: str(data.title),
      author: author,
      authors: parseAuthors(author),
      year: str(data.year).trim(),
      type: normType(data.type),
      venue: str(data.venue),
      volume: str(data.volume),
      issue: str(data.issue),
      pageRange: str(data.pageRange),
      publisher: str(data.publisher),
      place: str(data.place),
      edition: str(data.edition),
      editors: str(data.editors),
      doi: str(data.doi),
      url: str(data.url),
      link: str(data.link),
      pagesCount: str(data.pages),
      tags: normTags(data.tags),
      project: str(data.project),
      status: data.done === true ? 'finished' : (statusWord(data.status) || 'not-started'),
      priority: str(data.priority),
      note: str(data.note),
      category: str(data.category),
      ref: str(data.ref),
      fingerprint: str(data.fingerprint),
      lastPage: numOr0(data.lastPage),
      addedAt: str(data.addedAt),
      archived: data.archived === true,
      order: numOr0(data.order)
    };
  }

  var SOURCE_STRINGS = ['title', 'author', 'venue', 'volume', 'issue', 'pageRange', 'publisher', 'place', 'edition',
    'editors', 'doi', 'url', 'link', 'project', 'priority', 'note', 'category', 'ref', 'fingerprint', 'addedAt'];

  /* JS-shape partial -> Firestore fields. Only the keys present are returned; unknown or derived keys
     (id, authors, ...) are dropped; undefined never appears. */
  function toSourceFields(partial){
    var p = obj(partial), out = {}, v;
    SOURCE_STRINGS.forEach(function(k){ v = strField(p[k]); if(v !== undefined) out[k] = v; });
    if(p.author === undefined && Array.isArray(p.authors)) out.author = authorsToString(p.authors);
    v = strField(p.year); if(v !== undefined) out.year = v.trim();
    v = typeField(p.type); if(v !== undefined) out.type = v;
    v = strField(p.pagesCount !== undefined ? p.pagesCount : p.pages); if(v !== undefined) out.pages = v;
    v = tagsField(p.tags); if(v !== undefined) out.tags = v;
    if(p.status !== undefined){
      var st = statusWord(p.status);
      if(st) out.status = st;          // only `status` is written; a legacy `done` flag is cleared by updateSource (see there)
    }
    if(p.lastPage !== undefined){
      var lp = p.lastPage === null ? 0 : num(p.lastPage);
      if(lp !== undefined) out.lastPage = lp;
    }
    if(typeof p.archived === 'boolean') out.archived = p.archived;
    if(p.order !== undefined){ var o = num(p.order); if(o !== undefined) out.order = o; }
    return out;
  }

  /* ------------------------------------------------------------------ mapping: notes and highlights */

  function fromNoteDoc(id, data){
    data = obj(data);
    var kind = data.kind === 'highlight' ? 'highlight' : 'note';
    var text = str(data.text);
    var hl = hlWord(data.hl);
    return {
      id: str(id),
      kind: kind,
      title: str(data.title),
      text: text,
      quote: str(data.quote),
      page: numOr0(data.page),
      rects: normRects(data.rectsJson),
      hl: kind === 'highlight' ? (hl || 'idea') : hl,
      sourceId: str(data.sourceId),
      tags: unionTags(normTags(data.tags), parseTags(text)),   // a #tag typed in the text counts as a tag
      project: str(data.project),
      createdAt: str(data.createdAt),
      updatedAt: str(data.updatedAt),
      archived: data.archived === true,
      order: numOr0(data.order)
    };
  }

  var NOTE_STRINGS = ['title', 'text', 'quote', 'sourceId', 'project', 'createdAt', 'updatedAt'];

  function toNoteFields(partial){
    var p = obj(partial), out = {}, v;
    NOTE_STRINGS.forEach(function(k){ v = strField(p[k]); if(v !== undefined) out[k] = v; });
    if(p.kind === 'note' || p.kind === 'highlight') out.kind = p.kind;
    if(p.page !== undefined){
      var pg = p.page === null ? 0 : num(p.page);
      if(pg !== undefined) out.page = pg;
    }
    v = rectsField(p.rects !== undefined ? p.rects : p.rectsJson);
    if(v !== undefined) out.rectsJson = v;
    // an empty or unknown hl is never written: it would turn an Evidence highlight back into Idea on the next read
    var hl = hlWord(p.hl);
    if(hl) out.hl = hl;
    v = tagsField(p.tags); if(v !== undefined) out.tags = v;
    if(typeof p.archived === 'boolean') out.archived = p.archived;
    if(p.order !== undefined){ var o = num(p.order); if(o !== undefined) out.order = o; }
    return out;
  }

  /* ------------------------------------------------------------------ the store */

  var store = {};
  root.Lib.store = store;

  store.TYPES = TYPES;
  store.STATUSES = STATUSES;
  store.HIGHLIGHT_KINDS = HL_KINDS;
  store.DEFAULT_PROJECTS = DEFAULT_PROJECTS;

  store.fromSourceDoc = fromSourceDoc;
  store.toSourceFields = toSourceFields;
  store.fromNoteDoc = fromNoteDoc;
  store.toNoteFields = toNoteFields;
  store.parseLinks = parseLinks;
  store.parseTags = parseTags;

  // live state (replaced, never mutated in place, so the UI can compare references)
  store.sources = [];      // active sources, sorted by order
  store.notes = [];        // active notes (kind note)
  store.highlights = [];   // active highlights
  store.allSources = [];   // the same including archived ones (podcasts are never in here)
  store.allNotes = [];
  store.allHighlights = [];
  store.status = 'connecting';   // 'connecting' | 'ok' | 'err'
  store.error = '';              // plain-words text when status is 'err'
  store.errorCode = '';          // the Firestore code of the first failure ('permission-denied', ...)

  var LABEL = {reading: 'reading list', notes: 'notes'};
  var db = null;
  var started = false;
  var changeFns = [];
  var cols = null;

  function freshCol(){
    return {raw: [], maxOrder: 0, lastOrder: 0, maxRef: 0, lastRef: 0, ready: false, error: '', errorCode: '', unsub: null, waiters: []};
  }
  function resetState(){
    cols = {reading: freshCol(), notes: freshCol()};
    store.sources = []; store.notes = []; store.highlights = [];
    store.allSources = []; store.allNotes = []; store.allHighlights = [];
    store.status = 'connecting'; store.error = ''; store.errorCode = '';
  }
  resetState();

  function emit(what){
    changeFns.slice().forEach(function(fn){
      try { fn(what); } catch(e){ if(typeof console !== 'undefined') console.error(e); }
    });
  }

  store.onChange = function(fn){
    if(typeof fn !== 'function') return function(){};
    changeFns.push(fn);
    return function(){
      var i = changeFns.indexOf(fn);
      if(i >= 0) changeFns.splice(i, 1);
    };
  };

  function stableSort(list, cmp){
    return list.map(function(x, i){ return {x: x, i: i}; })
      .sort(function(a, b){ return cmp(a.x, b.x) || a.i - b.i; })
      .map(function(w){ return w.x; });
  }
  function byOrder(a, b){ return a.order - b.order; }
  function active(x){ return !x.archived; }

  function rebuild(which){
    var c = cols[which], list;
    if(which === 'reading'){
      list = c.raw.filter(function(r){ return r.data.kind !== 'podcast'; })
        .map(function(r){ return fromSourceDoc(r.id, r.data); });
      store.allSources = stableSort(list, byOrder);
      store.sources = store.allSources.filter(active);
    } else {
      list = c.raw.map(function(r){ return fromNoteDoc(r.id, r.data); });
      list = stableSort(list, byOrder);
      store.allNotes = list.filter(function(n){ return n.kind === 'note'; });
      store.allHighlights = list.filter(function(n){ return n.kind === 'highlight'; });
      store.notes = store.allNotes.filter(active);
      store.highlights = store.allHighlights.filter(active);
    }
  }

  function recomputeStatus(){
    var msgs = [], code = '';
    ['reading', 'notes'].forEach(function(w){
      if(cols[w].error){ msgs.push(cols[w].error); code = code || cols[w].errorCode; }
    });
    if(msgs.length){ store.status = 'err'; store.error = msgs.join(' '); store.errorCode = code; }
    else if(cols.reading.ready && cols.notes.ready){ store.status = 'ok'; store.error = ''; store.errorCode = ''; }
    else { store.status = 'connecting'; store.error = ''; store.errorCode = ''; }
  }

  function codeOf(err){
    return err && err.code ? String(err.code).replace(/^firestore\//, '') : '';
  }

  function listenError(which, err){
    var code = codeOf(err), c = cols[which], label = LABEL[which], msg;
    if(code === 'permission-denied') msg = 'Can\u2019t open your ' + label + ' yet. Firestore says no, so its rule needs adding.';
    else if(code === 'unavailable' || code === 'deadline-exceeded') msg = 'Can\u2019t reach Firestore right now. Check your internet.';
    else msg = 'Something went wrong opening your ' + label + '.';
    c.error = msg; c.errorCode = code || 'error';
    if(typeof console !== 'undefined') console.error(err);
    c.waiters.splice(0).forEach(function(w){ w.rej(humanError(err, 'your ' + label)); });
    recomputeStatus();
    emit('status');
  }

  function listenSnapshot(which, snap){
    var c = cols[which], raw = [], max = 0, maxRef = 0;
    var docs = snap && snap.docs ? snap.docs : [];
    docs.forEach(function(d){
      var data = d.data() || {};
      raw.push({id: d.id, data: data});
      var o = num(data.order);            // the same reading as the sort uses ('500' counts as 500), so a new doc never lands before it
      if(o !== undefined && o > max) max = o;
      var r = parseInt(data.ref, 10);
      if(!isNaN(r) && r > maxRef) maxRef = r;
    });
    c.raw = raw; c.maxOrder = max; c.maxRef = maxRef; c.ready = true; c.error = ''; c.errorCode = '';
    rebuild(which);
    recomputeStatus();
    c.waiters.splice(0).forEach(function(w){ w.res(); });
    emit(which);
  }

  function failInit(text, code){
    cols.reading.error = text; cols.reading.errorCode = code;
    recomputeStatus();
    emit('status');
  }

  /* init() or init({db, now}): start the two live listeners. Safe to call twice. */
  store.init = function(opts){
    opts = opts || {};
    var useDb = opts.db || null;
    if(!useDb){
      try { useDb = root.firebase && root.firebase.firestore ? root.firebase.firestore() : null; } catch(e){ useDb = null; }
    }
    // a second call while all is well changes nothing; after a failed listener it starts over (this is the retry)
    if(started && db === useDb && store.status !== 'err'){ if(opts.now) store._now = opts.now; return store; }
    if(started) store.stop();
    resetState();
    store._now = opts.now || null;       // tests can pass a clock; pages never do
    db = useDb;
    if(!db){
      failInit('The library could not connect: Firestore is not loaded on this page.', 'no-firestore');
      return store;
    }
    started = true;
    ['reading', 'notes'].forEach(function(which){
      try {
        cols[which].unsub = db.collection(which).onSnapshot(
          function(snap){ listenSnapshot(which, snap); },
          function(err){ listenError(which, err); }
        );
      } catch(e){ listenError(which, e); }
    });
    emit('status');
    return store;
  };

  /* Stop the listeners and forget everything (the next init() starts clean). */
  store.stop = function(){
    if(cols){
      ['reading', 'notes'].forEach(function(w){
        if(cols[w].unsub){ try { cols[w].unsub(); } catch(e){} }
        cols[w].waiters.splice(0).forEach(function(x){ x.rej(libError('The library was closed.', 'closed')); });
      });
    }
    started = false; db = null;
    resetState();
  };

  /* ------------------------------------------------------------------ writes */

  function humanError(err, what){
    if(err && err.isLibError) return err;
    var code = codeOf(err), msg;
    if(code === 'permission-denied') msg = 'Can\u2019t save to ' + what + ' yet. Firestore says no, so its rule needs adding.';
    else if(code === 'not-found') msg = 'That item is gone, so the change could not be saved.';
    else if(code === 'unavailable' || code === 'deadline-exceeded') msg = 'Can\u2019t reach Firestore right now. Check your internet and try again.';
    else msg = 'Something went wrong saving to ' + what + '.';
    var e = new Error(msg);
    e.isLibError = true; e.code = code; e.cause = err;
    return e;
  }
  function libError(msg, code){
    var e = new Error(msg); e.isLibError = true; e.code = code || ''; return e;
  }

  function whenReady(which){
    var c = cols[which];
    return new Promise(function(res, rej){
      if(!db || !started) return rej(libError('The library isn\u2019t connected yet.', 'not-connected'));
      if(c.ready) return res();
      if(c.error) return rej(libError(c.error, c.errorCode));
      c.waiters.push({res: res, rej: rej});
    });
  }

  function nextOrder(which){
    var c = cols[which];
    var n = Math.max(c.maxOrder, c.lastOrder) + 10;
    c.lastOrder = n;
    return n;
  }
  function nextRef(){
    var c = cols.reading;
    var n = Math.max(c.maxRef, c.lastRef) + 1;
    c.lastRef = n;
    return n;
  }

  function guard(what, fn){
    return new Promise(function(res){ res(fn()); }).catch(function(e){ throw humanError(e, what); });
  }
  function noDb(){
    if(!db || !started) throw libError('The library isn\u2019t connected yet.', 'not-connected');
  }
  function needId(id){
    if(typeof id !== 'string' || !id) throw libError('That item could not be found.', 'not-found');
  }

  function updateDoc(which, id, fields){
    return guard('your ' + LABEL[which], function(){
      noDb(); needId(id);
      if(!Object.keys(fields).length) return undefined;
      return db.collection(which).doc(id).update(fields).then(function(){});
    });
  }
  function addDoc(which, build){
    return guard('your ' + LABEL[which], function(){
      return whenReady(which).then(function(){
        noDb();
        return db.collection(which).add(build());
      }).then(function(ref){ return ref.id; });
    });
  }

  // ----- sources
  store.addSource = function(fields){
    return addDoc('reading', function(){
      var d = toSourceFields(fields);
      d.kind = 'read';
      if(d.status === undefined) d.status = 'not-started';
      if(d.addedAt === undefined || d.addedAt === '') d.addedAt = now();
      if(d.ref === undefined || d.ref === '') d.ref = String(nextRef());
      d.order = nextOrder('reading');
      return d;
    });
  };
  function rawDoc(which, id){
    var raw = cols[which].raw;
    for(var i = 0; i < raw.length; i++) if(raw[i].id === id) return raw[i].data;
    return null;
  }
  /* A legacy `done:true` always wins when reading (done => finished). So when a status is written to a doc that
     still carries done:true, that flag is cleared too; otherwise a later status change made on the old reading
     page (which writes only `status`) would never show. Docs without a `done` flag get no extra field. */
  store.updateSource = function(id, partial){
    var f = toSourceFields(partial);
    if(f.status !== undefined){
      var cur = rawDoc('reading', id);
      if(cur && cur.done === true) f.done = false;
    }
    return updateDoc('reading', id, f);
  };
  store.setStatus = function(id, status){
    var st = statusWord(status);
    if(!st) return Promise.reject(libError('Status has to be To read, Reading or Finished.', 'bad-status'));
    return store.updateSource(id, {status: st});
  };
  store.archiveSource = function(id){ return updateDoc('reading', id, {archived: true}); };
  store.restoreSource = function(id){ return updateDoc('reading', id, {archived: false}); };

  // ----- notes and highlights
  // every change made through the store refreshes updatedAt (a stale one in the partial is overwritten)
  function updateNoteDoc(id, partial){
    var f = toNoteFields(partial);
    if(Object.keys(f).length) f.updatedAt = now();
    return updateDoc('notes', id, f);
  }

  store.addNote = function(fields){
    return addDoc('notes', function(){
      var d = toNoteFields(fields);
      d.kind = 'note';
      if(d.text === undefined) d.text = '';
      if(d.createdAt === undefined || d.createdAt === '') d.createdAt = now();
      if(d.updatedAt === undefined || d.updatedAt === '') d.updatedAt = d.createdAt;
      d.order = nextOrder('notes');
      return d;
    });
  };
  store.updateNote = updateNoteDoc;
  store.archiveNote = function(id){ return updateNoteDoc(id, {archived: true}); };
  store.restoreNote = function(id){ return updateNoteDoc(id, {archived: false}); };

  store.addHighlight = function(fields){
    return addDoc('notes', function(){
      var d = toNoteFields(fields);
      d.kind = 'highlight';
      if(!d.hl) d.hl = 'idea';
      if(d.text === undefined) d.text = '';
      if(d.quote === undefined) d.quote = '';
      if(d.rectsJson === undefined) d.rectsJson = '[]';
      if(d.createdAt === undefined || d.createdAt === '') d.createdAt = now();
      if(d.updatedAt === undefined || d.updatedAt === '') d.updatedAt = d.createdAt;
      d.order = nextOrder('notes');
      return d;
    });
  };
  store.updateHighlight = updateNoteDoc;
  store.archiveHighlight = function(id){ return updateNoteDoc(id, {archived: true}); };
  store.restoreHighlight = function(id){ return updateNoteDoc(id, {archived: false}); };

  /* ------------------------------------------------------------------ queries */

  function findIn(list, id){
    for(var i = 0; i < list.length; i++) if(list[i].id === id) return list[i];
    return null;
  }
  store.getSource = function(id){ return findIn(store.allSources, id); };
  store.getNote = function(id){ return findIn(store.allNotes, id) || findIn(store.allHighlights, id); };

  function byPosition(a, b){
    var ay = a.rects.length ? a.rects[0][1] : 0, by = b.rects.length ? b.rects[0][1] : 0;
    var ax = a.rects.length ? a.rects[0][0] : 0, bx = b.rects.length ? b.rects[0][0] : 0;
    return (a.page - b.page) || (ay - by) || (ax - bx) || (a.order - b.order);
  }

  /* Highlights of one source, in reading order (page, then top to bottom). */
  store.highlightsFor = function(sourceId){
    return stableSort(store.highlights.filter(function(h){ return h.sourceId === sourceId; }), byPosition);
  };
  store.notesFor = function(sourceId){
    return store.notes.filter(function(n){ return n.sourceId === sourceId; });
  };

  /* Notes that contain [[title]]. Accepts a title or the id of a note or source. */
  store.backlinks = function(titleOrId){
    var q = keyOf(titleOrId);
    if(!q) return [];
    var keys = dict(), self = null;
    keys['$' + q] = true;
    if(typeof titleOrId === 'string'){
      self = store.getSource(titleOrId) || store.getNote(titleOrId);
      if(self && keyOf(self.title)) keys['$' + keyOf(self.title)] = true;
    }
    return store.notes.filter(function(n){
      if(self && n.id === self.id) return false;
      if(n.text.indexOf('[[') < 0) return false;
      return parseLinks(n.text).some(function(t){ return keys['$' + keyOf(t)]; });
    });
  };

  /* Project names: the defaults first, then any others in use (A to Z). */
  store.projects = function(){
    var seen = dict(), out = DEFAULT_PROJECTS.slice(), extra = [];
    out.forEach(function(p){ seen['$' + keyOf(p)] = true; });
    [store.sources, store.notes, store.highlights].forEach(function(list){
      list.forEach(function(it){
        var p = squash(it.project), k = '$' + keyOf(p);
        if(!p || seen[k]) return;
        seen[k] = true;
        extra.push(p);
      });
    });
    extra.sort(function(a, b){ return a.localeCompare(b); });
    return out.concat(extra);
  };

  /* Tags in use as [{tag, count}], most used first. */
  store.tags = function(){
    var counts = dict(), names = dict(), keys = [];
    [store.sources, store.notes, store.highlights].forEach(function(list){
      list.forEach(function(it){
        it.tags.forEach(function(t){
          var k = '$' + t.toLowerCase();
          if(!counts[k]){ counts[k] = 0; names[k] = t; keys.push(k); }
          counts[k]++;
        });
      });
    });
    return keys.map(function(k){ return {tag: names[k], count: counts[k]}; })
      .sort(function(a, b){ return (b.count - a.count) || a.tag.localeCompare(b.tag); });
  };

  /* Everything, archived included, for a backup download. `raw` keeps the documents exactly as stored
     (podcasts and fields this page does not know included), so nothing is lost. */
  store.exportAll = function(){
    function rawDump(which){
      return cols[which].raw.map(function(r){
        var o;
        // one odd document (a value JSON cannot hold) must never stop the whole backup
        try { o = JSON.parse(JSON.stringify(r.data)); } catch(e){ o = {_notSaved: 'This document could not be copied as plain JSON.'}; }
        o.id = r.id;
        return o;
      });
    }
    return JSON.parse(JSON.stringify({
      exportedAt: now(),
      sources: store.allSources,
      notes: store.allNotes,
      highlights: store.allHighlights,
      raw: {reading: rawDump('reading'), notes: rawDump('notes')}
    }));
  };

  if(typeof module !== 'undefined') module.exports = root.Lib.store;
})();
