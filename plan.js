/* The plan chart: reads plan.json (hand-made, regenerated with the plan) and draws it in the night-sky style.
   Used on the home page (a small card: the next 7 days) and on plan.html (everything). */
(function(){
  var KINDS = [
    {k: 'gre', name: 'GRE', cls: 'gre'},
    {k: 'harvard', name: 'Harvard', cls: 'harvard'},
    {k: 'events', name: 'Talks and events', cls: 'events'},
    {k: 'other', name: 'Everything else', cls: 'other'}
  ];
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  function iso(d){ return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function parse(s){ var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dayName(s){ return parse(s).toLocaleDateString(undefined, {weekday: 'short'}); }
  function dayNum(s){ return parse(s).getDate(); }
  function monthName(s){ return parse(s).toLocaleDateString(undefined, {month: 'short'}); }
  function daysTo(s){ var t = new Date(); t = new Date(t.getFullYear(), t.getMonth(), t.getDate()); return Math.round((parse(s) - t) / 86400000); }
  function when(n){ return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? 'passed' : 'in ' + n + ' days'; }
  function hm(m){ return m >= 60 ? (Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '')) : m + ' min'; }
  function bar(day, cap){
    var segs = '', used = 0;
    KINDS.forEach(function(K){
      var m = +day[K.k] || 0; if(!m) return; used += m;
      segs += '<i class="pl-seg pl-' + K.cls + '" style="flex:' + m + ' 1 0" title="' + esc(K.name + ': ' + hm(m)) + '"><b>' + (m >= 40 ? esc(K.name) : '') + '</b></i>';
    });
    var rest = Math.max(0, cap - used);
    if(rest) segs += '<i class="pl-seg pl-rest" style="flex:' + rest + ' 1 0"></i>';
    return '<div class="pl-bar" role="img" aria-label="' + esc(KINDS.map(function(K){ return day[K.k] ? K.name + ' ' + hm(day[K.k]) : ''; }).filter(Boolean).join(', ') || 'Free day') + '">' + segs + '</div>';
  }
  function row(day, cap, today){
    var d = day.date, isToday = d === today, cls = 'pl-row' + (isToday ? ' is-today' : '') + (day.off ? ' is-off' : '');
    return '<div class="' + cls + '"><div class="pl-day"><span>' + esc(dayName(d)) + '</span><b>' + dayNum(d) + '</b></div><div class="pl-main">' + bar(day, day.cap || cap) + (day.what ? '<div class="pl-what">' + esc(day.what) + '</div>' : '') + '</div></div>';
  }
  function legend(){
    return '<div class="pl-legend">' + KINDS.map(function(K){ return '<span><i class="pl-dot pl-' + K.cls + '"></i>' + esc(K.name) + '</span>'; }).join('') + '</div>';
  }
  function dates(P, from, n){
    var out = [], todayISO = iso(new Date());
    var start = from < P.days[0].date ? P.days[0].date : from;
    P.days.forEach(function(d){ if(d.date >= start && out.length < n) out.push(d); });
    return out;
  }
  function homeCard(P){
    var today = iso(new Date()), rows = dates(P, today, 7);
    if(!rows.length) return '';
    var next = (P.milestones || []).filter(function(m){ return m.date >= today; }).slice(0, 3);
    return '<div class="pl-card"><div class="pl-head"><span class="pl-title">The plan</span><a class="pl-more" href="plan.html">Whole plan</a></div>' +
      rows.map(function(d){ return row(d, P.cap || 120, today); }).join('') + legend() +
      (next.length ? '<ul class="pl-next">' + next.map(function(m){ return '<li><b>' + esc(monthName(m.date) + ' ' + dayNum(m.date)) + '</b> ' + esc(m.label) + ' <small>' + when(daysTo(m.date)) + '</small></li>'; }).join('') + '</ul>' : '') + '</div>';
  }
  function fullPage(P){
    var today = iso(new Date()), cap = P.cap || 120, html = '';
    html += '<p class="pl-lead">' + esc(P.lead || '') + '</p>';
    // big dates
    html += '<h2 class="pl-h">The big dates</h2><ol class="pl-miles">' + (P.milestones || []).filter(function(m){ return m.date >= today; }).map(function(m){
      var n = daysTo(m.date);
      return '<li class="pl-m pl-m-' + esc(m.kind || 'other') + '"><span class="pl-md"><b>' + dayNum(m.date) + '</b>' + esc(monthName(m.date)) + '</span><span class="pl-mt">' + esc(m.label) + (m.note ? '<small>' + esc(m.note) + '</small>' : '') + '</span><span class="pl-mn">' + when(n) + '</span></li>';
    }).join('') + '</ol>';
    // weeks
    if(P.weeks && P.weeks.length){
      html += '<h2 class="pl-h">Week by week, in hours</h2><div class="pl-weeks">' + P.weeks.map(function(w){
        var tot = KINDS.reduce(function(s, K){ return s + (w[K.k] || 0); }, 0);
        return '<div class="pl-wk"><div class="pl-wl">' + esc(w.label) + '</div><div class="pl-bar pl-bar-wk">' + KINDS.map(function(K){ var m = w[K.k] || 0; return m ? '<i class="pl-seg pl-' + K.cls + '" style="flex:' + m + ' 1 0" title="' + esc(K.name + ' ' + hm(m)) + '"><b>' + (m >= 180 ? esc(K.name) + ' ' + Math.round(m / 6) / 10 + 'h' : '') + '</b></i>' : ''; }).join('') + '</div><div class="pl-wt">' + Math.round(tot / 6) / 10 + 'h</div></div>';
      }).join('') + '</div>';
    }
    // days
    html += '<h2 class="pl-h">Day by day</h2>' + legend();
    var curMonth = '';
    P.days.forEach(function(d){
      var m = monthName(d.date);
      if(m !== curMonth){ curMonth = m; html += '<h3 class="pl-mon">' + esc(parse(d.date).toLocaleDateString(undefined, {month: 'long', year: 'numeric'})) + '</h3>'; }
      if(d.date >= today) html += row(d, cap, today);
    });
    if(P.notes && P.notes.length) html += '<h2 class="pl-h">Good to know</h2><ul class="pl-notes">' + P.notes.map(function(n){ return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    return html;
  }
  function load(cb){
    try { fetch('plan.json?v=' + (window.PLAN_V || 1)).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){ if(j && j.days) cb(j); }).catch(function(){}); } catch(e){}
  }
  window.PlanChart = {homeCard: homeCard, fullPage: fullPage, load: load};
})();
