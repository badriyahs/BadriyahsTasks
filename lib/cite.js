/* Lib.cite: the citation engine for the library (pure: runs in the browser and in node).
   - parseAuthors(str)            [{family, given, literal}]
   - format(src, style, opts)     {text, html}      style: 'apa' (APA 7) | 'chicago' (Chicago 17 author-date) | 'mla' (MLA 9) | 'bibtex'
   - inText(src, style, page[, opts]) "(Miller, 2017, p. 12)"
   - bibliography(srcs, style[, letters])  {text, html, entries}  sorted, a/b year suffixes, one entry per paragraph
   - bibtex(src, usedKeys) / bibtexAll(srcs)
   - normDOI(str), fromCrossref(json), lookup(input, fetchImpl)
   Extra helpers: pageRange(raw, style), sentenceCase(t), titleCase(t, style), inTextHTML(src, style, page), styles.
   Rules: APA 7 (up to 20 authors, DOI as https://doi.org/..., no place of publication), Chicago 17 author-date
   (up to 10 authors, 7 + et al. beyond that, place: publisher, abbreviated page ranges, 3 authors in text, 4+ et al.),
   MLA 9 (1, 2 or first author + et al., core elements, no "n.d."). Only src.pageRange is ever printed as pages:
   the old source field `pages` is a page COUNT and is ignored. */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window :
             typeof globalThis !== 'undefined' ? globalThis :
             typeof global !== 'undefined' ? global : {};
  root.Lib = root.Lib || {};

  /* ------------------------------------------------------------------
     0. Small helpers. Italics are carried inside strings as two control
        characters (IT0 / IT1) and turned into <i> only at the very end.
     ------------------------------------------------------------------ */
  var IT0 = '\u0001', IT1 = '\u0002';
  var ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

  function str(v) {
    if (v === null || v === undefined || typeof v === 'object' || typeof v === 'function' || typeof v === 'boolean' || typeof v === 'symbol') return '';
    if (typeof v === 'number' && !isFinite(v)) return '';
    return String(v).replace(/[\u0001\u0002]/g, '').replace(/\s+/g, ' ').trim();
  }
  function ital(s) { return s ? IT0 + s + IT1 : ''; }
  function plain(s) { return String(s).replace(/[\u0001\u0002]/g, ''); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toHTML(s) { return esc(s).replace(/\u0001/g, '<i>').replace(/\u0002/g, '</i>'); }
  function squeeze(s) { return String(s).replace(/[ \t]+/g, ' ').replace(/\s+$/, '').replace(/^\s+/, ''); }
  function join(parts, sep) {
    var out = [];
    for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
    return out.join(sep === undefined ? ' ' : sep);
  }
  // add a full stop unless the text already ends with . ? ! (optionally before a closing quote)
  function endDot(s) {
    if (!s) return '';
    var p = plain(s).replace(/\s+$/, '');
    if (!p) return s;
    if (/[.?!][\u201D"\u2019']*$/.test(p)) return s;
    // a title that ends in a closing quotation mark: the full stop goes inside it (American style, as APA 7 prints 'Dr. House.')
    var q = p.match(/[\u201D\u2019"]+$/);
    if (q && s === p) {
      var body = p.slice(0, p.length - q[0].length), last = q[0].charAt(0);
      var paired = (last === '\u201D' && body.indexOf('\u201C') >= 0) ||
                   (last === '\u2019' && body.indexOf('\u2018') >= 0) ||
                   (last === '"' && (body.split('"').length - 1) % 2 === 1);
      if (paired) return body + '.' + q[0];
    }
    return s + '.';
  }
  // a title in double quotes; quotation marks inside the title become single ones (Chicago 17, MLA 9)
  function quoted(t) {
    if (!t) return '';
    t = t.replace(/\u201C/g, '\u2018').replace(/\u201D/g, '\u2019').replace(/"([^"]*)"/g, '\u2018$1\u2019');
    return '\u201C' + endDot(t) + '\u201D';
  }
  function lc(s) { return String(s).toLowerCase(); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }   // plain-object lookups must not see __proto__ / constructor
  function arr(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }

  // lower-case, accent-free, apostrophe-free: for sorting and for bibtex keys
  function deburr(s) {
    s = lc(str(s));
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
    return s.replace(/[\u02BB-\u02BF'\u2019\u2018`\u00B4]/g, '')
            .replace(/\u00DF/g, 'ss').replace(/\u00E6/g, 'ae').replace(/\u0153/g, 'oe')
            .replace(/[\u00F8]/g, 'o').replace(/\u0142/g, 'l').replace(/\u0111/g, 'd').replace(/\u0131/g, 'i');
  }
  function sortFold(s) {
    s = deburr(s).replace(/^(?:al|el)[-\s]+/, '');
    return s.replace(/[^a-z0-9\u0600-\u06FF]+/g, ' ').replace(/^\s+|\s+$/g, '');
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  /* ------------------------------------------------------------------
     1. DOI
     ------------------------------------------------------------------ */
  function normDOI(input) {
    var s = str(input);
    if (!s) return '';
    try { if (/%2F/i.test(s)) s = decodeURIComponent(s); } catch (e) { /* keep as typed */ }
    var isUrl = /^[a-z][a-z0-9+.\-]*:\/\//i.test(s) || /^(?:www\.)?(?:dx\.)?doi\.org\//i.test(s);
    var isDoiHost = /(?:^|\/\/|^www\.)(?:dx\.)?doi\.org\//i.test(s);
    // DOIs may legally contain < and > (old SICI-style ones such as 10.1175/1520-0477(1996)077<0437:TNYRP>2.0.CO;2);
    // an html tag after the DOI (</a>, <br>) is cut off, a lone closing > is dropped below.
    var m = s.match(/10\.\d{4,9}\/[^\s"]+/);
    if (!m) return '';
    var d = m[0].replace(/<\/?[A-Za-z][^>]*>?.*$/, '');
    if (isUrl && !isDoiHost) d = d.replace(/[?#].*$/, '');
    var guard = 0;
    while (d && guard++ < 20) {
      var last = d.charAt(d.length - 1);
      if (/[.,;:!?'"\u2019\u201D]/.test(last)) { d = d.slice(0, -1); continue; }
      if (last === '>' && (d.split('<').length < d.split('>').length)) { d = d.slice(0, -1); continue; }
      if (last === '<') { d = d.slice(0, -1); continue; }
      if (last === ')' && (d.split('(').length < d.split(')').length)) { d = d.slice(0, -1); continue; }
      if (last === ']' && (d.split('[').length < d.split(']').length)) { d = d.slice(0, -1); continue; }
      if (last === '}' && (d.split('{').length < d.split('}').length)) { d = d.slice(0, -1); continue; }
      break;
    }
    return /^10\.\d{4,9}\/.+/.test(d) ? d : '';
  }

  /* ------------------------------------------------------------------
     2. Names
     ------------------------------------------------------------------ */
  var PARTICLE_ANY = { ibn: 1, bin: 1, bint: 1, al: 1, el: 1 };
  var PARTICLE_LOWER = { ben: 1, van: 1, von: 1, der: 1, den: 1, de: 1, del: 1, della: 1, di: 1, da: 1, dos: 1, du: 1, la: 1, le: 1, ter: 1, ten: 1, zur: 1, zum: 1 };
  function isParticle(tok) {
    if (own(PARTICLE_ANY, lc(tok))) return true;
    return tok === lc(tok) && own(PARTICLE_LOWER, tok);
  }
  var COMPOUND_HEAD = /^(?:ab[u\u016B]|ibn|bin|bint|ban[u\u016B]|dh[u\u016B]|umm|ab\u012B)$/i;
  var ORG_RE = /\b(?:univers\w*|institut\w*|societ\w*|association|organi[sz]ation|committee|council|department|ministry|press|agency|bureau|commission|foundation|cent(?:er|re)|museum|librar\w*|academy|acad[e\u00E9]mie|group|compan\w*|corporation|corp|inc|ltd|llc|union|league|government|authority|network|initiative|laborator\w*|observator\w*|college|school|faculty|consortium|royal|national|international|federation|alliance|assembly|congress|parliament|publishing|publications|archives?)\b/i;
  var SUFFIX_RE = /^(?:jr\.?|sr\.?|ii|iii|iv)$/i;
  // more words that mark a no-comma name as an organisation ("United Nations", "World Bank", "BBC News"); only used for names typed
  // without a comma, because "Family, Given" with a comma is a strong sign of a person.
  var ORG_EXTRA = /\b(?:nations|united|world|worldwide|global|european|bank|fund|board|office|services?|trust|states?|city|county|public|health|news|media|times|magazine|studios?|labs?|project|programme|program|team|research|forum|coalition|partnership|survey|census|dept|agency|club|centre|ministry)\b/i;
  function looksLikeOrg(p, tokens) {
    if (ORG_RE.test(p) || ORG_EXTRA.test(p)) return true;
    if (/^the\s/i.test(p)) return true;
    for (var i = 0; i < tokens.length; i++) if (/^[A-Z]{3,}$/.test(tokens[i]) && !SUFFIX_RE.test(tokens[i])) return true;   // BBC, NASA, UNESCO
    return false;
  }

  function normSuffix(s) {
    var l = lc(s).replace(/\.$/, '');
    if (l === 'jr') return 'Jr.';
    if (l === 'sr') return 'Sr.';
    return s.toUpperCase();
  }
  // "Martin Luther, Jr." -> {given:'Martin Luther', suffix:'Jr.'}
  function splitGivenSuffix(given) {
    var m = str(given).match(/^(.*?)[,\s]+(jr\.?|sr\.?|ii|iii|iv)\s*$/i);
    if (m && m[1].replace(/[,\s]/g, '')) return { given: m[1].replace(/[,\s]+$/, ''), suffix: normSuffix(m[2]) };
    return { given: str(given), suffix: '' };
  }

  function person(family, given) { return { family: family, given: given, literal: '' }; }
  function literal(s) { return { family: '', given: '', literal: s }; }

  // One person typed either as "Family, Given" or "Given Family" (or an organisation / single name).
  function parsePart(p) {
    p = str(p).replace(/[\u201C\u201D"]/g, '').replace(/^[\s,]+|[\s,]+$/g, '').replace(/\s+/g, ' ');
    if (!p) return null;
    var c = p.indexOf(',');
    if (c >= 0) {
      var fam = str(p.slice(0, c)), giv = str(p.slice(c + 1)).replace(/^[\s,]+|[\s,]+$/g, '');
      if (!fam) return giv ? literal(giv) : null;
      var fx = fam.match(/^(.+?)\s+(jr\.?|sr\.?|ii|iii|iv)$/i);
      if (fx && giv && !SUFFIX_RE.test(giv)) { fam = fx[1]; giv += ', ' + normSuffix(fx[2]); }
      // "Martin Luther King, Jr.": the part before the comma is a whole "Given Family" name and the part after it is only a suffix
      if (giv && SUFFIX_RE.test(giv) && fam.indexOf(' ') >= 0 && !ORG_RE.test(fam)) return parsePart(fam + ' ' + giv);
      if (ORG_RE.test(fam) && !SUFFIX_RE.test(giv)) return literal(p);
      return person(fam, giv);
    }
    if (ARABIC_RE.test(p)) return literal(p);
    var t = p.split(' ');
    if (t.length === 1) return literal(p);
    if (/\d/.test(p) || looksLikeOrg(p, t) || t.length > 5 || (t.length > 2 && /\s(?:of|for|the)\s/i.test(p))) return literal(p);
    // trailing Jr. / III
    var suffix = '';
    if (t.length > 2 && SUFFIX_RE.test(t[t.length - 1])) suffix = normSuffix(t.pop());
    var out;
    var firstKey = deburr(t[0]).replace(/[^a-z]/g, '');
    if (t.length <= 3 && COMPOUND_HEAD.test(firstKey)) {
      out = person(t.join(' '), '');   // Ibn Khald\u016Bn, Ab\u016B Ma\u02BFshar, Dh\u016B al-Rumma: a single compound name
    } else {
      var i = t.length - 1;
      while (i > 0 && isParticle(t[i - 1])) i--;
      if (i === 0) out = person(t.join(' '), '');
      else out = person(t.slice(i).join(' '), t.slice(0, i).join(' '));
    }
    if (suffix) out.given = out.given ? out.given + ', ' + suffix : suffix;
    return out;
  }

  function cleanPerson(o) { return { family: str(o.family), given: str(o.given), literal: str(o.literal || o.name) }; }

  // "Smith, J., Jones, M., & Lee, B." (the way an APA author list reads, no semicolons): every second piece is only initials
  var INITIALS_ONLY = /^[\u02BB-\u02BF]?[A-Z]\.?(?:[\s\-]?[\u02BB-\u02BF]?[A-Z]\.?)*$/;
  function initialsPairs(s) {
    var chunks = s.replace(/,?\s+(?:and|&)\s+/gi, ', ').split(/\s*,\s*/).filter(Boolean);
    if (chunks.length < 4 || chunks.length % 2) return null;
    var out = [];
    for (var i = 0; i < chunks.length; i += 2) {
      if (INITIALS_ONLY.test(chunks[i]) || !INITIALS_ONLY.test(chunks[i + 1])) return null;
      out.push(chunks[i] + ', ' + chunks[i + 1]);
    }
    return out;
  }
  // -> {list, etAl}
  function parseListEx(input) {
    var out = { list: [], etAl: false };
    try {
      if (Array.isArray(input)) {
        input.forEach(function (x) {
          if (x && typeof x === 'object') {
            var p = cleanPerson(x);
            if (p.family || p.given || p.literal) out.list.push(p);
          } else {
            var q = parsePart(str(x));
            if (q) out.list.push(q);
          }
        });
        return out;
      }
      if (typeof input !== 'string') return out;   // numbers, booleans, objects: not a list of names
      var s = String(input).replace(/\u060C/g, ',').replace(/\u061B/g, ';').replace(/\r?\n+/g, ';').replace(/[\u0001\u0002]/g, '');
      s = s.replace(/\s+/g, ' ').trim();
      var tail = /(?:^|[,;]\s*|\s)(?:et\.?\s*al\.?|and\s+others)\s*$/i;
      if (tail.test(s)) { out.etAl = true; s = s.replace(tail, '').replace(/[\s,;]+$/, ''); }
      if (!s) return out;
      var push = function (p) { var q = parsePart(p); if (q) out.list.push(q); };
      var pairs = null;
      if (s.indexOf(';') >= 0) {
        s.split(';').forEach(function (part) { push(part.replace(/^\s*(?:and|&)\s+/i, '')); });   // "...; and Lee, Bob"
      } else if (ORG_RE.test(s) && s.indexOf(',') < 0) {
        push(s);
      } else if ((pairs = initialsPairs(s))) {
        pairs.forEach(push);
      } else {
        var oxford = /,\s*(?:and|&)\s+/i.test(s);
        var parts = s.split(/\s*,?\s+(?:and|&)\s+/i);
        parts.forEach(function (part, idx) {
          if (oxford && idx < parts.length - 1 && part.indexOf(',') >= 0) {
            var chunks = part.split(/\s*,\s*/).filter(Boolean);
            var multi = chunks.length > 1 && chunks.every(function (ch) {
              var w = ch.split(' ').filter(function (x) { return x && !SUFFIX_RE.test(x); });
              return w.length >= 2;
            });
            if (multi) { chunks.forEach(push); return; }
          }
          push(part);
        });
      }
    } catch (e) { /* never throw */ }
    return out;
  }
  function parseAuthors(input) {
    try {
      // "(eds.)", "(ed. Name)" and "(trans. Name)" are roles, not part of a name
      if (typeof input === 'string') input = splitRoles(input).text;
      return parseListEx(input).list;
    } catch (e) { return []; }
  }

  // ---- given names to initials: "F. Jamil" -> "F. J.", "Jean-Paul" -> "J.-P.", "(ayn)Ali" -> "(ayn)A."
  function initialOfPart(p) {
    var m = p.match(/^[\u2018\u2019'`\u02BB\u02BC\u02BD\u02BE]*(\u02BF)?[\u2018\u2019'`\u02BB\u02BC\u02BD\u02BE]*(.)/);
    if (!m) return '';
    return (m[1] ? '\u02BF' : '') + m[2].toUpperCase();
  }
  function initialsOf(given) {
    var g = splitGivenSuffix(given).given;
    var out = [];
    g.split(/\s+/).forEach(function (tok) {
      if (!tok) return;
      if (isParticle(tok) && tok === lc(tok)) return;
      if (/^(?:[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]\.)+$/.test(tok)) {          // F. or F.J.
        tok.replace(/\./g, '').split('').forEach(function (ch) { out.push(ch.toUpperCase() + '.'); });
        return;
      }
      if (/^[A-Z]{2,3}\.?$/.test(tok)) {                                       // FJ
        tok.replace(/\./g, '').split('').forEach(function (ch) { out.push(ch + '.'); });
        return;
      }
      var parts = tok.replace(/\.$/, '').split('-').filter(Boolean);
      var ini = [];
      parts.forEach(function (pt, k) {
        if (parts.length > 1 && k === 0 && /^(?:al|el)$/i.test(pt)) return;     // al-Rahman -> R. (but the names Al and El, and the initials A. L., stay)
        var i = initialOfPart(pt);
        if (i) ini.push(i);
      });
      if (ini.length) out.push(ini.join('.-') + '.');
    });
    return out.join(' ');
  }

  function famOf(p) { return p.literal || p.family || p.given || ''; }
  function apaName(p) {
    if (p.literal) return p.literal;
    if (!p.given) return p.family;
    var sp = splitGivenSuffix(p.given), ini = initialsOf(p.given);
    return p.family + (ini ? ', ' + ini : '') + (sp.suffix ? ', ' + sp.suffix : '');
  }
  function apaDirName(p) {   // initials first: "M. L. King Jr."
    if (p.literal) return p.literal;
    var sp = splitGivenSuffix(p.given), ini = initialsOf(p.given);
    return join([ini, p.family, sp.suffix], ' ');
  }
  function invName(p) {      // "Family, Given"
    if (p.literal) return p.literal;
    if (!p.given) return p.family;
    var sp = splitGivenSuffix(p.given);
    return p.family + (sp.given ? ', ' + sp.given : '') + (sp.suffix ? ', ' + sp.suffix : '');
  }
  function dirName(p) {      // "Given Family"
    if (p.literal) return p.literal;
    var sp = splitGivenSuffix(p.given);
    return join([sp.given, p.family, sp.suffix], ' ');
  }

  function apaList(list, etAl) {
    var n = list.map(apaName);
    if (!n.length) return '';
    if (etAl) return n.join(', ') + ', et al.';
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[0] + ', & ' + n[1];
    if (n.length <= 20) return n.slice(0, -1).join(', ') + ', & ' + n[n.length - 1];
    return n.slice(0, 19).join(', ') + ', . . . ' + n[n.length - 1];
  }
  function apaEditors(list) {
    var n = list.map(apaDirName);
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[0] + ' & ' + n[1];
    return n.slice(0, -1).join(', ') + ', & ' + n[n.length - 1];
  }
  function chiList(list, etAl, inverted) {
    var n = list.map(function (p, i) { return i === 0 && inverted ? invName(p) : dirName(p); });
    if (n.length > 10) { n = n.slice(0, 7); etAl = true; }
    if (!n.length) return '';
    if (etAl) return n.join(', ') + ', et al.';
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[0] + (inverted && n[0].indexOf(',') >= 0 ? ', and ' : ' and ') + n[1];
    return n.slice(0, -1).join(', ') + ', and ' + n[n.length - 1];
  }
  function mlaList(list, etAl, inverted) {
    var n = list.map(function (p, i) { return i === 0 && inverted ? invName(p) : dirName(p); });
    if (!n.length) return '';
    if (etAl || n.length >= 3) return n[0] + (inverted ? ', et al.' : ' et al.');
    if (n.length === 1) return n[0];
    return n[0] + (inverted && n[0].indexOf(',') >= 0 ? ', and ' : ' and ') + n[1];
  }

  /* ------------------------------------------------------------------
     3. Titles: sentence case (opt-in) and title case (short titles in text)
     ------------------------------------------------------------------ */
  var PROPER = {};
  ('islamic arabic persian greek latin hebrew syriac turkish ottoman byzantine indian chinese european african asian american ' +
   'british english french german spanish italian andalusi andalusian abbasid umayyad fatimid mamluk safavid timurid ilkhanid ' +
   'maragha maragha\u02BCa baghdad cairo damascus samarkand istanbul constantinople mecca medina makkah kuwait kuwaiti saudi arabia ' +
   'quran qur\u2019an qur\'an muslim muslims christian jewish mediterranean atlantic europe asia africa america ptolemy ptolemaic ' +
   'copernicus euclid aristotle plato galen newton einstein harvard god january february march april may june july august ' +
   'september october november december monday tuesday wednesday thursday friday saturday sunday ' +
   'mars venus jupiter saturn mercury uranus neptune pluto islam arab arabs iran iraq egypt syria turkey persia india china spain andalusia ' +
   'oxford cambridge london paris berlin vienna rome athens alexandria kepler galileo copernican keplerian newtonian euclidean gaussian ' +
   'wikipedia google').split(' ').forEach(function (w) { PROPER[w] = 1; });
  var TRANSLIT_RE = /[\u02BB-\u02BF\u0100\u0101\u012A\u012B\u016A\u016B\u1E24\u1E25\u1E62\u1E63\u1E0C\u1E0D\u1E6C\u1E6D\u1E92\u1E93\u1E2A\u1E2B\u0160\u0161\u01E6\u01E7\u0120\u0121]/;
  var MINOR_APA = ' a an the and but or nor for so yet as at by in of on to up via per off out ';
  var MINOR_FULL = MINOR_APA + 'from with into onto upon over under between among through during after before about against within without toward towards across along around beyond near ';

  function splitWord(w) {
    var m = w.match(/^([^A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF\u02BB-\u02BF\u0600-\u06FF]*)(.*?)([^A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF\u02BB-\u02BF\u0600-\u06FF]*)$/);
    return { pre: m[1], core: m[2], post: m[3] };
  }
  function isSpecialWord(core) {
    if (!core) return true;
    if (/\d/.test(core)) return true;
    if (/[a-z\u00DF-\u00FF][A-Z]/.test(core)) return true;                     // iPhone, McDonald
    if (core.length >= 2 && core === core.toUpperCase() && /[A-Z]/.test(core)) return true;   // NASA
    if (TRANSLIT_RE.test(core)) return true;                                   // Arabic names in transliteration
    if (/^(?:al|el)-/.test(core)) return true;                                 // al-Qushji
    if (ARABIC_RE.test(core)) return true;
    return false;
  }
  function sentenceCase(t) {
    t = str(t);
    if (!t) return t;
    var words = t.split(' '), big = 0, cap = 0;
    words.forEach(function (w) {
      var c = splitWord(w).core;
      if (!c || MINOR_APA.indexOf(' ' + lc(c) + ' ') >= 0) return;
      big++;
      if (/^[A-Z\u00C0-\u00DE]/.test(c)) cap++;
    });
    if (big < 2 || cap / big < 0.6) return t;      // looks like sentence case already
    var out = [], prev = '';
    words.forEach(function (w, i) {
      var sw = splitWord(w), start = (i === 0 || /[:?!.\u2014\u2013]$/.test(prev));
      if (/^(?:al|el)-/i.test(sw.core)) {   // al-Tusi, al-Manazir: the capital after the hyphen is part of the name; the particle itself is lower-case mid-sentence
        out.push(sw.pre + (start ? sw.core.slice(0, 3) : sw.core.slice(0, 3).toLowerCase()) + sw.core.slice(3) + sw.post);
        prev = w;
        return;
      }
      var parts = sw.core.split('-');
      var done = parts.map(function (pt, k) {
        if (!pt) return pt;
        var first = (k === 0 && start);
        if (first) return pt;
        if (pt === 'I' || /^I[\u2019'](?:m|ll|d|ve)$/.test(pt)) return pt;     // the pronoun
        if (isSpecialWord(pt) || own(PROPER, lc(pt).replace(/[\u2019']s$/, ''))) return pt;
        return lc(pt);
      });
      out.push(sw.pre + done.join('-') + sw.post);
      prev = w;
    });
    return out.join(' ');
  }
  function titleCase(t, style) {
    t = str(t);
    if (!t) return t;
    var minor = style === 'apa' ? MINOR_APA : MINOR_FULL;
    var words = t.split(' '), prev = '';
    var out = words.map(function (w, i) {
      var sw = splitWord(w), core = sw.core;
      if (!core) { prev = w; return w; }
      var start = (i === 0 || i === words.length - 1 || /[:?!.\u2014\u2013]$/.test(prev));
      var res;
      if (isSpecialWord(core) && !/^[a-z]+$/.test(core)) res = core;
      else if (/^(?:al|el)-/.test(core)) res = core;
      else if (!start && minor.indexOf(' ' + lc(core) + ' ') >= 0) res = lc(core);
      else res = core.split('-').map(function (pt) {
        if (/^(?:al|el|ibn|bin)$/.test(pt)) return pt;
        return pt.charAt(0).toUpperCase() + pt.slice(1);
      }).join('-');
      prev = w;
      return sw.pre + res + sw.post;
    });
    return out.join(' ');
  }
  function shortTitle(t, style) {
    t = str(t).split(/:\s/)[0].replace(/[.,;:\s]+$/, '');
    var w = t.split(' ');
    if (w.length > 6) {
      w = w.slice(0, 4);
      while (w.length > 1 && MINOR_FULL.indexOf(' ' + lc(w[w.length - 1]) + ' ') >= 0) w.pop();   // never end on "of" or "the"
      t = w.join(' ').replace(/[,;:\s]+$/, '');
    }
    return titleCase(t, style);
  }

  /* ------------------------------------------------------------------
     4. Pages, years, editions
     ------------------------------------------------------------------ */
  // "p. 12", "pp. 12-14", "p 12", "pages 12-14", "p12" lose their label (the style adds its own); "para. 4" and "pt. 2" are left alone
  function stripPageLabel(s) { return s.replace(/^(?:pp?\.\s*|pp?\s+|pages?\.?\s+|pgs?\.?\s+|pp?(?=\d))/i, ''); }
  function pagesInfo(raw) {
    var s = stripPageLabel(str(raw)).replace(/\s*(?:[\u2010-\u2015\u2212]|--+)\s*/g, '-').trim();
    if (!s) return { kind: '', text: '' };
    var m = s.match(/^([^\s,\-]+)-([^\s,\-]+)$/);
    if (m) return { kind: 'range', a: m[1], b: m[2], text: s };
    if (/^[A-Za-z]+\d[\w.]*$/.test(s)) return { kind: 'locator', text: s };
    return { kind: s.indexOf(',') >= 0 || s.indexOf('-') >= 0 ? 'list' : 'single', text: s.replace(/-/g, '\u2013').replace(/\s*,\s*/g, ', ') };
  }
  function firstDiff(a, b) {
    var i = 0;
    while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i++;
    return i;
  }
  // second number of a range, shortened the Chicago (or MLA) way
  function shortenEnd(a, b, style) {
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return b;
    if (b.length < a.length) b = a.slice(0, a.length - b.length) + b;       // already abbreviated: expand first
    if (b.length !== a.length || +b <= +a) return b;
    if (style === 'apa') return b;
    if (+a < 100) return b;
    var d = firstDiff(a, b);
    if (style === 'mla') return b.slice(Math.min(d, b.length - 2));
    if (+a % 100 === 0 || +b % 100 === 0) return b;       // 1496-1500 stays whole
    if (+a % 100 < 10) return b.slice(d);
    return b.slice(Math.min(d, b.length - 2));
  }
  function pageRange(raw, style, opts) {
    var p = pagesInfo(raw);
    if (p.kind !== 'range') return p.text;
    var dash = style === 'mla' ? '-' : '\u2013';
    if (opts && opts.dash) dash = opts.dash;
    return p.a + dash + shortenEnd(p.a, p.b, style);
  }
  function pagePrefix(p) { return (p.kind === 'range' || p.kind === 'list') ? 'pp. ' : 'p. '; }

  function yearInfo(v, suffixOpt) {
    var s = str(typeof v === 'number' ? String(v) : v);
    var r = { y: '', suffix: '', nd: false, special: '', era: '', circa: false };
    if (!s || /^(?:n\.?\s*d\.?|no date|undated|s\.?\s*d\.?)$/i.test(s)) { r.nd = true; r.suffix = suffixOpt || ''; return r; }
    if (/in press|forthcoming|accepted|to appear/i.test(s)) { r.special = 'forthcoming'; r.suffix = suffixOpt || ''; return r; }
    r.circa = /^\s*(?:c\.|ca\.?|circa)\s*\d/i.test(s);
    // an era after the number is kept (300 BCE, 1450 AH): a Hijri or BCE year printed as a bare number would read as a Gregorian year
    var em = s.match(/(\d{1,4})\s*(B\.?\s?C\.?(?:\s?E\.?)?|A\.?\s?D\.?|C\.?\s?E\.?|A\.?\s?H\.?)(?![A-Za-z])/i);
    if (em) {
      r.y = em[1]; r.era = em[2].replace(/[.\s]/g, '').toUpperCase(); r.suffix = suffixOpt || '';
      return r;
    }
    var m = s.match(/(^|[^\d])(\d{3,4})(?!\d)([a-z])?(?![A-Za-z])/);
    if (m) {
      r.y = m[2];
      r.suffix = m[3] ? lc(m[3]) : (suffixOpt || '');
      return r;
    }
    r.nd = true; r.suffix = suffixOpt || '';
    return r;
  }
  function yearText(y) { return (y.circa ? 'ca. ' : '') + y.y + (y.era ? ' ' + y.era : ''); }
  var ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  function normEdition(raw, style) {
    var s = str(raw).replace(/\s*\b(?:edition|ed\.?)\s*$/i, '').trim();
    if (!s) return '';
    var l = lc(s).replace(/\.$/, ''), n = null, m;
    if (/^\d+$/.test(l)) n = +l;
    else if ((m = l.match(/^(\d+)(?:st|nd|rd|th)$/))) n = +m[1];
    else if (own(ORD, l)) n = ORD[l];
    if (n !== null) return n <= 1 ? '' : ordinal(n) + ' ed.';
    if (/^rev(?:ised|\.)?$/.test(l)) return (style === 'mla' ? 'rev.' : 'Rev.') + ' ed.';
    return s + ' ed.';
  }
  function cleanVol(v) { return str(v).replace(/^(?:vol(?:ume)?|v)\.?\s*/i, ''); }
  function cleanIssue(v) { return str(v).replace(/^(?:issue|no|nr|n)\.?\s*/i, ''); }
  function issueFor(S, style) { return style === 'mla' ? S.issue : S.issue.replace(/(\d)\s*-\s*(\d)/g, '$1\u2013$2'); }

  /* ------------------------------------------------------------------
     5. Normalise a source into S (everything printable, nothing undefined)
     ------------------------------------------------------------------ */
  var TYPES = ['article', 'book', 'chapter', 'thesis', 'web', 'other'];
  var TYPE_ALIAS = { 'journal-article': 'article', 'journalarticle': 'article', 'journal article': 'article', 'journal': 'article', 'paper': 'article',
    'dissertation': 'thesis', 'phdthesis': 'thesis', 'mastersthesis': 'thesis', 'book-chapter': 'chapter', 'incollection': 'chapter', 'inbook': 'chapter',
    'proceedings-article': 'chapter', 'monograph': 'book', 'edited-book': 'book', 'website': 'web', 'webpage': 'web', 'web page': 'web', 'page': 'web' };
  // A series / container title that ends in a full stop ("... for mental health professionals.") would print as "professionals.," or
  // "professionals. (pp. 1-2)", so the stop goes; abbreviation series ("J. Exp. Psychol.") keep their dots.
  function stripFinalStop(v) {
    if (!/[^.]\.$/.test(v)) return v;
    if (/(?:\b[A-Za-z]\.){2,}$/.test(v)) return v;                                           // ... U.S.
    if (/\b(?:etc|vs|al|inc|ltd|co|jr|sr|st|no|nos|vol|dr|mr|mrs|ms|ed|eds|ca|cf)\.$/i.test(v)) return v;
    if (/\b[A-Za-z\u00C0-\u024F]{1,12}\.\s/.test(v)) return v;                               // other dotted words: an abbreviation series
    return v.slice(0, -1);
  }
  function cleanContainer(v) { return stripFinalStop(v.replace(/[,;:]+$/, '')); }
  function httpUrl(u) {
    u = str(u).replace(/^<|>$/g, '');
    if (/^www\.[^\s.]+\.\S+$/i.test(u)) u = 'https://' + u;      // typed without the scheme
    return /^https?:\/\/\S+$/i.test(u) ? u : '';
  }
  function people(primary, secondary) {
    var s = typeof primary === 'string' ? str(primary) : '';
    if (s) return parseListEx(primary);
    if (Array.isArray(primary) && primary.length) return parseListEx(primary);
    if (primary && typeof primary === 'object' && !Array.isArray(primary)) {   // a single {family, given} object
      var one = parseListEx([primary]);
      if (one.list.length) return one;
    }
    if (Array.isArray(secondary) && secondary.length) return parseListEx(secondary);
    return { list: [], etAl: false };
  }
  // Her reading list writes roles inside the author text: "Davis, Diana K.; Burke III, Edmund (eds.)",
  // "Whorf, Benjamin Lee (ed. John B. Carroll)", "Pseudo-Majrītī (trans. Hashem Atallah)".
  // Pull those out so they never end up inside a name. The stored text is not changed.
  function splitRoles(raw) {
    var out = { text: raw, editorsText: '', translatorsText: '', allAreEditors: false };
    if (typeof raw !== 'string' || raw.length > 3000) return out;
    var t = raw, m, guard = 0;
    t = t.replace(/\s*\(\s*(?:eds?|editors?)\.?\s*\)(?=\s*;)/gi, function () { out.allAreEditors = true; return ''; });
    while (guard++ < 4 && (m = /\s*\(\s*((?:eds?|editors?|trans(?:lators?)?|tr|translated by|edited by)\b\.?)\s*([^()]*)\)\s*$/i.exec(t))) {
      var role = lc(m[1]).replace(/\./g, ''), names = str(m[2]).replace(/^[:,;\s]+|\s+$/g, '');
      var isTrans = /^tr/.test(role);
      t = t.slice(0, m.index);
      if (isTrans) { if (names) out.translatorsText = (out.translatorsText ? out.translatorsText + '; ' : '') + names; }
      else if (names) out.editorsText = (out.editorsText ? out.editorsText + '; ' : '') + names;
      else out.allAreEditors = true;
    }
    out.text = t.replace(/[\s;,]+$/, '');
    return out;
  }
  // "John B. Carroll and Mary Lee" (given name first) -> list of people
  function givenFirstList(text) {
    if (/,/.test(text)) return parseListEx(text).list;   // "Carroll, John B." is already family-first
    var parts = str(text).split(/\s*(?:;|\band\b|&)\s*/i), res = [];
    for (var i = 0; i < parts.length; i++) {
      var w = str(parts[i]); if (!w) continue;
      var bits = w.split(/\s+/);
      if (bits.length === 1) res.push({ family: bits[0], given: '', literal: '' });
      else res.push({ family: bits[bits.length - 1], given: bits.slice(0, -1).join(' '), literal: '' });
    }
    return res;
  }
  function norm(src, opts) {
    src = (src && typeof src === 'object') ? src : {};
    opts = opts || {};
    var S = { src: src };
    S.title = str(src.title);
    var roles = splitRoles(typeof src.author === 'string' ? src.author : null);
    var a = people(typeof src.author === 'string' ? roles.text : src.author, src.authors), e = people(src.editors, null);
    S.authors = a.list; S.etAl = a.etAl;
    S.editors = e.list; S.editorsEtAl = e.etAl;
    S.translators = roles.translatorsText ? givenFirstList(roles.translatorsText) : [];
    if (roles.editorsText) S.editors = S.editors.concat(givenFirstList(roles.editorsText));
    S.rolesAllEditors = roles.allAreEditors;
    S.venue = cleanContainer(str(src.venue));
    S.volume = cleanVol(src.volume);
    S.issue = cleanIssue(src.issue);
    S.pages = pagesInfo(src.pageRange);
    S.publisher = str(src.publisher);
    S.place = str(src.place);
    S.editionRaw = str(src.edition);
    S.year = yearInfo(src.year, str(opts.suffix));
    var url = httpUrl(src.url) || httpUrl(src.link);
    S.doi = normDOI(src.doi) || (/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i.test(url) ? normDOI(url) : '');
    S.url = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i.test(url) ? '' : url;
    var t = lc(str(src.type));
    if (TYPE_ALIAS.hasOwnProperty(t)) t = TYPE_ALIAS[t];
    if (TYPES.indexOf(t) < 0) {
      if (S.volume || S.issue) t = 'article';
      else if (S.venue && S.editors.length) t = 'chapter';
      else if (S.venue && S.pages.kind) t = 'article';
      else if (S.venue && S.publisher) t = 'chapter';
      else if (S.publisher) t = 'book';
      else if (S.url && !S.doi) t = 'web';
      else t = 'other';
    }
    else if (t === 'other' && S.venue && !S.publisher) {   // the store says 'other' when nothing was chosen: read the details instead
      if (S.volume || S.issue) t = 'article';
      else if (S.editors.length) t = 'chapter';
      else if (S.pages.kind) t = 'article';
    }
    S.type = t;
    if (S.rolesAllEditors && S.authors.length && (t === 'book' || t === 'other') && !S.editors.length) {
      S.editors = S.authors; S.editorsEtAl = S.etAl; S.authors = []; S.etAl = false;   // an edited volume: the editors lead the entry
    }
    if (opts.autoCase) S.title = sentenceCase(S.title);
    return S;
  }
  function doiUrl(S) { return S.doi ? 'https://doi.org/' + S.doi : ''; }
  function linkOf(S, style) {
    var d = doiUrl(S);
    if (d) return d;
    if (style === 'mla') return S.url.replace(/^https?:\/\//i, '');
    return S.url;
  }
  function leadPeople(S) {
    if (S.authors.length) return { list: S.authors, etAl: S.etAl, editors: false };
    if (S.editors.length && (S.type === 'book' || S.type === 'other')) return { list: S.editors, etAl: S.editorsEtAl, editors: true };
    return { list: [], etAl: false, editors: false };
  }
  function sameText(a, b) { return !!a && !!b && sortFold(a) === sortFold(b); }
  function leadFlat(S) { return leadPeople(S).list.map(famOf).join(' '); }

  // degree / institution / database of a thesis
  function degreeOf(t) {
    if (/\b(?:ph\.?\s?d|d\.?\s?phil|doctor\w*|dissertation|ed\.?\s?d|d\.?\s?des)\b/i.test(t)) return 'doctoral';
    if (/\b(?:master\S*|m\.?\s?sc|m\.?\s?a|m\.?\s?phil|m\.?\s?arch|m\.?\s?f\.?\s?a|m\.?\s?s|mphil|msc|march)\b/i.test(t)) return 'master';
    return '';
  }
  function thesisInfo(S) {
    var out = { degree: 'doctoral', inst: S.publisher, db: '' };
    var v = S.venue;
    if (v) {
      var parts = v.split(/\s*[,;]\s*/), degParts = [], rest = [];
      parts.forEach(function (p) { (degreeOf(p) ? degParts : rest).push(p); });
      if (degParts.length) {
        out.degree = degreeOf(degParts[0]);
        if (rest.length && !S.publisher) out.inst = rest.join(', ');
        else if (rest.length) out.db = rest.join(', ');
      } else if (S.publisher) out.db = v;
      else out.inst = v;
    }
    return out;
  }

  /* ------------------------------------------------------------------
     6. APA 7
     ------------------------------------------------------------------ */
  function apaDate(S) {
    var y = S.year;
    if (y.y) return yearText(y) + y.suffix;
    if (y.special) return 'in press';
    return 'n.d.' + (y.suffix ? '-' + y.suffix : '');
  }
  function apaPages(S) {
    var p = S.pages;
    if (!p.kind) return '';
    if (p.kind === 'locator') return 'Article ' + p.text;
    return pageRange(p.kind === 'range' ? p.a + '-' + p.b : p.text, 'apa');
  }
  function buildAPA(S) {
    var lead = leadPeople(S), names = apaList(lead.list, lead.etAl);
    if (lead.editors) names += ' (' + (lead.list.length > 1 ? 'Eds.' : 'Ed.') + ')';
    var T = S.title, ed = normEdition(S.editionRaw, 'apa'), link = linkOf(S, 'apa');
    var titleSeg = '', rest = [];
    var pubSeg = (S.publisher && !sameText(S.publisher, leadFlat(S))) ? endDot(S.publisher) : '';
    if (S.type === 'article') {
      titleSeg = endDot(T);
      var iss = S.issue ? '(' + issueFor(S, 'apa') + ')' : '', pg = apaPages(S), jv;
      // APA 7 italicises the journal title, the comma and the volume as one piece: Journal of X, 12(3), 1-9
      if (S.venue && S.volume) jv = ital(S.venue + ', ' + S.volume) + iss;
      else jv = join([ital(S.venue), (S.volume ? ital(S.volume) : '') + iss], ', ');
      rest.push(endDot(join([jv, pg], ', ')));
    } else if (S.type === 'book' || S.type === 'other') {
      var inner = [];
      if (ed) inner.push(ed);                                       // APA 7: (2nd ed., Vol. 3)  edition first, then volume
      if (S.volume && S.type === 'book') inner.push('Vol. ' + S.volume);
      if (!lead.editors && S.editors.length) inner.push(apaEditorsParen(S.editors));
      if (S.translators.length) inner.push(apaEditors(S.translators) + ', Trans.');
      titleSeg = endDot(ital(T) + (inner.length ? ' (' + inner.join(', ') + ')' : ''));
      rest.push(pubSeg || (S.type === 'other' && !S.publisher && S.venue ? endDot(S.venue) : ''));
    } else if (S.type === 'chapter') {
      titleSeg = endDot(T);
      var paren = [];
      if (ed) paren.push(ed);                                       // (4th ed., Vol. 2, pp. 5-9)
      if (S.volume) paren.push('Vol. ' + S.volume);
      if (S.pages.kind) paren.push(pagePrefix(S.pages) + apaPages(S).replace(/^Article /, ''));
      var inPart = '';
      if (S.venue || S.editors.length) {
        inPart = 'In ' + (S.editors.length ? apaEditors(S.editors) + ' (' + (S.editors.length > 1 ? 'Eds.' : 'Ed.') + '), ' : '') +
                 ital(S.venue) + (paren.length ? ' (' + paren.join(', ') + ')' : '');
      }
      rest.push(endDot(inPart), pubSeg);
    } else if (S.type === 'thesis') {
      var ti = thesisInfo(S);
      var kind = ti.degree === 'master' ? "master's thesis" : 'doctoral dissertation';
      if (link || ti.db) {          // found in a database or repository
        titleSeg = endDot(ital(T) + ' [' + kind.charAt(0).toUpperCase() + kind.slice(1) + (ti.inst ? ', ' + ti.inst : '') + ']');
        rest.push(ti.db ? endDot(ti.db) : '');
      } else {                       // APA 7: [Unpublished doctoral dissertation]. Institution.
        titleSeg = endDot(ital(T) + ' [Unpublished ' + kind + ']');
        rest.push(ti.inst ? endDot(ti.inst) : '');
      }
    } else {   // web
      titleSeg = endDot(ital(T));
      var site = S.venue || S.publisher;
      rest.push(site && !sameText(site, leadFlat(S)) ? endDot(site) : '');
    }
    rest.push(link);
    var date = endDot('(' + apaDate(S) + ')');
    var head = names ? [endDot(names), date, titleSeg] : [titleSeg, date];
    return squeeze(join(head.concat(rest), ' '));
  }
  function apaEditorsParen(list) {   // "(P. J. C. Field, Ed.)" content
    return apaEditors(list) + ', ' + (list.length > 1 ? 'Eds.' : 'Ed.');
  }

  /* ------------------------------------------------------------------
     7. Chicago 17, author-date
     ------------------------------------------------------------------ */
  function chiDate(S) {
    var y = S.year;
    if (y.y) return yearText(y) + y.suffix;
    if (y.special) return 'forthcoming';
    return 'n.d.';   // Chicago 17 has no lettered n.d. form: undated works stay plain n.d.
  }
  function chiPages(S) { return S.pages.kind ? pageRange(S.pages.kind === 'range' ? S.pages.a + '-' + S.pages.b : S.pages.text, 'chicago') : ''; }
  function buildChicago(S) {
    var lead = leadPeople(S), names = chiList(lead.list, lead.etAl, true);
    if (lead.editors) names += ', ' + (lead.list.length > 1 ? 'eds.' : 'ed.');
    var T = S.title, ed = normEdition(S.editionRaw, 'chicago'), link = linkOf(S, 'chicago');
    var date = chiDate(S);
    var linkSeg = link ? endDot(link) : '';
    var placePub = S.publisher ? (S.place ? S.place + ': ' + S.publisher : S.publisher) : '';   // Chicago keeps the publisher even when it is also the author
    var titleSeg = '', rest = [];
    if (S.type === 'article') {
      titleSeg = quoted(T);
      var iss = issueFor(S, 'chicago');
      var vi = S.volume ? S.volume + (iss ? ' (' + iss + ')' : '') : (iss ? 'no. ' + iss : '');
      var pg = chiPages(S);
      var src = ital(S.venue);
      if (vi) src = join([src, vi], ' ');
      if (pg) src = src ? src + (vi ? ': ' : ', ') + pg : pg;
      rest.push(endDot(src));
    } else if (S.type === 'book' || S.type === 'other') {
      titleSeg = endDot(ital(T));
      var vol = S.type === 'book' && S.volume ? 'Vol. ' + S.volume + '.' : '';
      rest.push(ed, vol);
      if (!lead.editors && S.editors.length) rest.push('Edited by ' + chiList(S.editors, S.editorsEtAl, false) + '.');
      if (S.translators.length) rest.push('Translated by ' + chiList(S.translators, false, false) + '.');
      rest.push(endDot(placePub || (S.type === 'other' && S.venue ? S.venue : '')));
    } else if (S.type === 'chapter') {
      titleSeg = quoted(T);
      var inPart = '';
      if (S.venue || S.editors.length) {
        inPart = join(['In ' + ital(S.venue),
          S.editors.length ? 'edited by ' + chiList(S.editors, S.editorsEtAl, false) : '',
          ed, S.volume ? 'vol. ' + S.volume : '', chiPages(S)], ', ');   // edition first, then volume (as in the book entry)
      } else if (S.pages.kind) inPart = chiPages(S);
      rest.push(endDot(inPart), endDot(placePub));
    } else if (S.type === 'thesis') {
      var ti = thesisInfo(S);
      titleSeg = quoted(T);
      rest.push(endDot((ti.degree === 'master' ? "Master's thesis" : 'PhD diss.') + (ti.inst ? ', ' + ti.inst : '')), ti.db ? endDot(ti.db) : '');
    } else {   // web
      titleSeg = quoted(T);
      var site = S.venue, pub = S.publisher;
      rest.push(site && !sameText(site, leadFlat(S)) ? endDot(site) : '');
      if (pub && !sameText(pub, leadFlat(S)) && !sameText(pub, site)) rest.push(endDot(pub));
    }
    rest.push(linkSeg);
    var head = names ? [endDot(names), endDot(date), titleSeg] : [titleSeg, endDot(date)];
    return squeeze(join(head.concat(rest), ' '));
  }

  /* ------------------------------------------------------------------
     8. MLA 9
     ------------------------------------------------------------------ */
  function mlaYear(S) {
    var y = S.year;
    if (y.y) return yearText(y);
    if (y.special) return 'forthcoming';
    return '';
  }
  function mlaPages(S) {
    var p = S.pages;
    if (!p.kind) return '';
    var txt = pageRange(p.kind === 'range' ? p.a + '-' + p.b : p.text, 'mla');
    return p.kind === 'locator' ? txt : pagePrefix(p) + txt;
  }
  function buildMLA(S) {
    var lead = leadPeople(S), names = mlaList(lead.list, lead.etAl, true);
    if (lead.editors) names += ', ' + (lead.list.length > 1 ? 'editors' : 'editor');
    var T = S.title, ed = normEdition(S.editionRaw, 'mla'), link = linkOf(S, 'mla'), year = mlaYear(S);
    var pub = S.publisher && !sameText(S.publisher, leadFlat(S)) ? S.publisher : '';
    var titleSeg = '', rest = [];
    var edBy = function () { return S.editors.length ? 'edited by ' + mlaList(S.editors, S.editorsEtAl, false) : ''; };
    if (S.type === 'article') {
      titleSeg = quoted(T);
      // MLA 9: with one container only, the DOI / URL is the last element of that container (comma, not a new sentence)
      rest.push(endDot(join([ital(S.venue), S.volume ? 'vol. ' + S.volume : '', S.issue ? 'no. ' + S.issue : '', year, mlaPages(S), link], ', ')));
    } else if (S.type === 'book' || S.type === 'other') {
      titleSeg = endDot(ital(T));
      var by = !lead.editors && S.editors.length ? 'Edited by ' + mlaList(S.editors, S.editorsEtAl, false) : '';
      if (S.translators.length) by = join([by, (by ? 'translated by ' : 'Translated by ') + mlaList(S.translators, false, false)], ', ');
      var seg = join([by, ed, S.type === 'book' && S.volume ? 'vol. ' + S.volume : '', pub || (S.type === 'other' && !S.publisher ? S.venue : ''), year, link], ', ');
      rest.push(endDot(link && seg.indexOf(link) === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)));   // a new sentence: "Rev. ed., Publisher, 2001."
    } else if (S.type === 'chapter') {
      titleSeg = quoted(T);
      rest.push(endDot(join([ital(S.venue), edBy(), ed, S.volume ? 'vol. ' + S.volume : '', pub, year, mlaPages(S), link], ', ')));
    } else if (S.type === 'thesis') {
      var ti = thesisInfo(S);
      titleSeg = endDot(ital(T));
      rest.push(year ? year + '.' : '');
      // a repository / database is a second container: "*Database*, URL."; with no database the URL stays in the first container
      rest.push(endDot(join([ti.inst, ti.degree === 'master' ? 'MA thesis' : 'PhD dissertation'].concat(ti.db ? [] : [link]), ', ')));
      if (ti.db) rest.push(endDot(join([ital(ti.db), link], ', ')));
    } else {   // web
      titleSeg = quoted(T);
      var site = S.venue;
      var pubW = pub && !sameText(pub, site) ? pub : '';
      rest.push(endDot(join([ital(site), pubW, year, link], ', ')));
    }
    var head = names ? [endDot(names), titleSeg] : [titleSeg];
    return squeeze(join(head.concat(rest), ' '));
  }

  /* ------------------------------------------------------------------
     9. format
     ------------------------------------------------------------------ */
  function normStyle(style) {
    var s = lc(str(style)).replace(/[\s_-]/g, '');
    if (s === 'chicago' || s === 'chicago17' || s === 'chicagoauthordate' || s === 'cmos') return 'chicago';
    if (s === 'mla' || s === 'mla9') return 'mla';
    if (s === 'bibtex' || s === 'bib') return 'bibtex';
    return 'apa';
  }
  function isEmptyS(S) {
    return !S.title && !S.authors.length && !S.editors.length && !S.venue && !S.publisher && !S.url && !S.doi && !S.volume && !S.pages.kind && !S.year.y;
  }
  function formatMarked(src, style, opts) {
    var S = norm(src, opts);
    if (isEmptyS(S)) return '';
    if (style === 'chicago') return buildChicago(S);
    if (style === 'mla') return buildMLA(S);
    return buildAPA(S);
  }
  function format(src, style, opts) {
    try {
      style = normStyle(style);
      if (style === 'bibtex') {
        var b = bibtex(src);
        return { text: b, html: esc(b) };
      }
      var m = formatMarked(src, style, opts);
      return { text: plain(m), html: toHTML(m) };
    } catch (e) {
      return { text: '', html: '' };
    }
  }

  /* ------------------------------------------------------------------
     10. In-text citations
     ------------------------------------------------------------------ */
  function inTextMarked(src, style, page, opts) {
    var S = norm(src, opts);
    style = normStyle(style);
    if (style === 'bibtex') style = 'apa';
    var lead = leadPeople(S), fams = lead.list.map(famOf), n = fams.length, names = '';
    var y = S.year, yr = y.y ? yearText(y) + y.suffix : (y.special ? (style === 'apa' ? 'in press' : 'forthcoming') : 'n.d.' + (y.suffix && style === 'apa' ? '-' + y.suffix : ''));
    var pg = stripPageLabel(str(page)).replace(/\s*(?:[\u2010-\u2015\u2212]|--+)\s*/g, '-'), pgText = '';
    if (pg && !/^0+$/.test(pg)) {   // page 0 does not exist: a default of 0 from the caller means "no page"
      var info = pagesInfo(pg);
      if (/^[A-Za-z]/.test(pg) && info.kind !== 'locator' && !/^[ivxlcdm]+(?:-[ivxlcdm]+)?$/i.test(pg)) pgText = pg;   // "para. 4", "chap. 2"
      else if (style === 'apa') pgText = pagePrefix(info) + pageRange(info.kind === 'range' ? info.a + '-' + info.b : info.text, 'apa');
      else pgText = pageRange(info.kind === 'range' ? info.a + '-' + info.b : info.text, style);
    }
    if (n) {
      if (style === 'apa') names = (n === 1 && !lead.etAl) ? fams[0] : (n === 2 && !lead.etAl) ? fams[0] + ' & ' + fams[1] : fams[0] + ' et al.';
      else if (style === 'chicago') names = (n === 1 && !lead.etAl) ? fams[0] : (n === 2 && !lead.etAl) ? fams[0] + ' and ' + fams[1] :
        (n === 3 && !lead.etAl) ? fams[0] + ', ' + fams[1] + ', and ' + fams[2] : fams[0] + ' et al.';
      else names = (n === 1 && !lead.etAl) ? fams[0] : (n === 2 && !lead.etAl) ? fams[0] + ' and ' + fams[1] : fams[0] + ' et al.';
    }
    var asTitle = '';
    if (!names) {
      var st = shortTitle(S.title, style);
      if (!st) return '';
      var italic = (S.type === 'book' || S.type === 'thesis' || S.type === 'other' || (S.type === 'web' && style === 'apa'));
      if (style === 'apa') asTitle = italic ? ital(st) : '\u201C' + st + (yr ? ',' : '') + '\u201D';
      else asTitle = italic ? ital(st) : '\u201C' + st + '\u201D';
      names = asTitle;
    }
    var inner;
    if (style === 'apa') {
      inner = (asTitle && asTitle.charAt(asTitle.length - 1) === '\u201D') ? names + ' ' + yr : names + ', ' + yr;
      if (pgText) inner += ', ' + pgText;
    } else if (style === 'chicago') {
      inner = names + ' ' + yr;
      if (pgText) inner += ', ' + pgText;
    } else {
      inner = names + (pgText ? ' ' + pgText : '');
    }
    return '(' + inner + ')';
  }
  // opts (optional, 4th argument): {suffix: 'a'} adds the same year letter that bibliography().entries[].suffix gave this source
  function inText(src, style, page, opts) {
    try { return plain(inTextMarked(src, style, page, opts)); } catch (e) { return ''; }
  }
  function inTextHTML(src, style, page, opts) {
    try { return toHTML(inTextMarked(src, style, page, opts)); } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------------
     11. Bibliography
     ------------------------------------------------------------------ */
  function sortParts(S, style) {
    var lead = leadPeople(S), keys;
    if (lead.list.length) {
      keys = lead.list.map(function (p) { return sortFold(famOf(p)) + '|' + sortFold(p.given); });
    } else {
      keys = [sortFold(S.title.replace(/^\s*(?:a|an|the)\s+/i, ''))];
    }
    var yv = S.year.y ? (/^B/.test(S.year.era) ? -(+S.year.y) : +S.year.y) : (S.year.special ? 99999 : -1);
    return { keys: keys, year: yv, title: sortFold(S.title.replace(/^\s*(?:a|an|the)\s+/i, '')), style: style };
  }
  function cmpKeys(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  }
  function alpha(n) {   // 0 -> a, 25 -> z, 26 -> aa
    var out = '';
    n = n + 1;
    while (n > 0) { out = String.fromCharCode(97 + ((n - 1) % 26)) + out; n = Math.floor((n - 1) / 26); }
    return out;
  }
  // letters (optional, 3rd argument): {id: 'a'} worked out over a longer list (the whole shelf). A shorter list then
  // carries those letters instead of its own, so it agrees with the in-text citations. A hand-typed letter stays.
  function bibliography(srcs, style, letters) {
    style = normStyle(style);
    var list = Array.isArray(srcs) ? srcs.slice() : (srcs && typeof srcs === 'object' ? [srcs] : []);
    list = list.filter(function (s) { return s && typeof s === 'object' && !Array.isArray(s) && formatMarked(s, style === 'bibtex' ? 'apa' : style); });   // empty sources make no entry
    if (style === 'bibtex') {
      var bt = bibtexAll(list);
      return { text: bt, html: esc(bt), entries: [] };
    }
    var items = list.map(function (src, i) {
      var S = norm(src), sp = sortParts(S, style);
      return { src: src, S: S, sp: sp, i: i, suffix: '' };
    });
    items.sort(function (a, b) {
      var c = cmpKeys(a.sp.keys, b.sp.keys);
      if (c) return c;
      if (style === 'mla') {
        if (a.sp.title !== b.sp.title) return a.sp.title < b.sp.title ? -1 : 1;
        if (a.sp.year !== b.sp.year) return a.sp.year - b.sp.year;
      } else {
        if (a.sp.year !== b.sp.year) return a.sp.year - b.sp.year;
        if (a.sp.title !== b.sp.title) return a.sp.title < b.sp.title ? -1 : 1;
      }
      return a.i - b.i;
    });
    if (style !== 'mla') {
      var i = 0;
      while (i < items.length) {
        var j = i + 1;
        while (j < items.length && cmpKeys(items[i].sp.keys, items[j].sp.keys) === 0 && items[i].sp.year === items[j].sp.year &&
               items[i].S.authors.length === items[j].S.authors.length) j++;
        if (j - i > 1 && !(style === 'chicago' && items[i].sp.year === -1)) {
          var taken = {}, k = 0, q;
          for (q = i; q < j; q++) if (items[q].S.year.suffix) taken[items[q].S.year.suffix] = true;   // typed by hand: keep
          for (q = i; q < j; q++) {
            if (items[q].S.year.suffix) continue;
            while (taken[alpha(k)]) k++;
            items[q].suffix = alpha(k);
            taken[alpha(k)] = true;
            k++;
          }
        }
        i = j;
      }
    }
    if (letters && style !== 'mla') items.forEach(function (it) {
      if (!it.S.year.suffix) it.suffix = own(letters, it.src.id) ? letters[it.src.id] : '';
    });
    var entries = items.map(function (it) {
      var marked = formatMarked(it.src, style, { suffix: it.suffix });
      return { id: it.src.id === undefined ? null : it.src.id, suffix: it.suffix || it.S.year.suffix, text: plain(marked), html: toHTML(marked) };
    });
    return {
      text: entries.map(function (e) { return e.text; }).join('\n\n'),
      html: entries.map(function (e) { return '<p>' + e.html + '</p>'; }).join('\n'),
      entries: entries
    };
  }

  /* ------------------------------------------------------------------
     12. BibTeX
     ------------------------------------------------------------------ */
  var STOP = { a: 1, an: 1, the: 1, on: 1, of: 1, and: 1, in: 1, for: 1, to: 1, with: 1, from: 1, at: 1, by: 1 };
  function keyBase(S) {
    var lead = leadPeople(S), fam = '';
    if (lead.list.length) {
      var p = lead.list[0];
      fam = deburr(p.literal ? p.literal.split(' ')[0] : p.family).replace(/[^a-z0-9]/g, '');
      if (!fam && p.literal) fam = deburr(p.literal).replace(/[^a-z0-9]/g, '');
    }
    if (!fam) fam = 'anon';
    var yr = S.year.y || 'nd';
    var tw = '';
    S.title.split(/[\s:;,.\-\u2013\u2014]+/).some(function (w) {
      var d = deburr(w).replace(/[^a-z0-9]/g, '');
      if (d && !own(STOP, d)) { tw = d; return true; }
      return false;
    });
    return fam + yr + tw;
  }
  function uniqueKey(base, used) {
    var has = function (k) { return Array.isArray(used) ? used.indexOf(k) >= 0 : !!(used && used[k]); };
    var key = base, n = 0;
    while (has(key)) {
      n++;
      key = base + alpha(n - 1);
    }
    if (Array.isArray(used)) used.push(key); else if (used && typeof used === 'object') used[key] = true;
    return key;
  }
  function balanceBraces(s) {
    var depth = 0, out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '{') { depth++; out += c; }
      else if (c === '}') { if (depth > 0) { depth--; out += c; } }
      else out += c;
    }
    while (depth-- > 0) out += '}';
    return out;
  }
  function bibEsc(s) {   // LaTeX specials in running text (not for url / doi)
    return s.replace(/([&%#_$])/g, '\\$1');
  }
  function protectCaps(s) {   // {NASA}, {McDonald}: words with two or more capitals keep them
    return s.split(' ').map(function (w) {
      if (/\{/.test(w)) return w;
      var sw = splitWord(w), caps = (sw.core.match(/[A-Z]/g) || []).length;
      if (caps >= 2 && !/^(?:al|el)-/.test(sw.core)) return sw.pre + '{' + sw.core + '}' + sw.post;
      return w;
    }).join(' ');
  }
  function bibText(s, protect) {
    s = balanceBraces(bibEsc(str(s)));
    return protect ? protectCaps(s) : s;
  }
  function bibPerson(p) {
    if (p.literal) return '{' + balanceBraces(bibEsc(p.literal)) + '}';
    var sp = splitGivenSuffix(p.given), fam = p.family;
    var f = (/\s/.test(fam) || /^[a-z]/.test(fam) || !sp.given) ? '{' + fam + '}' : fam;
    if (!sp.given && !sp.suffix) return f;
    return f + (sp.suffix ? ', ' + sp.suffix : '') + ', ' + sp.given;
  }
  function bibNames(list, etAl) {
    return list.map(bibPerson).join(' and ') + (etAl ? ' and others' : '');
  }
  function bibPages(S) {
    if (!S.pages.kind) return '';
    if (S.pages.kind === 'range') return S.pages.a + '--' + S.pages.b;
    return S.pages.text.replace(/\u2013/g, '--');
  }
  function bibtex(src, usedKeys) {
    var S = norm(src);
    if (isEmptyS(S)) return '';
    var key = uniqueKey(keyBase(S), usedKeys);
    var f = [];
    var add = function (name, val, raw) { if (val) f.push([name, raw ? val : balanceBraces(val)]); };
    var type = 'misc', ed = normEdition(S.editionRaw, 'apa').replace(/\s*ed\.$/, '');
    var yr = S.year.y ? yearText(S.year) : (S.year.special ? 'forthcoming' : 'n.d.');
    var authors = S.authors.length ? bibNames(S.authors, S.etAl) : '';
    var editors = S.editors.length ? bibNames(S.editors, S.editorsEtAl) : '';
    if (S.type === 'article') {
      type = 'article';
      add('author', authors); add('title', bibText(S.title, true)); add('journal', bibText(S.venue, true));
      add('year', yr); add('volume', S.volume); add('number', S.issue); add('pages', bibPages(S));
    } else if (S.type === 'book') {
      type = 'book';
      if (authors) { add('author', authors); add('editor', editors); } else add('editor', editors);
      add('translator', S.translators.length ? bibNames(S.translators, false) : '');
      add('title', bibText(S.title, true)); add('publisher', bibText(S.publisher)); add('address', bibText(S.place));
      add('edition', ed); add('volume', S.volume); add('year', yr);
    } else if (S.type === 'chapter') {
      type = 'incollection';
      add('author', authors); add('title', bibText(S.title, true)); add('booktitle', bibText(S.venue, true));
      add('editor', editors); add('publisher', bibText(S.publisher)); add('address', bibText(S.place));
      add('edition', ed); add('volume', S.volume); add('pages', bibPages(S)); add('year', yr);
    } else if (S.type === 'thesis') {
      var ti = thesisInfo(S);
      type = ti.degree === 'master' ? 'mastersthesis' : 'phdthesis';
      add('author', authors); add('title', bibText(S.title, true)); add('school', bibText(ti.inst)); add('year', yr);
      add('address', bibText(S.place)); add('note', bibText(ti.db));
    } else {
      type = 'misc';
      add('author', authors); add('editor', editors);
      add('translator', S.translators.length ? bibNames(S.translators, false) : '');
      add('title', bibText(S.title, true));
      add('publisher', bibText(S.publisher || (S.type === 'web' ? S.venue : ''))); add('address', bibText(S.place));
      if (S.type === 'other' && S.venue && S.publisher) add('howpublished', bibText(S.venue));
      add('year', yr);
    }
    if (S.doi) add('doi', S.doi, true);
    if (S.url) add('url', S.url, true);
    var body = f.map(function (kv) { return '  ' + kv[0] + ' = {' + kv[1] + '}'; }).join(',\n');
    return '@' + type + '{' + key + ',\n' + body + '\n}';
  }
  function bibtexAll(srcs) {
    var used = [], list = Array.isArray(srcs) ? srcs : (srcs && typeof srcs === 'object' ? [srcs] : []);
    var out = [];
    list.forEach(function (s) { if (s && typeof s === 'object') { try { var b = bibtex(s, used); if (b) out.push(b); } catch (e) { /* skip */ } } });
    return out.join('\n\n');
  }

  /* ------------------------------------------------------------------
     13. Crossref
     ------------------------------------------------------------------ */
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e.charAt(0) === '#') {
        var code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint ? String.fromCodePoint(code) : String.fromCharCode(code); } catch (x) { return m; }
      }
      return ENT.hasOwnProperty(lc(e)) ? ENT[lc(e)] : m;
    });
  }
  function cleanMarkup(s) {
    return decodeEntities(String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  }
  function crName(a) {
    if (!a || typeof a !== 'object') return '';
    var fam = cleanMarkup(a.family), giv = cleanMarkup(a.given), nm = cleanMarkup(a.name);
    var shout = function (t) { return t.length > 3 && t === t.toUpperCase() && /[A-Z]/.test(t); };
    var fix = function (t) { return shout(t) ? t.toLowerCase().replace(/(^|[\s\-'\u2019])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); }) : t; };
    var suf = cleanMarkup(a.suffix);
    if (fam) return fix(fam) + (giv ? ', ' + fix(giv) + (suf ? ', ' + suf : '') : '');
    return nm || giv;
  }
  var CR_TYPES = {
    'journal-article': 'article', 'book': 'book', 'monograph': 'book', 'edited-book': 'book', 'reference-book': 'book',
    'proceedings': 'book', 'book-series': 'book', 'book-set': 'book',
    'book-chapter': 'chapter', 'book-section': 'chapter', 'book-part': 'chapter', 'book-track': 'chapter',
    'reference-entry': 'chapter', 'proceedings-article': 'chapter', 'dissertation': 'thesis'
  };
  function datePart(o) {
    var dp = o && o['date-parts'];
    if (Array.isArray(dp) && Array.isArray(dp[0]) && dp[0][0] !== null && dp[0][0] !== undefined) return String(dp[0][0]);
    return '';
  }
  function fromCrossref(json) {
    var out = { title: '', author: '', year: '', type: 'other', venue: '', volume: '', issue: '', pageRange: '', publisher: '', doi: '', url: '' };
    try {
      var m = json && typeof json === 'object' ? (json.message && typeof json.message === 'object' ? json.message : json) : null;
      if (!m) return out;
      var first = function (v) { return Array.isArray(v) ? (v.length ? v[0] : '') : (v || ''); };
      var title = cleanMarkup(first(m.title)), sub = cleanMarkup(first(m.subtitle));
      if (sub && title && lc(title).indexOf(lc(sub)) < 0) title += (/[:?!.]$/.test(title) ? ' ' : ': ') + sub;
      out.title = stripFinalStop(title);   // some publishers (APA books) deposit titles with a closing full stop
      out.type = CR_TYPES.hasOwnProperty(m.type) ? CR_TYPES[m.type] : 'other';
      out.author = arr(m.author).map(crName).filter(Boolean).join('; ');
      var ed = arr(m.editor).map(crName).filter(Boolean).join('; ');
      if (ed) out.editors = ed;
      out.year = datePart(m.issued) || datePart(m['published-print']) || datePart(m['published-online']) || datePart(m.published) || datePart(m.created);
      if (out.type === 'article' || out.type === 'chapter') {
        out.venue = cleanContainer(cleanMarkup(first(m['container-title'])) || (m.event && typeof m.event === 'object' ? cleanMarkup(m.event.name) : cleanMarkup(m.event)));
      }
      out.volume = cleanMarkup(m.volume);
      out.issue = cleanMarkup(m.issue);
      out.pageRange = cleanMarkup(m.page).replace(/\s*[\u2010-\u2015\u2212]\s*/g, '-') || cleanMarkup(m['article-number']);
      var inst = m.institution ? cleanMarkup(first(Array.isArray(m.institution) ? m.institution.map(function (x) { return x && x.name; }) : m.institution.name)) : '';
      // Crossref often adds the acronym in brackets: "American Psychological Association (APA)", "Public Library of Science (PLoS)"
      out.publisher = (out.type === 'thesis' && inst) ? inst : cleanMarkup(m.publisher).replace(/\s*\([A-Za-z][A-Za-z.&\-]{1,11}\)\s*$/, '');
      out.doi = normDOI(m.DOI);
      var u = (m.resource && m.resource.primary && m.resource.primary.URL) || m.URL || '';
      out.url = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i.test(u) ? '' : String(u);
      var place = cleanMarkup(m['publisher-location']);
      if (place) out.place = place;
      var en = m['edition-number'] ? parseInt(m['edition-number'], 10) : 0;
      if (en > 1) out.edition = ordinal(en);
    } catch (e) { /* return what we have */ }
    return out;
  }
  function lookup(input, fetchImpl) {
    return new Promise(function (resolve, reject) {
      var doi = normDOI(input);
      if (!doi) { reject(new Error('That does not look like a DOI. A DOI starts with 10. and has a slash, like 10.1000/abc.')); return; }
      var f = fetchImpl || (root.fetch ? root.fetch.bind(root) : null);
      if (typeof f !== 'function') { reject(new Error('This browser cannot look things up right now.')); return; }
      var p;
      try { p = Promise.resolve(f('https://api.crossref.org/works/' + encodeURIComponent(doi))); }
      catch (e) { reject(new Error('I could not reach Crossref. Check the internet and try again.')); return; }
      p.then(function (res) {
        if (!res || typeof res !== 'object') throw new Error('I got an answer I could not read.');
        if (res.status === 404) throw new Error('I could not find that DOI. Check it for typos.');
        if (!res.ok) throw new Error('Crossref could not answer right now (error ' + res.status + '). Try again in a little while.');
        return Promise.resolve(res.json()).then(null, function () { throw new Error('I got an answer I could not read.'); });
      }).then(function (json) {
        var msg = json && json.message;
        if (!msg || typeof msg !== 'object' || !Object.keys(msg).length) throw new Error('I could not find that DOI. Check it for typos.');
        var r = fromCrossref(json);
        if (!r.doi || lc(r.doi) === lc(doi)) r.doi = doi;   // keep the DOI as the person typed it (Crossref sends it lower-cased)
        resolve(r);
      }).then(null, function (err) {
        var msg = err && err.message ? err.message : '';
        var known = /^(?:I could not|I got an answer|Crossref could not)/.test(msg);
        reject(new Error(known ? msg : 'I could not reach Crossref. Check the internet and try again.'));
      });
    });
  }

  /* ------------------------------------------------------------------ */
  root.Lib.cite = {
    parseAuthors: parseAuthors,
    format: format,
    inText: inText,
    inTextHTML: inTextHTML,
    bibliography: bibliography,
    bibtex: bibtex,
    bibtexAll: bibtexAll,
    normDOI: normDOI,
    fromCrossref: fromCrossref,
    lookup: lookup,
    pageRange: pageRange,
    sentenceCase: sentenceCase,
    titleCase: titleCase,
    styles: ['apa', 'chicago', 'mla', 'bibtex']
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = root.Lib.cite; }
})();
