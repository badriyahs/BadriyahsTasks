/* Phone menu: on narrow screens the tab strip becomes a hamburger with the current page's name.
   The tabs themselves are the existing .tabbar links, so every page keeps working as before. */
(function(){
  var bar = document.querySelector('.tabbar'); if(!bar) return;
  var active = bar.querySelector('.tab.active');
  var nav = document.createElement('div'); nav.className = 'navbar-m';
  var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'nav-burger';
  btn.setAttribute('aria-label', 'Menu'); btn.setAttribute('aria-expanded', 'false'); btn.innerHTML = '<i></i><i></i><i></i>';
  var title = document.createElement('span'); title.className = 'nav-title'; title.textContent = active ? active.textContent.trim() : 'Menu';
  nav.appendChild(btn); nav.appendChild(title);
  var scrim = document.createElement('div'); scrim.className = 'nav-scrim';
  bar.id = bar.id || 'site-menu'; btn.setAttribute('aria-controls', bar.id);
  bar.parentNode.insertBefore(nav, bar); document.body.appendChild(scrim);
  function set(open){
    bar.classList.toggle('open', open); scrim.classList.toggle('on', open); btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', String(open));
    if(open){
      document.documentElement.style.setProperty('--navh', nav.offsetHeight + 'px');
      var a = bar.querySelector('.tab.active') || bar.querySelector('.tab'); if(a) try { a.focus({preventScroll: true}); } catch(e){}
    }
  }
  btn.addEventListener('click', function(){ set(!bar.classList.contains('open')); });
  scrim.addEventListener('click', function(){ set(false); });
  bar.addEventListener('click', function(e){ if(e.target.closest && e.target.closest('.tab')) set(false); });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && bar.classList.contains('open')){ set(false); btn.focus(); } });
  window.addEventListener('resize', function(){ if(window.innerWidth > 700) set(false); });
  window.addEventListener('pageshow', function(){ set(false); });
})();

/* A small moon, in today's real phase, beside the page name: the same moon as on the home sky. */
(function(){
  var days = (Date.now() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000, ph = ((days / 29.530588853) % 1 + 1) % 1;
  var r = 38, cx = 50, cy = 50, k = Math.cos(2 * Math.PI * ph), rx = Math.abs(k) * r, waxing = ph < 0.5, lit = '';
  if(ph > 0.02 && ph < 0.98){
    var outer = waxing ? 1 : 0, term = waxing ? (k > 0 ? 0 : 1) : (k > 0 ? 1 : 0);
    lit = '<path d="M ' + cx + ' ' + (cy - r) + ' A ' + r + ' ' + r + ' 0 0 ' + outer + ' ' + cx + ' ' + (cy + r) + ' A ' + rx.toFixed(1) + ' ' + r + ' 0 0 ' + term + ' ' + cx + ' ' + (cy - r) + ' Z" fill="#F4ECFF"/>';
  }
  var svg = '<svg class="mini-moon" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="38" fill="#2b2166" stroke="rgba(201,184,255,.45)" stroke-width="3"/>' + lit + '</svg>';
  [document.querySelector('.topbar h1'), document.querySelector('.nav-title')].forEach(function(t){ if(t) t.insertAdjacentHTML('afterbegin', svg); });
})();
