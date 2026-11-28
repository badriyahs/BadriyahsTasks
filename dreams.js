/* The dream sunrise on the home page: research (me, learning) is the sun, each ray is a dream, each ring
   in a ray is a step (darker once done). Under it, every step written out, in the ray's colour.
   Saved in this browser, and in the "dreams" collection once its Firebase rule allows it. */
(function(){
  var KEY = 'badriyah-dreams-v1';
  function steps(list){ return list.map(function(s, i){ return typeof s === 'string' ? {id: 's' + i, t: s, done: false} : {id: 's' + i, t: s.t, done: !!s.done}; }); }
  var SEED = {
    updated: 0,
    parts: [
      {id: 'core', name: 'Research', sub: 'the sun', steps: steps(['Course: Designing for Looking Up', 'Course: the Arabian stars'])},
      {id: 'design', name: 'Design practice', sub: 'RUMMA Studio', steps: steps(['Dark sky lighting certification', 'Apply to competitions', 'Build a portfolio', 'Reach out to resorts'])},
      {id: 'art', name: 'Art practice', sub: '', steps: steps([{t: 'As the Sun Rests', done: true}, {t: 'Names of the Sun', done: true}, 'Keep making artworks', 'The next exhibition', 'Apply to grants'])},
      {id: 'book', name: 'A book', sub: '', steps: steps(['Write the book'])},
      {id: 'travel', name: 'Travel series', sub: '', steps: steps(['Write the episodes', 'Write the shots', 'Choose places to travel and film', 'Make it into a script'])},
      {id: 'writing', name: 'Writing', sub: '', steps: []},
      {id: 'phd', name: 'PhD', sub: 'papers and calls', steps: steps([{t: 'CAA talk, February', done: true}, {t: 'KFCRIS chapter proposal sent', done: true}, 'Send the next paper to a call', 'Rethink the PhD next fall'])},
      {id: 'social', name: 'Social life', sub: '', steps: []},
      {id: 'fitness', name: 'Fitness', sub: '', steps: []},
      {id: 'atelier', name: 'RUMMA Atelier', sub: '', steps: steps(['Make my little objects'])}
    ],
    episodes: [],
    log: []
  };
  // the rays, left to right across the sky (the Atelier stays last): name lines, the colour of a done step, the colour of one still to come
  var RAYS = [
    {id: 'design', label: ['Design', 'practice'], col: '#2F6F5C', soft: '#A3C4B4'},
    {id: 'art', label: ['Art', 'practice'], col: '#C4532E', soft: '#ECAF92'},
    {id: 'book', label: ['A book'], col: '#E4443A', soft: '#FF8F7D'},
    {id: 'travel', label: ['Travel', 'series'], col: '#8E123C', soft: '#C6406A'},
    {id: 'writing', label: ['Writing'], col: '#78102C', soft: '#9C1F43'},
    {id: 'phd', label: ['PhD'], col: '#A8671A', soft: '#E0A84A'},
    {id: 'social', label: ['Social', 'life'], col: '#A82F58', soft: '#CC5379'},
    {id: 'fitness', label: ['Fitness'], col: '#E4574E', soft: '#FF8277'},
    {id: 'atelier', label: ['RUMMA', 'Atelier'], col: '#3F7967', soft: '#99BDAE'}
  ];
  var SUNCOL = '#E8871C';
  var KINDS = [{k: 'book', name: 'I read a book', word: 'Book'}, {k: 'article', name: 'I read an article', word: 'Article'}, {k: 'wrote', name: 'I wrote', word: 'Wrote'}, {k: 'course', name: 'Course time', word: 'Course'}];
  function iso(d){ return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function daysAgo(n){ var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n); }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function copy(o){ return JSON.parse(JSON.stringify(o)); }
  function uid(){ return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
  // a saved copy from before a dream was added still gets it
  function whole(v){
    SEED.parts.forEach(function(p){ if(!v.parts.some(function(x){ return x.id === p.id; })) v.parts.push(copy(p)); });
    v.episodes = v.episodes || []; v.log = v.log || []; return v;
  }
  function readLocal(){ try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && v.parts ? whole(v) : null; } catch(e){ return null; } }

  var DKEY = KEY + '-drafts';
  function readDrafts(){ try { return JSON.parse(localStorage.getItem(DKEY) || '{}') || {}; } catch(e){ return {}; } }
  // only the box being typed in is written, so another tab's unsent words stay
  function keepDraft(k){ var d = readDrafts(); if(drafts[k]) d[k] = drafts[k]; else delete d[k]; try { localStorage.setItem(DKEY, JSON.stringify(d)); } catch(e){} }

  var chartEl, listEl, state = readLocal() || copy(SEED), doc = null, cloud = false, behind = false, saved = true, timer = null,
      adding = null, tracking = false, scripting = false, drafts = readDrafts(), cleared = {};

  // every change is stamped per field; two copies are joined item by item, so nothing one side has is dropped
  function live(list){ return (list || []).filter(function(x){ return !x.gone; }); }
  function find(list, id){ return (list || []).filter(function(x){ return x.id === id; })[0]; }
  function set(x, k, v){ x[k] = v; x.at = x.at || {}; x.at[k] = Math.max(Date.now(), (x.at[k] || 0) + 1); }   // beats what it was typed over, even if clocks differ
  function join(a, b){
    var out = copy(a || []);
    (b || []).forEach(function(x){
      var o = find(out, x.id); if(!o) return out.push(copy(x));
      Object.keys(x.at || {}).forEach(function(k){
        if(x.at[k] > ((o.at || {})[k] || 0)){ o[k] = x[k]; (o.at = o.at || {})[k] = x.at[k]; }
      });
    });
    return out;
  }
  function merge(theirs, mine){
    if(!theirs || !theirs.parts) return copy(mine);
    var out = copy(theirs);
    mine.parts.forEach(function(p){ var o = find(out.parts, p.id); if(o) o.steps = join(o.steps, p.steps); else out.parts.push(copy(p)); });
    out.episodes = join(theirs.episodes, mine.episodes);
    out.log = join(theirs.log, mine.log).sort(function(x, y){ return x.d < y.d ? -1 : x.d > y.d ? 1 : 0; });
    out.updated = Math.max(theirs.updated || 0, mine.updated || 0);
    return out;
  }
  function canon(o){ return JSON.stringify(o, function(k, v){ if(!v || typeof v !== 'object' || Array.isArray(v)) return v; var s = {}; Object.keys(v).sort().forEach(function(n){ s[n] = v[n]; }); return s; }); }

  function writeLocal(){
    var other = readLocal(); if(other) state = merge(state, other);   // another tab may have saved since this one loaded
    try { localStorage.setItem(KEY, JSON.stringify(state)); saved = true; } catch(e){ saved = false; }
  }
  function push(){
    if(!doc || !cloud) return;   // cloud is true only after the server's own copy has been joined in
    firebase.firestore().runTransaction(function(tx){
      return tx.get(doc).then(function(s){ tx.set(doc, merge(s.exists ? s.data() : null, state)); });
    }).then(function(){ behind = false; note(); }, function(){ behind = true; note(); });
  }
  function save(){
    state.updated = Date.now(); writeLocal(); note();
    clearTimeout(timer); timer = setTimeout(function(){ timer = null; push(); }, 700);
  }
  function part(id){ return find(state.parts, id); }
  function doneCount(p){ return live(p.steps).filter(function(s){ return s.done; }).length; }

  // ---- the painting ----
  var CX = 195, CY = 270, R = 125, HY = CY + 56, SUN = 56, GLAZE = 80, PAPER = '#F7F2EA';
  function at(r, a){ var t = a * Math.PI / 180; return [(CX + r * Math.cos(t)).toFixed(2), (HY + r * Math.sin(t)).toFixed(2)]; }
  function edge(a){ var dy = HY - CY, b = dy * Math.sin(a * Math.PI / 180); return -b + Math.sqrt(b * b - (dy * dy - R * R)); }   // sun to rim
  function sector(r0, r1, a0, a1){
    var p0 = at(r0, a0), p1 = at(r1, a0), p2 = at(r1, a1), p3 = at(r0, a1);
    return 'M' + p0 + ' L' + p1 + ' A' + r1 + ',' + r1 + ' 0 0 1 ' + p2 + ' L' + p3 + ' A' + r0 + ',' + r0 + ' 0 0 0 ' + p0 + ' Z';
  }
  function mix(a, b, t){
    return '#' + [1, 3, 5].map(function(i){ var x = parseInt(a.substr(i, 2), 16), y = parseInt(b.substr(i, 2), 16); return ('0' + Math.round(x + (y - x) * t).toString(16)).slice(-2); }).join('');
  }
  function path(d, fill, more){ return '<path d="' + d + '" fill="' + fill + '"' + (more || '') + '/>'; }
  function label(x, y, text, size, anchor, more){ return '<text x="' + x + '" y="' + y + '" font-size="' + size + '" text-anchor="' + anchor + '"' + (more || '') + '>' + esc(text) + '</text>'; }
  function ray(r, k){
    var p = part(r.id), span = 180 / RAYS.length, a0 = 180 + span * k, a1 = a0 + span, mid = a0 + span / 2, list = live(p.steps), n = list.length, h = '';
    var warm = k % 2 === 0 ? '#FF8A2A' : '#F9A53C';
    h += '<g class="sun-ray" role="button" tabindex="0" data-go="' + r.id + '" aria-label="' + esc(p.name + (n ? ', ' + doneCount(p) + ' of ' + n + ' steps done' : ', no steps yet')) + '"><g clip-path="url(#drDisc)">';
    if(!n) h += path(sector(GLAZE, 320, a0, a1), r.soft);
    else {
      var step = (edge(mid) - GLAZE) / n;
      list.forEach(function(s, i){ h += path(sector(GLAZE + i * step, i === n - 1 ? 320 : GLAZE + (i + 1) * step, a0, a1), s.done ? r.col : r.soft, ' stroke="' + PAPER + '" stroke-width="' + Math.min(1.5, step / 5).toFixed(2) + '"'); });   // thinner lines when steps are many
    }
    h += path(sector(70, GLAZE, a0, a1), mix(r.col, warm, .62)) + path(sector(SUN, 70, a0, a1), mix(r.col, k % 2 ? '#FFB347' : '#FF6F1F', .8));
    var s0 = at(SUN, a0), s1 = at(320, a0), e0 = at(SUN, a1), e1 = at(320, a1);
    h += '<path d="M' + s0 + ' L' + s1 + ' M' + e0 + ' L' + e1 + '" stroke="' + PAPER + '" stroke-width="1.4" fill="none"/></g>';
    // the name, upright, just outside the rim
    var far = edge(mid), ex = +at(far, mid)[0], ey = +at(far, mid)[1], ux = (ex - CX) / R, uy = (ey - CY) / R;
    var x = ex + ux * 9, y = ey + uy * 9, anchor = ux < -.35 ? 'end' : ux > .35 ? 'start' : 'middle', lines = r.label.length;
    if(anchor === 'middle'){ x += ux < -.1 ? -8 : ux > .1 ? 8 : 0; y -= 4 + (lines - 1) * 15; }
    else { y -= (lines - 1) * 7.5 - 3; if(uy < -.5) y -= 5; }
    var wide = 62, left = anchor === 'end' ? x - wide : anchor === 'start' ? x : x - wide / 2;
    h += '<rect class="sun-hit" x="' + left.toFixed(1) + '" y="' + (y - 22).toFixed(1) + '" width="' + wide + '" height="' + Math.max(44, lines * 15 + 18) + '"/>';
    r.label.forEach(function(t, j){ h += label(x.toFixed(1), (y + j * 15).toFixed(1), t, 14.5, anchor, ' class="sun-name"'); });
    return h + '</g>';
  }
  function land(){
    var deep = CY + R - HY, h = '<g clip-path="url(#drDisc)"><g clip-path="url(#drLand)">';
    [[0, 6, '#5F7E2C'], [6, 22, '#1E5148'], [22, 44, '#234E38'], [44, 140, '#17382C']].forEach(function(b){
      h += '<rect x="' + (CX - R) + '" y="' + (HY + b[0]) + '" width="' + 2 * R + '" height="' + (b[1] - b[0]) + '" fill="' + b[2] + '"/>';
    });
    [[GLAZE + 14, '#6E9A36', .34], [GLAZE, '#8DAE35', .42], [SUN, '#D9B62A', .62], [28, '#F2C94A', .55]].forEach(function(g){ h += path(sector(0, g[0], 0, 180), g[1], ' opacity="' + g[2] + '"'); });
    function P(dx, dy){ return (CX + dx) + ',' + (HY + dy * deep / 78).toFixed(1); }
    var gold = 'M' + P(-1, 0) + ' C' + P(-34, 6) + ' ' + P(-30, 12) + ' ' + P(-3, 18) + ' C' + P(22, 24) + ' ' + P(18, 31) + ' ' + P(-14, 43) +
      ' C' + P(-46, 55) + ' ' + P(-60, 66) + ' ' + P(-66, 84) + ' L' + P(2, 84) + ' C' + P(0, 66) + ' ' + P(15, 58) + ' ' + P(38, 46) +
      ' C' + P(62, 32) + ' ' + P(50, 23) + ' ' + P(20, 15) + ' C' + P(-7, 8) + ' ' + P(-6, 4) + ' ' + P(3, 0) + ' Z';
    return h + path(gold, 'url(#drGold)') + path(gold, '#000', ' filter="url(#drBrush)" opacity=".5"') + '</g></g>';
  }
  function chart(){
    var core = part('core');
    var h = '<svg class="sun" viewBox="0 94 390 306" role="group" aria-label="My dreams, drawn as a sunrise">' +
      '<defs><clipPath id="drDisc"><circle cx="' + CX + '" cy="' + CY + '" r="' + R + '"/></clipPath>' +
      '<clipPath id="drLand"><rect x="' + (CX - R) + '" y="' + HY + '" width="' + 2 * R + '" height="' + (CY + R - HY) + '"/></clipPath>' +
      '<linearGradient id="drGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E9C25A"/><stop offset=".45" stop-color="#C69A38"/><stop offset=".7" stop-color="#E3BC55"/><stop offset="1" stop-color="#BC8F31"/></linearGradient>' +
      // still paint texture: nothing here moves
      '<filter id="drPaint" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.09 0.5" numOctaves="3" seed="5"/><feColorMatrix type="saturate" values="0"/></filter>' +
      '<filter id="drBrush" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.55 0.12" numOctaves="2" seed="9" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 0.9  0 0 0 0 0.55  0 0 0 1.6 -0.55" result="g"/><feComposite in="g" in2="SourceAlpha" operator="in"/></filter></defs>';
    RAYS.forEach(function(r, k){ h += ray(r, k); });
    h += land();
    h += '<g class="sun-core" role="button" tabindex="0" data-go="core" aria-label="' + esc('Research, me learning, ' + doneCount(core) + ' of ' + live(core.steps).length + ' courses done') + '">';
    RAYS.forEach(function(r, i){ var span = 180 / RAYS.length, near = Math.abs(i - (RAYS.length - 1) / 2) / ((RAYS.length - 1) / 2); h += path(sector(0, SUN, 180 + span * i, 180 + span * (i + 1)), mix('#FFC14F', '#FF9A2E', near)); });
    h += '<rect x="' + (CX - R) + '" y="' + (CY - R) + '" width="' + 2 * R + '" height="' + 2 * R + '" filter="url(#drPaint)" clip-path="url(#drDisc)" class="sun-grain"/>';
    h += label(CX, HY - 23, 'Research', 23.5, 'middle', ' class="sun-title"') + label(CX, HY - 8, 'me, learning', 13, 'middle', ' class="sun-sub"') + '</g>';
    return h + '</svg>';
  }

  // ---- every dream, written out ----
  function colour(id){ var r = RAYS.filter(function(x){ return x.id === id; })[0]; return r ? r.col : SUNCOL; }
  function field(ep, key, text, big){
    var v = ep[key] || '';
    return '<label class="dl-field"><span>' + text + '</span>' + (big ? '<textarea rows="3" dir="auto" data-ep="' + esc(ep.id) + '" data-key="' + key + '">' + esc(v) + '</textarea>' : '<input type="text" dir="auto" data-ep="' + esc(ep.id) + '" data-key="' + key + '" value="' + esc(v) + '">') + '</label>';
  }
  // something removed can be put back for a day, even after leaving the page
  function recent(x){ return !!(x.at && Date.now() - x.at.gone < 864e5); }
  function backBtn(x, words){
    var c = Array.from(words || '');
    return '<button type="button" class="dl-more" data-back="' + esc(x.id) + '">Put back: <bdi>' + esc(c.length > 30 ? c.slice(0, 30).join('').trim() + '…' : c.join('')) + '</bdi></button>';
  }
  // research, kept track of: one tap adds today; five weeks, with a star on each day she came back to it
  function tracker(){
    var log = live(state.log), byDay = {};
    log.forEach(function(x){ (byDay[x.d] = byDay[x.d] || []).push(x); });
    var today = iso(new Date()), start = new Date().getDay() + 28, cells = '';
    function kind(k){ return KINDS.filter(function(K){ return K.k === k; })[0] || KINDS[0]; }
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function(d){ cells += '<span class="dl-dow" aria-hidden="true">' + d + '</span>'; });
    for(var i = 0; i < 35; i++){
      var date = daysAgo(start - i), key = iso(date), got = byDay[key] || [];
      var say = date.toLocaleDateString(undefined, {day: 'numeric', month: 'short'}) + (got.length ? ': ' + got.map(function(x){ return kind(x.k).word; }).join(', ') : '');
      cells += '<span class="dl-day' + (key === today ? ' today' : '') + (key > today ? ' future' : '') + '" title="' + esc(say) + '"' + (got.length ? ' role="img" aria-label="' + esc(say) + '"' : '') + '>' +
        (got.length ? '<i class="dl-star n' + Math.min(got.length, 3) + '">✦</i>' : '<i class="dl-dim"></i>') + '</span>';
    }
    var h = '<div class="dl-tool"><input type="text" dir="auto" class="dl-what" value="' + esc(drafts.what) + '" placeholder="What was it? (if you like)" aria-label="What was it" autocomplete="off"><div class="dl-kinds">' +
      KINDS.map(function(K){ return '<button type="button" class="dl-btn" data-log="' + K.k + '">' + K.name + '</button>'; }).join('') + '</div><div class="dl-month">' + cells + '</div>';
    var last = log.slice(-5).reverse();
    if(last.length) h += '<ul class="dl-recent">' + last.map(function(x){
      var p = x.d.split('-');
      return '<li><span class="dl-when">' + esc(new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, {day: 'numeric', month: 'short'})) + '</span><span class="dl-did"><b>' + kind(x.k).word + '</b>' + (x.note ? ' <bdi>' + esc(x.note) + '</bdi>' : '') + '</span><button type="button" class="dl-x" data-unlog="' + esc(x.id) + '" aria-label="Remove this entry">✕</button></li>';
    }).join('') + '</ul>';
    var undo = state.log.filter(function(x){ return x.gone && recent(x); }).sort(function(x, y){ return y.at.gone - x.at.gone; })[0];
    if(undo) h += backBtn(undo, kind(undo.k).word + (undo.note ? ' ' + undo.note : ''));
    return h + '<p class="dl-links"><a href="library.html">Library</a><a href="reading.html">Reading list</a><a href="notes.html">Notes</a></p></div>';
  }
  // only an episode with nothing written in it can be removed, and words always bring one back into view
  function blank(ep){ return !(ep.title || ep.places || ep.shots || ep.script); }
  function episodes(){
    var h = '<div class="dl-tool">';
    state.episodes.filter(function(ep){ return !ep.gone || !blank(ep); }).forEach(function(ep, i){
      h += '<div class="dl-ep"><div class="dl-epn">Episode ' + (i + 1) + '</div>' + field(ep, 'title', 'Title') + field(ep, 'places', 'Places to travel and film') + field(ep, 'shots', 'Shots', true) + field(ep, 'script', 'Script', true) +
        (blank(ep) ? '<button type="button" class="dl-more" data-delep="' + esc(ep.id) + '">Remove this empty episode</button>' : '') + '</div>';
    });
    return h + '<button type="button" class="dl-btn" data-newep="1">+ New episode</button></div>';
  }
  function block(p){
    var id = p.id, h = '<section class="dl-part" data-part="' + esc(id) + '" style="--c:' + colour(id) + '"><header><span class="dl-mark" aria-hidden="true"></span><h3 tabindex="-1">' + esc(p.name) + '</h3>' + (p.sub ? '<span class="dl-sub">' + esc(p.sub) + '</span>' : '') + '</header><ul class="dl-steps">';
    (p.steps || []).forEach(function(s){
      if(s.gone){ if(cleared[s.id] || recent(s)) h += '<li>' + backBtn(s, s.t) + '</li>'; return; }
      h += '<li class="' + (s.done ? 'done' : '') + '"><button type="button" class="dl-tick" data-tick="' + esc(s.id) + '" aria-pressed="' + !!s.done + '" aria-label="' + esc((s.done ? 'Done: ' : 'Mark done: ') + s.t) + '"><i></i></button>' +
        '<span class="dl-text" dir="auto" contenteditable="true" role="textbox" aria-label="Step" data-step="' + esc(s.id) + '" data-was="' + esc(s.t) + '">' + esc(s.t) + '</span></li>';
    });
    h += '</ul><div class="dl-actions">';
    if(id === 'core') h += '<button type="button" class="dl-more" data-show="track" aria-expanded="' + tracking + '">Keep track</button>';
    if(id === 'travel') h += '<button type="button" class="dl-more" data-show="eps" aria-expanded="' + scripting + '">Episodes</button>';
    h += adding === id ? '' : '<button type="button" class="dl-more" data-add="1">+ Add a step</button>';
    if(id === 'phd' || id === 'art') h += '<a class="dl-more" href="calls.html">' + (id === 'art' ? 'Find grants' : 'Open calls') + '</a>';
    h += '</div>';
    if(adding === id) h += '<form class="dl-add"><input type="text" dir="auto" name="step" value="' + esc(drafts[id]) + '" placeholder="A new step" aria-label="A new step" autocomplete="off"><button type="submit" class="dl-btn">Add</button></form>';
    if(id === 'core' && tracking) h += tracker();
    if(id === 'travel' && scripting) h += episodes();
    return h + '</section>';
  }
  function list(){
    var order = ['core'].concat(RAYS.map(function(r){ return r.id; }));
    return '<div class="dl-head"><h2>My dreams</h2><span>darker rings are done</span></div>' + order.map(function(id){ return block(part(id)); }).join('') + '<p class="dl-saved"></p>';
  }

  function note(){
    var el = listEl && listEl.querySelector('.dl-saved'); if(!el) return;
    el.textContent = !saved ? 'Not saved on this device' : (cloud && !behind ? '' : 'Saved on this device'); el.classList.toggle('bad', !saved);
  }
  function drawChart(){ chartEl.innerHTML = chart(); }
  function draw(){ drawChart(); listEl.innerHTML = list(); note(); }
  function focus(sel){ var el = listEl.querySelector(sel); if(el) try { el.focus({preventScroll: true}); } catch(e){} }
  function leave(){ var a = document.activeElement; if(a && listEl.contains(a) && a.isContentEditable) a.blur(); }   // saves a step being edited
  function go(id){
    var s = listEl.querySelector('[data-part="' + id + '"]'); if(!s) return;
    focus('[data-part="' + id + '"] h3');
    s.scrollIntoView({block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  }

  function keepWords(){
    var el = document.activeElement; if(!el || !listEl.contains(el) || !el.classList || !el.classList.contains('dl-text')) return;
    var section = el.closest('[data-part]'), p = section && part(section.getAttribute('data-part')), s = p && find(p.steps, el.getAttribute('data-step')), v = el.textContent.trim();
    if(!s || !v || el.textContent === el.getAttribute('data-was')) return;
    el.setAttribute('data-was', el.textContent); if(s.t === v) return; set(s, 't', v); if(s.gone) set(s, 'gone', false); save();
  }

  function bind(){
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'hidden') keepWords(); });
    listEl.addEventListener('paste', function(e){
      var el = e.target.closest && e.target.closest('.dl-text'); if(!el || !e.clipboardData) return;
      e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' '));
    });
    chartEl.addEventListener('click', function(e){ var g = e.target.closest && e.target.closest('[data-go]'); if(g) go(g.getAttribute('data-go')); });
    chartEl.addEventListener('keydown', function(e){
      var g = e.target.closest && e.target.closest('[data-go]');
      if(g && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); go(g.getAttribute('data-go')); }
    });
    listEl.addEventListener('click', function(e){
      var t = e.target.closest ? e.target.closest('[data-tick],[data-add],[data-show],[data-newep],[data-delep],[data-log],[data-unlog],[data-back]') : null; if(!t) return;
      var section = t.closest('[data-part]'), id = section && section.getAttribute('data-part'), p = id && part(id); if(!p) return;
      var here = '[data-part="' + id + '"] ';
      if(t.hasAttribute('data-tick')){
        var sid = t.getAttribute('data-tick'), s = find(p.steps, sid); if(s){ set(s, 'done', t.getAttribute('aria-pressed') !== 'true'); save(); } draw(); return focus(here + '[data-tick="' + sid + '"]');
      }
      if(t.hasAttribute('data-add')){ leave(); adding = id; draw(); var input = listEl.querySelector('.dl-add input'); if(input) input.focus(); return; }
      if(t.hasAttribute('data-show')){
        var which = t.getAttribute('data-show'); leave(); if(which === 'track') tracking = !tracking; else scripting = !scripting; draw(); return focus(here + '[data-show="' + which + '"]');
      }
      if(t.hasAttribute('data-log')){
        var what = listEl.querySelector('.dl-what'), kind = t.getAttribute('data-log');
        state.log.push({id: uid(), d: iso(new Date()), k: kind, note: what ? what.value.trim() : ''});
        delete drafts.what; keepDraft('what'); save(); draw(); return focus('[data-log="' + kind + '"]');
      }
      if(t.hasAttribute('data-unlog')){
        var x = find(state.log, t.getAttribute('data-unlog')); if(x){ set(x, 'gone', true); save(); } return draw();
      }
      if(t.hasAttribute('data-back')){
        var bid = t.getAttribute('data-back'), y = find(p.steps, bid) || find(state.log, bid);
        if(y){ set(y, 'gone', false); delete cleared[bid]; save(); } return draw();
      }
      if(t.hasAttribute('data-delep')){
        var empty = find(state.episodes, t.getAttribute('data-delep')); if(empty && blank(empty)){ set(empty, 'gone', true); save(); } return draw();
      }
      state.episodes.push({id: uid(), title: '', places: '', shots: '', script: ''}); save(); draw();
      var inputs = listEl.querySelectorAll('.dl-ep input'); if(inputs.length) inputs[inputs.length - 2].focus();
    });
    listEl.addEventListener('keydown', function(e){
      var c = e.target.classList; if(!c) return;
      if(c.contains('dl-text') && e.key === 'Enter'){ e.preventDefault(); e.target.blur(); }
      if(c.contains('dl-what') && e.key === 'Enter') e.preventDefault();
      if(e.key === 'Escape' && adding){ var was = adding; leave(); adding = null; draw(); focus('[data-part="' + was + '"] [data-add]'); }   // leave() first: a step being edited keeps its new words
    });
    listEl.addEventListener('submit', function(e){
      e.preventDefault();
      var id = e.target.closest('[data-part]').getAttribute('data-part'), v = e.target.querySelector('input').value.trim(), p = part(id); if(!v || !p) return;
      p.steps.push({id: uid(), t: v, done: false}); delete drafts[id]; keepDraft(id); save(); draw();
      var again = listEl.querySelector('.dl-add input'); if(again) again.focus();
    });
    // a step's words are edited in place; clearing them removes the step
    listEl.addEventListener('focusout', function(e){
      var el = e.target; if(!el.classList || !el.classList.contains('dl-text')) return;
      var section = el.closest('[data-part]'), p = section && part(section.getAttribute('data-part')), s = p && find(p.steps, el.getAttribute('data-step')); if(!s) return;
      if(el.textContent === el.getAttribute('data-was')) return;   // she changed nothing: what is saved (maybe newer) stays
      var v = el.textContent.trim();
      if(!v && !document.hasFocus()) return;   // emptied, then switched window to copy something: wait for her
      if(v){
        el.setAttribute('data-was', el.textContent); if(s.t === v) return;
        set(s, 't', v); if(s.gone) set(s, 'gone', false);
      } else { cleared[s.id] = true; set(s, 'gone', true); el.parentNode.innerHTML = backBtn(s, s.t); }
      save(); setTimeout(drawChart, 250);   // after the tap that took focus away has landed
    });
    listEl.addEventListener('input', function(e){
      var el = e.target;
      if(el.classList && el.classList.contains('dl-what')){ drafts.what = el.value; keepDraft('what'); return; }
      if(el.name === 'step'){ var k = el.closest('[data-part]').getAttribute('data-part'); drafts[k] = el.value; keepDraft(k); return; }
      var id = el.getAttribute && el.getAttribute('data-ep'); if(!id) return;
      var ep = find(state.episodes, id); if(!ep) return;
      set(ep, el.getAttribute('data-key'), el.value); if(ep.gone) set(ep, 'gone', false);
      var rm = el.closest('.dl-ep').querySelector('[data-delep]'); if(rm) rm.hidden = !blank(ep);
      save();
    });
    window.addEventListener('pagehide', function(){ keepWords(); if(timer){ clearTimeout(timer); timer = null; push(); } });
    window.addEventListener('storage', function(e){ if(e.key === KEY) otherTab(); });
    window.addEventListener('pageshow', otherTab);
  }
  function take(next){ if(canon(next) === canon(state)) return false; state = next; return true; }
  function otherTab(){ var other = readLocal(); if(other && take(merge(other, state))) refresh(); }
  // new words arrived from another tab or device: redraw, but never pull a field out from under her
  function refresh(){
    if(!typing()) return draw();
    drawChart();
    Array.prototype.forEach.call(listEl.querySelectorAll('[data-ep]'), function(el){
      var ep = find(state.episodes, el.getAttribute('data-ep')); if(!ep) return;
      var v = ep[el.getAttribute('data-key')] || ''; if(el.value !== v) el.value = v;
    });
    Array.prototype.forEach.call(listEl.querySelectorAll('.dl-text'), function(el){
      var section = el.closest('[data-part]'), p = section && part(section.getAttribute('data-part')), s = p && find(p.steps, el.getAttribute('data-step'));
      if(s && !s.gone && el.textContent === el.getAttribute('data-was') && el.textContent !== s.t){ el.textContent = s.t; el.setAttribute('data-was', s.t); }
    });
    Array.prototype.forEach.call(listEl.querySelectorAll('[data-tick]'), function(el){
      var section = el.closest('[data-part]'), p = section && part(section.getAttribute('data-part')), s = p && find(p.steps, el.getAttribute('data-tick')); if(!s) return;
      el.setAttribute('aria-pressed', !!s.done); el.setAttribute('aria-label', (s.done ? 'Done: ' : 'Mark done: ') + s.t); el.parentNode.className = s.done ? 'done' : '';
    });
  }
  // one copy of this device as it was before it first took anything from the cloud
  function keepCopy(){ try { if(!localStorage.getItem(KEY + '-before-sync')) localStorage.setItem(KEY + '-before-sync', JSON.stringify(state)); } catch(e){} }

  function typing(){ var a = document.activeElement; return !!(a && listEl.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)); }
  function connect(){
    if(!window.firebase || !firebase.apps || !firebase.apps.length) return;
    doc = firebase.firestore().collection('dreams').doc('_state');
    doc.onSnapshot({includeMetadataChanges: true}, function(snap){
      if(snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;   // only the server's own answer counts
      var remote = snap.exists ? snap.data() : null;
      cloud = true;
      if(remote){ keepCopy(); if(take(merge(remote, state))){ writeLocal(); refresh(); } }
      if(state.updated && (!remote || canon(state) !== canon(remote))) push(); else behind = false;
      note();
    }, function(){ cloud = false; note(); });
  }

  function mount(top, below){ if(!top || !below) return; chartEl = top; listEl = below; draw(); bind(); connect(); }
  window.DreamSun = {mount: mount};
})();
