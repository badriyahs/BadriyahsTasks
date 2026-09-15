/* Shared data layer + helpers for The Ledger (tasks.html, calendar.html, archive.html) */
window.Ledger = (function(){
  "use strict";

  var firebaseConfig = {
    apiKey: "AIzaSyD5Enp6XOf64EEBnjDf6A2NsKxG_GTW36M",
    authDomain: "badriyahstasks.firebaseapp.com",
    projectId: "badriyahstasks",
    storageBucket: "badriyahstasks.firebasestorage.app",
    messagingSenderId: "97057321631",
    appId: "1:97057321631:web:fa339e1352631ecb9d68aa"
  };

  var CATS = 8;
  function catIndex(name){
    if(!name) return null;
    var h = 0;
    for(var i=0;i<name.length;i++){ h = (h*31 + name.charCodeAt(i)) >>> 0; }
    return h % CATS;
  }
  function catClassStyle(name){
    var idx = catIndex(name);
    if(idx === null) return {bg:'transparent', fg:'var(--muted)'};
    return {bg:'var(--cat'+idx+'-bg)', fg:'var(--cat'+idx+'-fg)'};
  }
  function fmtISO(d){
    var y=d.getFullYear(), m=('0'+(d.getMonth()+1)).slice(-2), day=('0'+d.getDate()).slice(-2);
    return y+'-'+m+'-'+day;
  }
  function todayISO(){ return fmtISO(new Date()); }
  function escapeHTML(s){
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function isURL(s){ return /^https?:\/\//i.test((s||'').trim()); }
  function depthOf(no){ return no ? (no.split('.').length - 1) : 0; }

  var state = { tasks: [] };
  var listeners = [];
  var statusListeners = [];
  var ready = false;

  function notify(){ listeners.forEach(function(fn){ fn(); }); }
  function notifyStatus(kind, text){ statusListeners.forEach(function(fn){ fn(kind, text); }); }

  function onChange(fn){ listeners.push(fn); if(ready) fn(); }
  function onStatus(fn){ statusListeners.push(fn); }

  firebase.initializeApp(firebaseConfig);
  var db = firebase.firestore();
  var tasksCol = db.collection('tasks');
  var activityCol = db.collection('activity');
  var readingCol = db.collection('reading');

  function logActivity(t, verb, extra){
    var doc = {
      actor: 'User',
      verb: verb,
      no: t ? (t.no || '') : '',
      description: t ? (t.description || '') : '',
      at: new Date().toISOString()
    };
    if(extra){ Object.keys(extra).forEach(function(k){ doc[k] = extra[k]; }); }
    activityCol.add(doc).catch(function(e){ console.error(e); });
  }

  // ---------- undo/redo (this browser tab only) ----------
  var undoStack = [], redoStack = [];
  var undoListeners = [];
  function onUndoState(fn){ undoListeners.push(fn); fn({canUndo:undoStack.length>0, canRedo:redoStack.length>0}); }
  function notifyUndoState(){
    undoListeners.forEach(function(fn){ fn({canUndo:undoStack.length>0, canRedo:redoStack.length>0}); });
  }
  function pushUndo(entry){
    undoStack.push(entry);
    redoStack.length = 0;
    notifyUndoState();
  }
  function undo(){
    var entry = undoStack.pop();
    if(!entry) return;
    entry.undo();
    logActivity(null, 'undid', {description: entry.label});
    redoStack.push(entry);
    notifyUndoState();
  }
  function redo(){
    var entry = redoStack.pop();
    if(!entry) return;
    entry.redo();
    logActivity(null, 'redid', {description: entry.label});
    undoStack.push(entry);
    notifyUndoState();
  }

  tasksCol.orderBy('order','asc').onSnapshot(function(snap){
    state.tasks = snap.docs.map(function(d){
      var data = d.data() || {};
      return {
        id: d.id,
        no: data.no || '',
        category: data.category || '',
        description: data.description || '',
        due: data.due || '',
        link: data.link || '',
        dependency: data.dependency || '',
        owner: data.owner || '',
        details: data.details || '',
        order: typeof data.order === 'number' ? data.order : 0,
        archived: !!data.archived,
        struck: !!data.struck
      };
    });
    ready = true;
    notifyStatus('ok', 'Live — anyone with this link can edit');
    notify();
  }, function(err){
    notifyStatus('err', 'Connection error (' + (err && err.code ? err.code : 'unknown') + ') — check Firestore is enabled');
    console.error(err);
  });

  // ---------- reading list (separate collection, simpler flat list) ----------
  var readingState = { items: [] };
  var readingListeners = [];
  var readingStatusListeners = [];
  var readingReady = false;
  function onReadingChange(fn){ readingListeners.push(fn); if(readingReady) fn(); }
  function notifyReading(){ readingListeners.forEach(function(fn){ fn(); }); }
  function onReadingStatus(fn){ readingStatusListeners.push(fn); }
  function notifyReadingStatus(kind, text){ readingStatusListeners.forEach(function(fn){ fn(kind, text); }); }

  var READING_STATUSES = {
    'not-started': {label:'Not started', bg:'transparent', fg:'var(--muted)'},
    'reading':     {label:'Reading',     bg:'var(--accent-tint)', fg:'var(--accent)'},
    'finished':    {label:'Finished',    bg:'var(--cat4-bg)', fg:'var(--cat4-fg)'}
  };

  readingCol.orderBy('order', 'asc').onSnapshot(function(snap){
    readingState.items = snap.docs.map(function(d){
      var data = d.data() || {};
      return {
        id: d.id,
        ref: data.ref || '',
        category: data.category || '',
        title: data.title || '',
        author: data.author || '',
        year: data.year || '',
        pages: data.pages || '',
        priority: data.priority || '',
        status: data.status || 'not-started',
        link: data.link || '',
        note: data.note || '',
        order: typeof data.order === 'number' ? data.order : 0
      };
    });
    readingReady = true;
    notifyReadingStatus('ok', '');
    notifyReading();
  }, function(err){
    notifyReadingStatus('err', 'Reading list needs its Firestore rule added (see chat) — ' + (err && err.code ? err.code : 'error'));
    console.error(err);
  });

  var pendingReadingFocusId = null;
  function focusReadingIdOnce(){ var id = pendingReadingFocusId; pendingReadingFocusId = null; return id; }

  function nextReadingRef(){
    var max = 0;
    readingState.items.forEach(function(r){
      var n = parseInt(r.ref, 10);
      if(!isNaN(n) && n > max) max = n;
    });
    return max + 1;
  }

  function addReadingItem(){
    var maxOrder = readingState.items.reduce(function(m,r){ return Math.max(m, r.order||0); }, 0);
    var data = {ref:String(nextReadingRef()), category:'', title:'', author:'', year:'', pages:'', priority:'', status:'not-started', link:'', note:'', order: maxOrder + 10};
    readingCol.add(data).then(function(ref){
      pendingReadingFocusId = ref.id;
    }).catch(function(e){ console.error(e); });
  }
  function updateReadingField(id, field, value){
    var patch = {}; patch[field] = value;
    readingCol.doc(id).update(patch).catch(function(e){ console.error(e); });
  }
  function setReadingStatus(id, status){
    readingCol.doc(id).update({status: status}).catch(function(e){ console.error(e); });
  }
  function deleteReadingItem(id){
    readingCol.doc(id).delete().catch(function(e){ console.error(e); });
  }

  function readingCellEditableHTML(id, field, value, ph, extraClass){
    return '<div class="cell'+(extraClass?(' '+extraClass):'')+'" contenteditable="true" data-id="'+id+'" data-field="'+field+'" data-ph="'+ph+'">'+escapeHTML(value)+'</div>';
  }

  function readingRowHTML(r, confirmingId){
    var catStyle = catClassStyle(r.category);
    var confirming = confirmingId === r.id;
    var status = READING_STATUSES[r.status] ? r.status : 'not-started';
    var sStyle = READING_STATUSES[status];

    var statusHTML = '<div class="cell rstatus">' +
      '<select data-action="setstatus" data-id="'+r.id+'" style="background:'+sStyle.bg+';color:'+sStyle.fg+'">' +
      Object.keys(READING_STATUSES).map(function(k){
        return '<option value="'+k+'"'+(k===status?' selected':'')+'>'+READING_STATUSES[k].label+'</option>';
      }).join('') +
      '</select></div>';

    var catHTML = '<div class="cell">' +
      '<span class="tag" contenteditable="true" data-id="'+r.id+'" data-field="category" data-ph="—" style="background:'+catStyle.bg+';color:'+catStyle.fg+'">'+escapeHTML(r.category)+'</span>' +
      '</div>';

    var titleHTML = '<div class="cell desc-wrap">' +
      '<div class="desc-text" contenteditable="true" data-id="'+r.id+'" data-field="title" data-ph="Untitled reading">'+escapeHTML(r.title)+'</div>' +
      '</div>';

    var linkHTML = '<div class="cell linkcell">' +
      '<div class="cell-text" contenteditable="true" data-id="'+r.id+'" data-field="link" data-ph="" style="'+(isURL(r.link)?'color:var(--accent);':'')+'">'+escapeHTML(r.link)+'</div>' +
      (isURL(r.link) ? '<a class="linkopen" href="'+escapeHTML(r.link)+'" target="_blank" rel="noopener noreferrer">Open ↗</a>' : '') +
      '</div>';

    var noteHTML = '<div class="cell wrap" contenteditable="true" data-id="'+r.id+'" data-field="note" data-ph="">'+escapeHTML(r.note)+'</div>';

    var actionsHTML = confirming
      ? '<div class="cell rowactions"><button class="confirm" data-action="confirmdel" data-id="'+r.id+'">Delete?</button></div>'
      : '<div class="cell rowactions"><button class="del" data-action="del" data-id="'+r.id+'" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg></button></div>';

    return '<div class="row'+(status==='finished'?' done':'')+'" data-row-id="'+r.id+'">' +
      statusHTML +
      readingCellEditableHTML(r.id,'ref',r.ref,'#','rref') +
      catHTML + titleHTML +
      readingCellEditableHTML(r.id,'author',r.author,'—') +
      readingCellEditableHTML(r.id,'year',r.year,'—','ryear') +
      readingCellEditableHTML(r.id,'pages',r.pages,'—','ryear') +
      readingCellEditableHTML(r.id,'priority',r.priority,'—','rpriority') +
      linkHTML + noteHTML + actionsHTML +
      '</div>';
  }

  // ---------- hierarchy helpers ----------
  function hasChildren(no){
    if(!no) return false;
    var prefix = no + '.';
    return state.tasks.some(function(t){ return !t.archived && t.no && t.no.indexOf(prefix) === 0; });
  }
  function nextTopLevelNumber(){
    var max = 0;
    state.tasks.forEach(function(t){
      if(t.no && t.no.indexOf('.') === -1){
        var n = parseInt(t.no, 10);
        if(!isNaN(n) && n > max) max = n;
      }
    });
    return max + 1;
  }
  function nextChildNumber(parentNo){
    var max = 0;
    var prefix = parentNo + '.';
    state.tasks.forEach(function(t){
      if(t.no && t.no.indexOf(prefix) === 0){
        var rest = t.no.slice(prefix.length);
        if(rest.indexOf('.') === -1){
          var n = parseInt(rest, 10);
          if(!isNaN(n) && n > max) max = n;
        }
      }
    });
    return max + 1;
  }
  function topSegment(no){ return no ? no.split('.')[0] : ''; }
  function topAncestor(no){
    if(!no) return null;
    var seg = topSegment(no);
    return state.tasks.find(function(t){ return t.no === seg; }) || null;
  }
  /* Color a section band by its category text when the section has one
     (so it matches that section's own category tag pill exactly), and
     only fall back to hashing the bare section number for sections that
     were never given a category. */
  function sectionColor(no){
    var top = topAncestor(no);
    var key = (top && top.category) ? top.category : topSegment(no);
    return catClassStyle(key);
  }
  function ancestorTitle(no){
    var top = topAncestor(no);
    return top ? top.description : '';
  }
  function insertOrderForChild(parentTask){
    var list = state.tasks;
    var idx = list.findIndex(function(t){ return t.id === parentTask.id; });
    if(idx === -1) return (list.length ? list[list.length-1].order + 10 : 10);
    var endIdx = idx;
    for(var i = idx+1; i < list.length; i++){
      if(list[i].no && parentTask.no && list[i].no.indexOf(parentTask.no + '.') === 0){ endIdx = i; }
      else break;
    }
    var afterOrder = list[endIdx].order;
    var beforeOrder = (endIdx+1 < list.length) ? list[endIdx+1].order : null;
    return beforeOrder === null ? afterOrder + 10 : (afterOrder + beforeOrder) / 2;
  }

  // ---------- mutations ----------
  var pendingFocusId = null;
  function focusIdOnce(){ var id = pendingFocusId; pendingFocusId = null; return id; }

  function setField(id, field, value){
    var patch = {}; patch[field] = value;
    tasksCol.doc(id).update(patch).catch(function(e){ console.error(e); });
  }

  function updateField(id, field, value){
    var t = state.tasks.find(function(x){ return x.id === id; });
    var oldValue = t ? (t[field] || '') : '';
    if(oldValue === value) return;
    setField(id, field, value);
    logActivity(t, 'edited the ' + field + ' of');
    pushUndo({
      label: 'editing the ' + field + ' of ' + (t && t.no ? t.no : 'a task'),
      undo: function(){ setField(id, field, oldValue); },
      redo: function(){ setField(id, field, value); }
    });
  }

  function addTopLevel(){
    var no = String(nextTopLevelNumber());
    var maxOrder = state.tasks.reduce(function(m,t){ return Math.max(m, t.order||0); }, 0);
    var data = {
      no:no, category:'', description:'', due:'', link:'', dependency:'', owner:'', details:'',
      order: maxOrder + 10, archived:false, struck:false
    };
    tasksCol.add(data).then(function(ref){
      pendingFocusId = ref.id;
      logActivity(data, 'added');
      pushUndo({
        label: 'adding task ' + no,
        undo: function(){ tasksCol.doc(ref.id).delete().catch(function(e){ console.error(e); }); },
        redo: function(){ tasksCol.doc(ref.id).set(data).catch(function(e){ console.error(e); }); }
      });
    }).catch(function(e){ console.error(e); });
  }

  /* Adds a new row at the SAME level as `row`, placed right after it (and
     after everything already nested under it) — e.g. + on 3.1.1 gives
     3.1.2, a sibling, not 3.1.1.1, a child. To go a level deeper, add a
     sibling and then edit its "no" cell by hand to append ".1" — that's
     rare enough not to need its own button. */
  function addSiblingAfter(rowId){
    var row = state.tasks.find(function(t){ return t.id === rowId; });
    if(!row) return;
    var dot = row.no ? row.no.lastIndexOf('.') : -1;
    var parentNo = dot === -1 ? null : row.no.slice(0, dot);
    var newNo = parentNo ? (parentNo + '.' + nextChildNumber(parentNo)) : String(nextTopLevelNumber());
    var ord = insertOrderForChild(row);
    var data = {
      no:newNo, category:'', description:'', due:'', link:'', dependency:'', owner:'', details:'',
      order: ord, archived:false, struck:false
    };
    tasksCol.add(data).then(function(ref){
      pendingFocusId = ref.id;
      logActivity(data, 'added');
      pushUndo({
        label: 'adding ' + newNo,
        undo: function(){ tasksCol.doc(ref.id).delete().catch(function(e){ console.error(e); }); },
        redo: function(){ tasksCol.doc(ref.id).set(data).catch(function(e){ console.error(e); }); }
      });
    }).catch(function(e){ console.error(e); });
  }

  function archiveTask(id){
    var t = state.tasks.find(function(x){ return x.id === id; });
    setField(id, 'archived', true);
    logActivity(t, 'deleted');
    pushUndo({
      label: 'deleting ' + (t && t.no ? t.no : 'a task'),
      undo: function(){ setField(id, 'archived', false); },
      redo: function(){ setField(id, 'archived', true); }
    });
  }
  function restoreTask(id){
    var t = state.tasks.find(function(x){ return x.id === id; });
    setField(id, 'archived', false);
    logActivity(t, 'restored');
    pushUndo({
      label: 'restoring ' + (t && t.no ? t.no : 'a task'),
      undo: function(){ setField(id, 'archived', true); },
      redo: function(){ setField(id, 'archived', false); }
    });
  }
  function deleteTask(id){
    var t = state.tasks.find(function(x){ return x.id === id; });
    if(!t) return;
    var data = {
      no:t.no, category:t.category, description:t.description, due:t.due, link:t.link,
      dependency:t.dependency, owner:t.owner, details:t.details, order:t.order,
      archived:t.archived, struck:t.struck
    };
    tasksCol.doc(id).delete().catch(function(e){ console.error(e); });
    logActivity(t, 'permanently deleted');
    pushUndo({
      label: 'permanently deleting ' + (t.no || 'a task'),
      undo: function(){ tasksCol.doc(id).set(data).catch(function(e){ console.error(e); }); },
      redo: function(){ tasksCol.doc(id).delete().catch(function(e){ console.error(e); }); }
    });
  }
  function toggleStrike(id){
    var t = state.tasks.find(function(x){ return x.id === id; });
    if(!t) return;
    var was = !!t.struck;
    setField(id, 'struck', !was);
    logActivity(t, was ? 'un-struck' : 'struck through');
    pushUndo({
      label: 'striking through ' + (t.no || 'a task'),
      undo: function(){ setField(id, 'struck', was); },
      redo: function(){ setField(id, 'struck', !was); }
    });
  }

  // ---------- shared topbar wiring (undo/redo) ----------
  function wireTopbar(){
    var undoBtn = document.getElementById('undobtn');
    var redoBtn = document.getElementById('redobtn');
    if(undoBtn){ undoBtn.addEventListener('click', undo); }
    if(redoBtn){ redoBtn.addEventListener('click', redo); }
    onUndoState(function(st){
      if(undoBtn) undoBtn.disabled = !st.canUndo;
      if(redoBtn) redoBtn.disabled = !st.canRedo;
    });
    document.addEventListener('keydown', function(e){
      var mod = e.metaKey || e.ctrlKey;
      if(!mod) return;
      var k = e.key.toLowerCase();
      if(k === 'z' && !e.shiftKey){ e.preventDefault(); undo(); }
      else if((k === 'z' && e.shiftKey) || k === 'y'){ e.preventDefault(); redo(); }
    });
  }

  // ---------- shared editing wiring ----------
  /* Text-offset based insert: robust across browsers/automation, doesn't
     depend on a live Selection range surviving between events. */
  function caretOffset(el){
    var sel = window.getSelection();
    if(!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return el.textContent.length;
    var pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return pre.toString().length;
  }
  function setCaretOffset(el, offset){
    var sel = window.getSelection();
    var range = document.createRange();
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var node, pos = 0;
    while((node = walker.nextNode())){
      var len = node.textContent.length;
      if(pos + len >= offset){
        range.setStart(node, offset - pos);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      pos += len;
    }
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function insertTextInEl(el, text){
    var offset = caretOffset(el);
    var full = el.textContent;
    el.textContent = full.slice(0, offset) + text + full.slice(offset);
    setCaretOffset(el, offset + text.length);
  }

  function wireEditing(container, updateFn){
    updateFn = updateFn || updateField;
    container.addEventListener('focusout', function(e){
      var el = e.target;
      /* A re-render replaces the whole sheet's innerHTML, which blurs any
         focused cell as a side effect of removing it from the document.
         That is NOT the user leaving the field — ignore it, or every write
         re-renders, re-blurs the (still-focused, now-detached) old node,
         and writes again forever. Only act on a real blur: el still connected. */
      if(!el.isConnected) return;
      if(el.matches && el.matches('[contenteditable="true"]')){
        updateFn(el.dataset.id, el.dataset.field, el.textContent.trim());
      }
    });
    container.addEventListener('keydown', function(e){
      var el = e.target;
      if(!(el.matches && el.matches('[contenteditable="true"]'))) return;
      if(e.key === 'Enter'){
        e.preventDefault();
        if(el.dataset.field === 'details' || el.dataset.field === 'note'){
          insertTextInEl(el, '\n• ');
        } else {
          el.blur();
        }
      }
    });
    container.addEventListener('paste', function(e){
      var el = e.target;
      if(el.matches && el.matches('[contenteditable="true"]')){
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text/plain');
        insertTextInEl(el, text);
      }
    });
    container.addEventListener('change', function(e){
      if(e.target.matches && e.target.matches('input[type="date"]')){
        updateFn(e.target.dataset.id, e.target.dataset.field, e.target.value);
      }
    });
  }

  function preserveFocus(container, rebuild){
    var active = document.activeElement;
    var info = null;
    if(active && container.contains(active) && active.matches){
      if(active.matches('[contenteditable="true"]')){
        info = {id: active.dataset.id, field: active.dataset.field, isDate:false};
      } else if(active.matches('input[type="date"]')){
        info = {id: active.dataset.id, field: active.dataset.field, isDate:true};
      }
    }
    rebuild();
    if(info){
      var sel = info.isDate
        ? 'input[type="date"][data-id="'+info.id+'"][data-field="'+info.field+'"]'
        : '[data-id="'+info.id+'"][data-field="'+info.field+'"][contenteditable="true"]';
      var el = container.querySelector(sel);
      if(el){
        el.focus();
        if(!info.isDate){
          var range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          var s = window.getSelection();
          s.removeAllRanges();
          s.addRange(range);
        }
      }
    }
  }

  // ---------- shared row markup ----------
  function cellEditableHTML(id, field, value, ph, extraClass){
    return '<div class="cell'+(extraClass?(' '+extraClass):'')+'" contenteditable="true" data-id="'+id+'" data-field="'+field+'" data-ph="'+ph+'">'+escapeHTML(value)+'</div>';
  }

  function rowHTML(t, mode, confirmingId){
    var depth = depthOf(t.no);
    var isMain = depth === 0;
    var catStyle = catClassStyle(t.category);
    var overdue = t.due && t.due < todayISO() && !t.archived;
    var confirming = confirmingId === t.id;
    var rowClasses = 'row' + (isMain?' main':' sub') + (t.archived?' archived':'') + (t.struck?' struck':'');
    var band = sectionColor(t.no);
    var rowStyle = ' style="--row-band:'+band.bg+';--row-band-fg:'+band.fg+'"';

    var catHTML = '<div class="cell" data-id="'+t.id+'">' +
      '<span class="tag" contenteditable="true" data-id="'+t.id+'" data-field="category" data-ph="—" style="background:'+catStyle.bg+';color:'+catStyle.fg+'">'+escapeHTML(t.category)+'</span>' +
      '</div>';

    var bulletHTML = depth>0 ? '<span class="bullet">'+(depth>1?'∙':'–')+'</span>' : '';
    var descHTML = '<div class="cell desc-wrap" style="padding-left:'+(10+depth*18)+'px">' + bulletHTML +
      '<div class="desc-text" contenteditable="true" data-id="'+t.id+'" data-field="description" data-ph="Untitled task">'+escapeHTML(t.description)+'</div>' +
      '</div>';

    var linkHTML = '<div class="cell linkcell">' +
      '<div class="cell-text" contenteditable="true" data-id="'+t.id+'" data-field="link" data-ph="" style="'+(isURL(t.link)?'color:var(--accent);':'')+'">'+escapeHTML(t.link)+'</div>' +
      (isURL(t.link) ? '<a class="linkopen" href="'+escapeHTML(t.link)+'" target="_blank" rel="noopener noreferrer">Open ↗</a>' : '') +
      '</div>';

    var dateHTML = '<div class="cell datecell'+(overdue?' overdue':'')+'">' +
      '<input type="date" data-id="'+t.id+'" data-field="due" value="'+escapeHTML(t.due)+'"'+(!t.due?' class="empty"':'')+'>' +
      '</div>';

    var actionsHTML;
    if(mode === 'archived'){
      if(confirming){
        actionsHTML = '<div class="cell rowactions"><button class="confirm" data-action="confirmdel" data-id="'+t.id+'">Delete?</button></div>';
      } else {
        actionsHTML = '<div class="cell rowactions">' +
          '<button class="restore" data-action="restore" data-id="'+t.id+'" title="Restore"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg></button>' +
          '<button class="del" data-action="del" data-id="'+t.id+'" title="Delete permanently"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg></button>' +
          '</div>';
      }
    } else {
      actionsHTML = '<div class="cell rowactions">' +
        '<button data-action="addsub" data-id="'+t.id+'" title="Add a row after this one"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg></button>' +
        '<button data-action="strike" data-id="'+t.id+'" title="'+(t.struck?'Remove strikethrough':'Cross out (stays in Tasks)')+'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 12h14"/></svg></button>' +
        '<button data-action="archive" data-id="'+t.id+'" title="Delete (moves to Archive)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg></button>' +
        '</div>';
    }

    return '<div class="'+rowClasses+'" data-row-id="'+t.id+'"'+rowStyle+'>' +
      cellEditableHTML(t.id,'no',t.no,'—','no') +
      catHTML +
      descHTML +
      dateHTML +
      linkHTML +
      cellEditableHTML(t.id,'dependency',t.dependency,'') +
      cellEditableHTML(t.id,'owner',t.owner,'') +
      cellEditableHTML(t.id,'details',t.details,'','wrap') +
      actionsHTML +
      '</div>';
  }

  return {
    state: state,
    onChange: onChange,
    onStatus: onStatus,
    updateField: updateField,
    addTopLevel: addTopLevel,
    addSiblingAfter: addSiblingAfter,
    archiveTask: archiveTask,
    restoreTask: restoreTask,
    deleteTask: deleteTask,
    toggleStrike: toggleStrike,
    hasChildren: hasChildren,
    depthOf: depthOf,
    catClassStyle: catClassStyle,
    sectionColor: sectionColor,
    topSegment: topSegment,
    ancestorTitle: ancestorTitle,
    escapeHTML: escapeHTML,
    isURL: isURL,
    fmtISO: fmtISO,
    todayISO: todayISO,
    focusIdOnce: focusIdOnce,
    rowHTML: rowHTML,
    activityCol: activityCol,
    undo: undo,
    redo: redo,
    onUndoState: onUndoState,
    wireTopbar: wireTopbar,
    wireEditing: wireEditing,
    preserveFocus: preserveFocus,
    readingState: readingState,
    onReadingChange: onReadingChange,
    onReadingStatus: onReadingStatus,
    addReadingItem: addReadingItem,
    updateReadingField: updateReadingField,
    setReadingStatus: setReadingStatus,
    deleteReadingItem: deleteReadingItem,
    focusReadingIdOnce: focusReadingIdOnce,
    readingRowHTML: readingRowHTML
  };
})();
