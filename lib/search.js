/* Lib.search: the search engine for the library (pure: runs in the browser and in node).
   - norm(s)               fold case, diacritics, Arabic letter variants, apostrophe-like marks
   - build(items)          inverted index; index.query(q, opts) -> [{item, score, snippet}]
   - snippet(text, terms)  short plain-text excerpt around the first hit
   - highlightHTML(t, ts)  escaped HTML with <mark> around the hits
   Extra helpers the page can use: parse(q), terms(q), tokens(s); index.terms(q), index.size.
   Query: plain words (all must match, the last one may be a prefix), "quoted phrase", tag:x, project:x or
   project:"two words", kind:note|source|highlight (several: kind:note|source), -word / -"phrase" / -tag:x to
   exclude. A query is cut at 64 words, one word or phrase at 40 tokens, the whole query at 256 tokens. A leading Latin
   "al-" / "el-" in front of a word is optional ("al-Qushji" also finds "Qushji"); quoted phrases stay exact.
   Ranking: title > author > tags > text/quote, exact beats prefix, then newest updatedAt, then input order.
   hit.snippet is computed on first read (a long result list stays cheap).
   No Arabic-to-Latin transliteration is attempted: only folding. */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window :
             typeof globalThis !== 'undefined' ? globalThis :
             typeof global !== 'undefined' ? global : {};
  root.Lib = root.Lib || {};

  /* ------------------------------------------------------------------
     1. Character folding (one code point at a time, so every normalised
        character can be traced back to the original characters)
     ------------------------------------------------------------------ */
  var MARK = '\uffff';   // sentinel: "this code point was a combining mark and vanished"
  var MARK_RE = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0730-\u074a\u08d3-\u08ff\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f]/;
  // white space: like \s but WITHOUT U+FEFF, which norm() drops (it joins the letters around it), so every
  // place that splits words or collapses spaces sees the same words as the index does
  var WS_CLASS = '\\t-\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  var WS_RE = new RegExp('[' + WS_CLASS + ']');
  var WS_RUN = new RegExp('[' + WS_CLASS + ']+', 'g');
  var DROP = {};   // code -> true: characters that simply disappear
  (function () {
    var list = [
      0x27, 0x60, 0xb4,                          // ' ` acute
      0x2018, 0x2019, 0x201b,                    // curly single quotes (left, right, reversed)
      0x2bb, 0x2bc, 0x2bd, 0x2be, 0x2bf,        // modifier letters: okina, apostrophe, reversed comma, hamza, ayn
      0x2c0, 0x2c1,                              // glottal stop, reversed glottal stop (also used for hamza / ayn)
      0xad, 0x640,                               // soft hyphen, Arabic tatweel
      0x200d, 0x200e, 0x200f,                    // joiner, LRM, RLM
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2060, 0x2066, 0x2067, 0x2068, 0x2069,
      0x61c, 0xfeff
    ];
    for (var i = 0; i < list.length; i++) { DROP[list[i]] = true; }
  })();

  var SPECIAL = {   // single character -> replacement (applied after NFKD + lower-case)
    '\u00df': 'ss', '\u00e6': 'ae', '\u0153': 'oe', '\u00f8': 'o', '\u0111': 'd',
    '\u00f0': 'd', '\u00fe': 'th', '\u0142': 'l', '\u0131': 'i', '\u0127': 'h', '\u0167': 't',
    // Arabic letter folding
    '\u0623': '\u0627', '\u0625': '\u0627', '\u0622': '\u0627', '\u0671': '\u0627',   // alef variants -> alef
    '\u0649': '\u064a', '\u06cc': '\u064a', '\u06d2': '\u064a',                      // alef maqsura, Persian yeh -> yeh
    '\u0629': '\u0647', '\u06c1': '\u0647', '\u06d5': '\u0647',                      // ta marbuta, heh goal -> heh
    '\u06a9': '\u0643',                                                              // Persian kaf -> kaf
    '\u0624': '\u0648', '\u0626': '\u064a',                                          // hamza on waw / yeh (if NFKD is missing)
    '\u03c2': '\u03c3'                                                              // Greek final sigma -> sigma
  };
  (function () {
    for (var k = 0; k < 10; k++) {   // Arabic-Indic and Persian digits -> 0-9
      SPECIAL[String.fromCharCode(0x660 + k)] = String(k);
      SPECIAL[String.fromCharCode(0x6f0 + k)] = String(k);
    }
  })();

  function foldOne(ch) {
    var c = ch.charCodeAt(0), d, i, x, xc, out = '', sawMark = false, sp;
    if (c < 128) {
      if (c === 39 || c === 96) { return ''; }
      if (c >= 65 && c <= 90) { return String.fromCharCode(c + 32); }
      if (c === 32 || (c >= 9 && c <= 13)) { return ' '; }
      return ch;
    }
    if (DROP[c]) { return ''; }
    d = ch;
    if (typeof ch.normalize === 'function') { d = ch.normalize('NFKD'); }
    d = d.toLowerCase();
    for (i = 0; i < d.length; i++) {
      x = d.charAt(i); xc = d.charCodeAt(i);
      if (DROP[xc]) { continue; }
      if (MARK_RE.test(x)) { sawMark = true; continue; }
      if (xc === 0x200b || xc === 0x200c || WS_RE.test(x)) { out += ' '; continue; }
      sp = SPECIAL[x];
      out += (sp !== undefined) ? sp : x;
    }
    if (out === '') { return sawMark ? MARK : ''; }
    return out;
  }

  var foldLo = [];                       // code unit -> folded string
  var foldHi = Object.create(null);      // astral code point (2 code units) -> folded string

  // s -> {s: normalised string, st: [original start per normalised char], en: [original end per normalised char]}
  function normMap(s, wantMap) {
    var n = s.length, out = '', st = wantMap ? [] : null, en = wantMap ? [] : null;
    var i = 0, m = 0, c, c2, len, f, k, x, lastSp = true;
    while (i < n) {
      c = s.charCodeAt(i); len = 1;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
        c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) { len = 2; }
      }
      if (len === 1) {
        f = foldLo[c];
        if (f === undefined) { f = foldLo[c] = foldOne(s.charAt(i)); }
      } else {
        x = s.substr(i, 2);
        f = foldHi[x];
        if (f === undefined) { f = foldHi[x] = foldOne(x); }
      }
      if (f === MARK) {                   // a combining mark: it belongs to the character before it
        if (wantMap && m > 0) { en[m - 1] = i + len; }
        i += len; continue;
      }
      for (k = 0; k < f.length; k++) {
        x = f.charAt(k);
        if (x === ' ') {
          if (lastSp) { if (wantMap && m > 0) { en[m - 1] = i + len; } continue; }
          lastSp = true;
        } else { lastSp = false; }
        out += x;
        if (wantMap) { st.push(i); en.push(i + len); }
        m++;
      }
      i += len;
    }
    if (lastSp && m > 0) {                // drop the trailing space
      out = out.slice(0, -1);
      if (wantMap) { st.pop(); en.pop(); }
    }
    return wantMap ? { s: out, st: st, en: en } : out;
  }

  var NONASCII = /[^\x00-\x7f]/;
  function norm(s) {
    if (typeof s === 'number') { s = String(s); }
    else if (typeof s !== 'string') { return ''; }
    if (!NONASCII.test(s)) {
      return s.toLowerCase().replace(/['`]+/g, '').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }
    return normMap(s, false);
  }

  /* ------------------------------------------------------------------
     2. Tokens (words), with Arabic definite-article stripping for matching
     ------------------------------------------------------------------ */
  function tokKind(c) {   // 0 separator, 1 word character, 2 single-character token (CJK)
    if (c < 0x80) { return ((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90)) ? 1 : 0; }
    if (c < 0xc0) { return 0; }
    if (c === 0xd7 || c === 0xf7) { return 0; }
    if (c >= 0x2000 && c <= 0x2bff) { return 0; }
    if (c >= 0x2e00 && c <= 0x2e7f) { return 0; }
    if (c >= 0x3000 && c <= 0x303f) { return 0; }
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) { return 2; }
    if (c >= 0xd800 && c <= 0xf8ff) { return 0; }      // surrogates, private use
    if (c >= 0xfe00 && c <= 0xfe0f) { return 0; }
    if (c >= 0xfe30 && c <= 0xfe6f) { return 0; }
    if (c >= 0xfff0) { return 0; }
    if ((c >= 0x600 && c <= 0x605) || c === 0x609 || c === 0x60a || c === 0x60c || c === 0x60d ||
        c === 0x61b || c === 0x61e || c === 0x61f || (c >= 0x66a && c <= 0x66d) || c === 0x6d4 ||
        c === 0x6dd || c === 0x6de || c === 0x6e9 || c === 0xfd3e || c === 0xfd3f ||
        c === 0x964 || c === 0x965) { return 0; }
    return 1;
  }
  var TK = new Uint8Array(65536);
  (function () { for (var c = 0; c < 65536; c++) { TK[c] = tokKind(c); } })();

  // positions of the tokens inside an already-normalised string
  function tokenize(ns) {
    var S = [], E = [], n = ns.length, st = -1, i, k;
    for (i = 0; i < n; i++) {
      k = TK[ns.charCodeAt(i)];
      if (k === 1) { if (st < 0) { st = i; } }
      else {
        if (st >= 0) { S.push(st); E.push(i); st = -1; }
        if (k === 2) { S.push(i); E.push(i + 1); }
      }
    }
    if (st >= 0) { S.push(st); E.push(n); }
    return { S: S, E: E };
  }
  function rawTokens(ns) {
    var t = tokenize(ns), out = [], i;
    for (i = 0; i < t.S.length; i++) { out.push(ns.slice(t.S[i], t.E[i])); }
    return out;
  }

  // The Arabic definite article attached to a word (alef-lam, also after ba, kaf, and the contracted
  // lam-lam of li + al, each optionally after the conjunction waw / fa): the word is indexed and searched
  // without it, so the word with and without "al-" match each other
  function stripArticle(t, min) {
    var i = 0, c = t.charCodeAt(0), o = 0;
    if (c === 0x0648 || c === 0x0641) { i = 1; c = t.charCodeAt(1); }          // waw, fa
    if (c === 0x0627 && t.charCodeAt(i + 1) === 0x0644) { o = i + 2; }          // al
    else if ((c === 0x0628 || c === 0x0643) &&
             t.charCodeAt(i + 1) === 0x0627 && t.charCodeAt(i + 2) === 0x0644) { o = i + 3; }   // bi-al, ka-al
    else if (c === 0x0644 && t.charCodeAt(i + 1) === 0x0644) { o = i + 2; }     // li-al contracted: lil-
    if (o && t.length - o >= min) { return t.slice(o); }
    return t;
  }
  function keyOf(t) { return t.charCodeAt(0) < 0x0600 ? t : stripArticle(t, 3); }

  function keysOf(ns) {
    var t = tokenize(ns), out = new Array(t.S.length), i;
    for (i = 0; i < out.length; i++) { out[i] = keyOf(ns.slice(t.S[i], t.E[i])); }
    return out;
  }

  /* ------------------------------------------------------------------
     3. Small helpers
     ------------------------------------------------------------------ */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function str(v) {
    if (v === null || v === undefined) { return ''; }
    if (typeof v === 'string') { return v; }
    if (typeof v === 'number') { return String(v); }
    return '';
  }
  function tagList(v) {
    var a = [], i, s;
    if (Array.isArray(v)) { for (i = 0; i < v.length; i++) { s = str(v[i]); if (s) { a.push(s); } } }
    else if (typeof v === 'string') { a = v.split(/[,;\n]+/); }
    return a;
  }
  function toTs(v) {
    var t;
    try {   // an odd timestamp object must never break the whole index
      if (v === null || v === undefined || v === '') { return 0; }
      if (typeof v === 'number') { return isFinite(v) ? v : 0; }
      if (typeof v === 'object') {
        if (typeof v.toMillis === 'function') { t = v.toMillis(); return typeof t === 'number' && isFinite(t) ? t : 0; }
        if (typeof v.getTime === 'function') { t = v.getTime(); return typeof t === 'number' && isFinite(t) ? t : 0; }
        if (typeof v.seconds === 'number' && isFinite(v.seconds)) { return v.seconds * 1000; }   // plain {seconds, nanoseconds}
        return 0;
      }
      t = Date.parse(String(v));
      return isNaN(t) ? 0 : t;
    } catch (e) { return 0; }
  }
  function lowerBound(arr, x) {
    var lo = 0, hi = arr.length, mid;
    while (lo < hi) { mid = (lo + hi) >> 1; if (arr[mid] < x) { lo = mid + 1; } else { hi = mid; } }
    return lo;
  }

  /* ------------------------------------------------------------------
     4. Query parsing
     ------------------------------------------------------------------ */
  var KINDS = ['source', 'note', 'highlight'];
  var OPEN_Q = '"\u201c\u201e\u00ab';
  var CLOSE_Q = '"\u201d\u201c\u00bb';
  var FILTER_RE = /^(tags?|project|kind):/i;
  var MAX_WORDS = 64;                 // a query longer than this is cut (nobody types more; keeps the cost bounded)
  var MAX_UNIT_TOKENS = 40;           // one word or phrase is cut after this many tokens (a pasted paragraph in quotes)
  var MAX_QUERY_TOKENS = 256;         // and the whole query after this many (each token costs one array of N numbers)
  var PREFIX_Q = 7, PREFIX_D = 10;   // a prefix hit is worth 7/10 of an exact hit (kept in integers)

  function readQuoted(q, i) {
    var j = i + 1, n = q.length;
    while (j < n && CLOSE_Q.indexOf(q.charAt(j)) < 0) { j++; }
    return { text: q.slice(i + 1, j), next: j < n ? j + 1 : n, closed: j < n };
  }

  function prefixAlts(raw) {
    var a = [raw], s = stripArticle(raw, 1);
    if (s && s !== raw) { a.push(s); }
    return a;
  }
  // raws: normalised tokens. prefix: the last token may be a prefix.
  // lenient: a leading Latin article ("al-", "el-") in front of another word is optional, so
  // "al-Qushji" also finds "Qushji, Ali". Quoted phrases stay exact.
  var PARTICLE = { al: 1, el: 1 };
  function makeUnit(raws, prefix, lenient) {
    var lead = '', n, keys = [], i;
    if (lenient && raws.length > 1 && PARTICLE[raws[0]] === 1) { lead = raws[0]; raws = raws.slice(1); }
    n = raws.length;
    for (i = 0; i < n; i++) { keys.push(keyOf(raws[i])); }
    return {
      n: n,
      keys: keys.slice(0, n - 1),
      lastKey: keys[n - 1],
      prefix: prefix,
      lead: lead,
      alts: prefix ? prefixAlts(raws[n - 1]) : [keys[n - 1]]
    };
  }

  function resolveKinds(v) {   // "note", "notes", "n" -> {note:true}; "note|source" or "note,source" -> both; unknown -> {}
    var set = {}, parts, p, i, j, k;
    v = norm(v);
    if (!v) { return set; }
    parts = v.split(/[|,;]/);
    for (j = 0; j < parts.length; j++) {
      p = parts[j].replace(/^ | $/g, '');
      if (!p) { continue; }
      for (i = 0; i < KINDS.length; i++) {
        k = KINDS[i];
        if (p === k || p === k + 's' || k.indexOf(p) === 0) { set[k] = true; }
      }
    }
    return set;
  }

  function joinKeys(s) { return keysOf(norm(s)).join(' '); }

  function parseInternal(q) {
    q = typeof q === 'string' ? q : (typeof q === 'number' ? String(q) : '');
    var n = q.length, i = 0, ch, neg, m, r, start, key, val, j, it, items = [];
    while (i < n && items.length < MAX_WORDS) {
      ch = q.charAt(i);
      if (WS_RE.test(ch)) { i++; continue; }
      neg = false;
      if ((ch === '-' || ch === '\u2212') && i + 1 < n && !WS_RE.test(q.charAt(i + 1))) {
        neg = true; i++; ch = q.charAt(i);
      }
      m = FILTER_RE.exec(q.slice(i, i + 9));
      if (m) {
        key = m[1].charAt(0).toLowerCase();
        key = key === 't' ? 'tag' : (key === 'p' ? 'project' : 'kind');
        i += m[0].length;
        if (i < n && OPEN_Q.indexOf(q.charAt(i)) >= 0) { r = readQuoted(q, i); val = r.text; i = r.next; }
        else { start = i; while (i < n && !WS_RE.test(q.charAt(i))) { i++; } val = q.slice(start, i); }
        items.push({ type: 'filter', key: key, val: val, neg: neg });
        continue;
      }
      if (OPEN_Q.indexOf(ch) >= 0) {
        r = readQuoted(q, i); i = r.next;
        items.push({ type: 'phrase', text: r.text, closed: r.closed, neg: neg });
        continue;
      }
      start = i;
      while (i < n && !WS_RE.test(q.charAt(i))) { i++; }
      items.push({ type: 'word', text: q.slice(start, i), closed: false, neg: neg });
    }

    var res = {
      pos: [], neg: [], terms: [], exclude: [], filters: [],
      F: { tags: [], projects: [], kinds: [] }
    };
    var lastPos = -1, v, merged = [], nx;
    for (j = 0; j < items.length; j++) {   // a lone "al" in front of another word is its article: "al-word"
      it = items[j]; nx = items[j + 1];
      if (it.type === 'word' && !it.neg && PARTICLE[norm(it.text)] === 1 && nx && nx.type === 'word' && !nx.neg) {
        nx.text = it.text + '-' + nx.text;
        continue;
      }
      merged.push(it);
    }
    items = merged;
    var budget = MAX_QUERY_TOKENS;
    for (j = 0; j < items.length; j++) {
      it = items[j];
      if (it.type !== 'filter') {
        it.raws = rawTokens(norm(it.text));
        if (it.raws.length > MAX_UNIT_TOKENS) { it.raws.length = MAX_UNIT_TOKENS; }
        if (it.raws.length > budget) { it.raws.length = budget; }
        budget -= it.raws.length;
        if (it.raws.length && !it.neg) { lastPos = j; }
      }
    }
    for (j = 0; j < items.length; j++) {
      it = items[j];
      if (it.type === 'filter') {
        res.filters.push({ key: it.key, value: it.val, not: it.neg });
        if (it.key === 'kind') {
          if (norm(it.val)) { res.F.kinds.push({ set: resolveKinds(it.val), neg: it.neg }); }
        } else {
          v = joinKeys(it.val);
          if (v) { (it.key === 'tag' ? res.F.tags : res.F.projects).push({ v: v, neg: it.neg }); }
        }
        continue;
      }
      if (!it.raws.length) { continue; }
      if (it.neg) {
        res.neg.push(makeUnit(it.raws, false, it.type === 'word'));
        res.exclude.push(it.text);
      } else {
        res.pos.push(makeUnit(it.raws, j === lastPos && !it.closed, it.type === 'word'));
        res.terms.push(it.text);
      }
    }
    return res;
  }

  // Public: what a query means (for the page: chips, highlighting).
  function parse(q) {
    var p = parseInternal(q);
    return {
      terms: p.terms.slice(),
      exclude: p.exclude.slice(),
      filters: p.filters.slice(),
      empty: !p.pos.length && !p.neg.length && !p.F.tags.length && !p.F.projects.length && !p.F.kinds.length   // a bare "tag:" does nothing
    };
  }

  // terms for snippet / highlight: array of strings (each a word or a phrase; its last word may be
  // a prefix) or one query string.
  function unitsFromTerms(terms) {
    var out = [], i, r, t;
    if (terms === null || terms === undefined) { return out; }
    if (typeof terms === 'string') { return parseInternal(terms).pos; }
    if (!Array.isArray(terms)) { terms = [terms]; }
    for (i = 0; i < terms.length && out.length < MAX_WORDS; i++) {
      t = str(terms[i]);
      if (/^-./.test(t) || FILTER_RE.test(t)) { continue; }   // "-word" and "tag:x" are not highlighted
      r = rawTokens(norm(t));
      if (r.length > MAX_UNIT_TOKENS) { r.length = MAX_UNIT_TOKENS; }
      if (r.length) { out.push(makeUnit(r, true, true)); }
    }
    return out;
  }

  /* ------------------------------------------------------------------
     5. Finding matches inside a text (shared by snippet and highlightHTML)
     ------------------------------------------------------------------ */
  // end of the match (normalised coordinates) when token j matches the last word of unit u, else -1
  function matchLast(u, key, S, E) {
    var best = -1, i, a, e;
    if (!u.prefix) { return key === u.lastKey ? E : -1; }
    for (i = 0; i < u.alts.length; i++) {
      a = u.alts[i];
      if (key === a) { return E; }
      if (key.indexOf(a) === 0) {
        e = S + ((E - S) - key.length) + a.length;   // skip a stripped article, then the typed letters
        if (e > best) { best = e; }
      }
    }
    return best;
  }

  // ranges [start, end) in normalised coordinates
  function findRanges(ns, units) {
    var t = tokenize(ns), S = t.S, E = t.E, nT = S.length, keys = new Array(nT), j, p, ui, u, m, ok, e, a, out = [];
    if (!nT || !units.length) { return out; }
    for (j = 0; j < nT; j++) { keys[j] = keyOf(ns.slice(S[j], E[j])); }
    for (ui = 0; ui < units.length; ui++) {
      u = units[ui]; m = u.keys.length;
      for (j = 0; j + m < nT; j++) {
        ok = true;
        for (p = 0; p < m; p++) { if (keys[j + p] !== u.keys[p]) { ok = false; break; } }
        if (!ok) { continue; }
        e = matchLast(u, keys[j + m], S[j + m], E[j + m]);
        if (e < 0) { continue; }
        a = S[j];
        if (u.lead && j > 0 && ns.slice(S[j - 1], E[j - 1]) === u.lead) { a = S[j - 1]; }   // keep the "al-" inside the mark
        out.push([a, e]);
      }
    }
    return out;
  }

  // ranges in original coordinates, sorted and merged
  function originalRanges(info, units) {
    var rs = findRanges(info.s, units), out = [], i, a, b, last;
    for (i = 0; i < rs.length; i++) { out.push([info.st[rs[i][0]], info.en[rs[i][1] - 1]]); }
    out.sort(function (x, y) { return x[0] - y[0] || y[1] - x[1]; });
    var merged = [];
    for (i = 0; i < out.length; i++) {
      a = out[i][0]; b = out[i][1]; last = merged[merged.length - 1];
      if (last && a <= last[1]) { if (b > last[1]) { last[1] = b; } }
      else { merged.push([a, b]); }
    }
    return merged;
  }

  function highlightHTML(text, terms) {
    var t = str(text), units, info, rs, i, out = '', pos = 0;
    if (!t) { return ''; }
    units = unitsFromTerms(terms);
    if (!units.length) { return esc(t); }
    info = normMap(t, true);
    rs = originalRanges(info, units);
    for (i = 0; i < rs.length; i++) {
      out += esc(t.slice(pos, rs[i][0])) + '<mark>' + esc(t.slice(rs[i][0], rs[i][1])) + '</mark>';
      pos = rs[i][1];
    }
    return out + esc(t.slice(pos));
  }

  var DEFAULT_WIDTH = 120;
  function isMarkAt(t, i) { return i >= 0 && i < t.length && MARK_RE.test(t.charAt(i)); }

  // [start, end) of the first hit in t (original coordinates) or null. Long texts are scanned in
  // chunks (cut at spaces, overlapping by ~300 characters) so a snippet of a huge note stays cheap.
  function firstHit(t, units) {
    var len = t.length, CH = 4000, OV = 300, a = 0, b, c, rs;
    while (a < len) {
      b = a + CH;
      if (b >= len) { b = len; }
      else { c = t.indexOf(' ', b); b = c < 0 ? len : c; }
      rs = originalRanges(normMap(t.slice(a, b), true), units);
      if (rs.length) { return [a + rs[0][0], a + rs[0][1]]; }
      if (b >= len) { break; }
      c = t.lastIndexOf(' ', b - OV);
      a = c > a ? c + 1 : b;
    }
    return null;
  }

  // {text, hit}: excerpt of the whitespace-collapsed text; hit tells whether a term was found
  function snipCore(raw, units, width) {
    var t = raw.replace(WS_RUN, ' ').replace(/^ | $/g, ''), len = t.length, W = width, a = 0, b, hs = -1, he = -1, rs, i, na, nb, out;
    if (!len) { return { text: '', hit: false }; }
    if (units.length) {
      rs = firstHit(t, units);
      if (rs) { hs = rs[0]; he = rs[1]; }
    }
    if (len <= W) { return { text: t, hit: hs >= 0 }; }
    if (hs >= 0) {
      var hl = Math.min(he - hs, W - 4);
      a = Math.max(0, hs - Math.floor((W - 2 - hl) * 0.3));
    }
    b = Math.min(len, a + W - (a > 0 ? 1 : 0) - 1);
    if (b >= len) { b = Math.min(len, a + W - (a > 0 ? 1 : 0)); }
    if (hs >= 0 && he > b) {                       // very long hit: start the window at the hit
      a = hs; b = Math.min(len, a + W - (a > 0 ? 1 : 0) - 1);
    }
    if (b >= len && a > 0) { a = Math.min(a, len - W + 1); }   // near the end: use the room on the left
    // do not start or stop in the middle of a word when a nearby space allows it
    if (a > 0 && t.charAt(a - 1) !== ' ' && t.charAt(a) !== ' ') {
      na = t.indexOf(' ', a);
      if (na >= 0 && (hs < 0 || na + 1 <= hs)) { a = na + 1; }
    }
    if (b < len && t.charAt(b) !== ' ' && t.charAt(b - 1) !== ' ') {
      nb = t.lastIndexOf(' ', b);
      if (nb > a && (hs < 0 || nb >= he)) { b = nb; }
    }
    // never cut a surrogate pair or strand a combining mark
    while (a < b && (isMarkAt(t, a) || (t.charCodeAt(a) >= 0xdc00 && t.charCodeAt(a) <= 0xdfff))) { a++; }
    while (b > a && b < len && (isMarkAt(t, b) || (t.charCodeAt(b - 1) >= 0xd800 && t.charCodeAt(b - 1) <= 0xdbff))) { b--; }
    out = t.slice(a, b).replace(/^ | $/g, '');
    return { text: (a > 0 ? '\u2026' : '') + out + (b < len ? '\u2026' : ''), hit: hs >= 0 };
  }

  function snippet(text, terms, width) {
    width = typeof width === 'number' && isFinite(width) && width > 0 ? Math.max(8, Math.floor(width)) : DEFAULT_WIDTH;
    return snipCore(str(text), unitsFromTerms(terms), width).text;
  }

  /* ------------------------------------------------------------------
     6. The index
     ------------------------------------------------------------------ */
  // fields: 0 title, 1 author, 2 tags, 3 text, 4 quote.  Weights: title > author > tags > text/quote.
  var W_EXACT = [100, 60, 40, 10, 10];
  var BW = [], BWP = [];   // by field mask: best weight (exact / prefix)
  (function () {
    var m, f, a, b;
    for (m = 0; m < 32; m++) {
      a = 0; b = 0;
      for (f = 0; f < 5; f++) {
        if (m & (1 << f)) {
          if (W_EXACT[f] > a) { a = W_EXACT[f]; }
          if (W_EXACT[f] * PREFIX_Q / PREFIX_D > b) { b = W_EXACT[f] * PREFIX_Q / PREFIX_D; }
        }
      }
      BW[m] = a; BWP[m] = b;
    }
  })();
  var WP_FIELD = [70, 42, 28, 7, 7];

  function put(post, keys, id, f) {
    var bit = 1 << f, i, k, p, last;
    for (i = 0; i < keys.length; i++) {
      k = keys[i]; p = post[k];
      if (p === undefined) { post[k] = [(id << 5) | bit]; continue; }
      last = p.length - 1;
      if ((p[last] >>> 5) === id) { p[last] |= bit; } else { p.push((id << 5) | bit); }
    }
  }
  function jn(parts) { return parts.length ? ' ' + parts.join(' | ') + ' ' : ''; }

  function addDoc(item, id, post) {
    var doc = { item: item, kind: '', ts: 0, J: ['', '', '', '', ''], tagKeys: [], projKey: '' };
    var k = norm(str(item.kind)), keys, i, j, segs, seg, parts, tags, ns, tg;
    doc.kind = k || 'note';
    doc.ts = toTs(item.updatedAt) || toTs(item.createdAt) || toTs(item.addedAt);

    keys = keysOf(norm(str(item.title)));
    put(post, keys, id, 0);
    doc.J[0] = keys.length ? ' ' + keys.join(' ') + ' ' : '';

    // authors: "Family, Given; Family, Given". Also searchable as a phrase in "Given Family" order.
    segs = str(item.author).split(';');
    parts = [];
    for (i = 0; i < segs.length; i++) {
      seg = segs[i];
      keys = keysOf(norm(seg));
      if (!keys.length) { continue; }
      put(post, keys, id, 1);
      parts.push(keys.join(' '));
      j = seg.search(/[,\u060c]/);   // ASCII or Arabic comma
      if (j > 0) {
        ns = joinKeys(seg.slice(j + 1) + ' ' + seg.slice(0, j));
        if (ns && ns !== keys.join(' ')) { parts.push(ns); }
      }
    }
    doc.J[1] = jn(parts);

    tags = tagList(item.tags); parts = [];
    for (i = 0; i < tags.length; i++) {
      keys = keysOf(norm(tags[i]));
      if (!keys.length) { continue; }
      put(post, keys, id, 2);
      tg = keys.join(' ');
      parts.push(tg);
      doc.tagKeys.push(tg);
    }
    doc.J[2] = jn(parts);

    keys = keysOf(norm(str(item.text)));
    put(post, keys, id, 3);
    doc.J[3] = keys.length ? ' ' + keys.join(' ') + ' ' : '';

    keys = keysOf(norm(str(item.quote)));
    put(post, keys, id, 4);
    doc.J[4] = keys.length ? ' ' + keys.join(' ') + ' ' : '';

    tg = joinKeys(str(item.project));
    doc.projKey = tg ? ' ' + tg + ' ' : '';
    return doc;
  }

  // weights per document for one word (exact key, or a prefix with its alternatives)
  function scoreToken(ix, alts, prefix) {
    var N = ix.N, out = new Float64Array(N), any = false, post = ix.post, keys = ix.keys, ai, a, lo, k, p, i, c, id, v, tbl;
    if (!prefix) {
      p = post[alts[0]];
      if (!p) { return null; }
      for (i = 0; i < p.length; i++) {
        c = p[i]; id = c >>> 5; v = BW[c & 31];
        if (v > out[id]) { out[id] = v; }
      }
      return out;
    }
    for (ai = 0; ai < alts.length; ai++) {
      a = alts[ai];
      for (lo = lowerBound(keys, a); lo < keys.length; lo++) {
        k = keys[lo];
        if (k.indexOf(a) !== 0) { break; }
        tbl = alts.indexOf(k) >= 0 ? BW : BWP;
        p = post[k];
        for (i = 0; i < p.length; i++) {
          c = p[i]; id = c >>> 5; v = tbl[c & 31];
          if (v > out[id]) { out[id] = v; }
          any = true;
        }
      }
    }
    return any ? out : null;
  }

  // Float64Array of scores (0 = no match), or null when nothing matches at all
  function evalUnit(ix, u) {
    var N = ix.N, j, arrs, last, pre, ex, pr, i, id, J, f, h, best, v, q, e, out, any = false, ok, ai;
    if (u.n === 1) { return scoreToken(ix, u.alts, u.prefix); }
    arrs = [];
    for (j = 0; j < u.n - 1; j++) {
      last = scoreToken(ix, [u.keys[j]], false);
      if (!last) { return null; }
      arrs.push(last);
    }
    last = scoreToken(ix, u.alts, u.prefix);
    if (!last) { return null; }
    arrs.push(last);
    pre = u.keys.length ? u.keys.join(' ') + ' ' : '';
    ex = []; pr = [];
    for (ai = 0; ai < u.alts.length; ai++) {
      ex.push(' ' + pre + u.alts[ai] + ' ');
      pr.push(' ' + pre + u.alts[ai]);
    }
    out = new Float64Array(N);
    for (id = 0; id < N; id++) {
      ok = true;
      for (j = 0; j < arrs.length; j++) { if (arrs[j][id] === 0) { ok = false; break; } }
      if (!ok) { continue; }
      J = ix.docs[id].J; best = 0;
      for (f = 0; f < 5; f++) {
        h = J[f];
        if (!h) { continue; }
        q = 0;
        for (i = 0; i < ex.length; i++) { if (h.indexOf(ex[i]) >= 0) { q = 2; break; } }
        if (!q && u.prefix) { for (i = 0; i < pr.length; i++) { if (h.indexOf(pr[i]) >= 0) { q = 1; break; } } }
        if (q) { v = q === 2 ? W_EXACT[f] : WP_FIELD[f]; if (v > best) { best = v; } }
      }
      if (best > 0) { out[id] = best; any = true; }
    }
    return any ? out : null;
  }

  function resolveOptKinds(k) {
    var set = {}, i, r, key, any = false;
    if (k === null || k === undefined) { return null; }
    if (typeof k === 'string') { k = [k]; }
    if (!Array.isArray(k) || !k.length) { return null; }
    for (i = 0; i < k.length; i++) {
      r = resolveKinds(str(k[i])); any = true;
      var got = false;
      for (key in r) { if (r[key]) { set[key] = true; got = true; } }
      if (!got) { set[norm(str(k[i]))] = true; }
    }
    return any ? set : null;
  }
  function resolveOptProjects(p) {
    var out = [], i, v;
    if (p === null || p === undefined || p === '') { return null; }
    if (!Array.isArray(p)) { p = [p]; }
    for (i = 0; i < p.length; i++) { v = joinKeys(str(p[i])); if (v) { out.push(' ' + v + ' '); } }
    return out.length ? out : null;
  }

  function passes(doc, F, optKinds, optProjects) {
    var i, f, okAny, hasPos;
    if (optKinds && !optKinds[doc.kind]) { return false; }
    if (optProjects && optProjects.indexOf(doc.projKey) < 0) { return false; }
    hasPos = false; okAny = false;
    for (i = 0; i < F.kinds.length; i++) {
      f = F.kinds[i];
      if (f.neg) { if (f.set[doc.kind]) { return false; } }
      else { hasPos = true; if (f.set[doc.kind]) { okAny = true; } }
    }
    if (hasPos && !okAny) { return false; }
    hasPos = false; okAny = false;
    for (i = 0; i < F.projects.length; i++) {
      f = F.projects[i];
      var inside = doc.projKey.indexOf(' ' + f.v + ' ') >= 0;
      if (f.neg) { if (inside) { return false; } }
      else { hasPos = true; if (inside) { okAny = true; } }
    }
    if (hasPos && !okAny) { return false; }
    for (i = 0; i < F.tags.length; i++) {
      f = F.tags[i];
      var has = doc.tagKeys.indexOf(f.v) >= 0;
      if (f.neg ? has : !has) { return false; }
    }
    return true;
  }

  function makeHit(doc, score, units) {
    var hit = { item: doc.item, score: score, snippet: '' }, memo = null;
    Object.defineProperty(hit, 'snippet', {   // computed on first read: a big result list stays cheap
      enumerable: true, configurable: true,
      get: function () { if (memo === null) { memo = hitSnippet(doc.item, units); } return memo; },
      set: function (v) { memo = v; }
    });
    return hit;
  }
  function hitSnippet(item, units) {
    var hl = norm(str(item.kind)) === 'highlight';
    var a = str(hl ? item.quote : item.text), b = str(hl ? item.text : item.quote), r;
    if (units.length) {
      if (a) { r = snipCore(a, units, DEFAULT_WIDTH); if (r.hit) { return r.text; } }
      if (b) { r = snipCore(b, units, DEFAULT_WIDTH); if (r.hit) { return r.text; } }
    }
    return snipCore(a || b, [], DEFAULT_WIDTH).text;
  }

  function runQuery(ix, q, opts) {
    opts = opts || {};
    var P = parseInternal(q), N = ix.N, docs = ix.docs, F = P.F, i, j, v, s, ok, a, excl = null;
    var optKinds = resolveOptKinds(opts.kinds), optProjects = resolveOptProjects(opts.project);
    var hasFilter = !!(F.tags.length || F.projects.length || F.kinds.length || P.neg.length || optKinds || optProjects);
    if (!N || (!P.pos.length && !hasFilter)) { return []; }
    var arrs = [];
    for (j = 0; j < P.pos.length; j++) {
      a = evalUnit(ix, P.pos[j]);
      if (!a) { return []; }
      arrs.push(a);
    }
    if (P.neg.length) {
      excl = new Uint8Array(N);
      for (j = 0; j < P.neg.length; j++) {
        a = evalUnit(ix, P.neg[j]);
        if (a) { for (i = 0; i < N; i++) { if (a[i] > 0) { excl[i] = 1; } } }
      }
    }
    var ids = [], sc = new Float64Array(N);
    for (i = 0; i < N; i++) {
      s = 0; ok = true;
      for (j = 0; j < arrs.length; j++) {
        v = arrs[j][i];
        if (v === 0) { ok = false; break; }
        s += v;
      }
      if (!ok || (excl && excl[i])) { continue; }
      if (!passes(docs[i], F, optKinds, optProjects)) { continue; }
      sc[i] = s; ids.push(i);
    }
    ids.sort(function (x, y) {
      return (sc[y] - sc[x]) || (docs[y].ts - docs[x].ts) || (x - y);
    });
    var limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : ids.length;
    if (ids.length > limit) { ids.length = limit; }
    var out = new Array(ids.length);
    for (i = 0; i < ids.length; i++) { out[i] = makeHit(docs[ids[i]], sc[ids[i]], P.pos); }
    return out;
  }

  function build(items) {
    var list = Array.isArray(items) ? items : [], docs = [], post = Object.create(null), i, it;
    for (i = 0; i < list.length; i++) {
      it = list[i];
      if (!it || typeof it !== 'object') { continue; }
      docs.push(addDoc(it, docs.length, post));
    }
    var ix = { N: docs.length, docs: docs, post: post, keys: Object.keys(post).sort() };
    return {
      size: ix.N,
      query: function (q, opts) { return runQuery(ix, q, opts); },
      terms: function (q) { return parseInternal(q).terms; }
    };
  }

  var search = {
    norm: norm,
    build: build,
    snippet: snippet,
    highlightHTML: highlightHTML,
    parse: parse,
    terms: function (q) { return parseInternal(q).terms; },
    tokens: function (s) { return rawTokens(norm(s)); }
  };
  root.Lib.search = search;
  if (typeof module !== 'undefined' && module.exports) { module.exports = root.Lib.search; }
})();
