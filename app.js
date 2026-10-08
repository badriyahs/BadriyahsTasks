/* Shared data layer + helpers for Badriyah's Tasks (index/calendar/archive/activity/reading/notes/events) */
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
  function topSegment(no){ return no ? no.split('.')[0] : ''; }

  firebase.initializeApp(firebaseConfig);
  var db = firebase.firestore();
  var activityCol = db.collection('activity');

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

  function cellEditableHTML(id, field, value, ph, extraClass){
    return '<div class="cell'+(extraClass?(' '+extraClass):'')+'" contenteditable="true" data-id="'+id+'" data-field="'+field+'" data-ph="'+ph+'">'+escapeHTML(value)+'</div>';
  }

  /* A hierarchical, colored sheet of rows (No./Category/Description/Due/
     Link/Dependency/Owner/Details), identical machinery for both the
     Tasks collection and the Events collection — each gets its own
     live state, undo/redo stack, and numbering, just pointed at a
     different Firestore collection. `deleteMode` picks what the trash
     button on an active row does: 'archive' (Tasks has an Archive page
     to land in) or 'permanent' (Events doesn't, so trash asks first and
     deletes for good). */
  function makeTaskStore(colRef, opts){
    opts = opts || {};
    var deleteMode = opts.deleteMode || 'archive';

    var state = { tasks: [] };
    var listeners = [];
    var statusListeners = [];
    var ready = false;
    function notify(){ listeners.forEach(function(fn){ fn(); }); }
    function notifyStatus(kind, text){ statusListeners.forEach(function(fn){ fn(kind, text); }); }
    function onChange(fn){ listeners.push(fn); if(ready) fn(); }
    function onStatus(fn){ statusListeners.push(fn); }

    var undoStack = [], redoStack = [];
    var undoListeners = [];
    function onUndoState(fn){ undoListeners.push(fn); fn({canUndo:undoStack.length>0, canRedo:redoStack.length>0}); }
    function notifyUndoState(){
      undoListeners.forEach(function(fn){ fn({canUndo:undoStack.length>0, canRedo:redoStack.length>0}); });
    }
    function pushUndo(entry){ undoStack.push(entry); redoStack.length = 0; notifyUndoState(); }
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

    colRef.orderBy('order','asc').onSnapshot(function(snap){
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

    // ---------- hierarchy helpers (scoped to this store's own rows) ----------
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
    function topAncestor(no){
      if(!no) return null;
      var seg = topSegment(no);
      return state.tasks.find(function(t){ return t.no === seg; }) || null;
    }
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
      colRef.doc(id).update(patch).catch(function(e){ console.error(e); });
    }

    function updateField(id, field, value){
      var t = state.tasks.find(function(x){ return x.id === id; });
      var oldValue = t ? (t[field] || '') : '';
      if(oldValue === value) return;
      setField(id, field, value);
      logActivity(t, 'edited the ' + field + ' of');
      pushUndo({
        label: 'editing the ' + field + ' of ' + (t && t.no ? t.no : 'a row'),
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
      colRef.add(data).then(function(ref){
        pendingFocusId = ref.id;
        logActivity(data, 'added');
        pushUndo({
          label: 'adding ' + no,
          undo: function(){ colRef.doc(ref.id).delete().catch(function(e){ console.error(e); }); },
          redo: function(){ colRef.doc(ref.id).set(data).catch(function(e){ console.error(e); }); }
        });
      }).catch(function(e){ console.error(e); });
    }

    /* Adds a new row at the SAME level as `row`, placed right after it (and
       after everything already nested under it) — e.g. + on 3.1.1 gives
       3.1.2, a sibling, not 3.1.1.1, a child. To go a level deeper, add a
       sibling and then edit its "no" cell by hand to append ".1". */
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
      colRef.add(data).then(function(ref){
        pendingFocusId = ref.id;
        logActivity(data, 'added');
        pushUndo({
          label: 'adding ' + newNo,
          undo: function(){ colRef.doc(ref.id).delete().catch(function(e){ console.error(e); }); },
          redo: function(){ colRef.doc(ref.id).set(data).catch(function(e){ console.error(e); }); }
        });
      }).catch(function(e){ console.error(e); });
    }

    /* Creates a fully filled-in row in one go (used by the quick-add bar and
       the Today assistant), as a new top-level item or as the next child of
       `parentId`. Resolves with the new doc's id. */
    function addWith(fields, parentId){
      var parent = parentId ? state.tasks.find(function(t){ return t.id === parentId; }) : null;
      if(parentId && !parent) return Promise.reject(new Error('parent not found'));
      var no = parent ? (parent.no + '.' + nextChildNumber(parent.no)) : String(nextTopLevelNumber());
      var ord = parent ? insertOrderForChild(parent) : state.tasks.reduce(function(m,t){ return Math.max(m, t.order||0); }, 0) + 10;
      var data = {
        no:no, category:'', description:'', due:'', link:'', dependency:'', owner:'', details:'',
        order: ord, archived:false, struck:false
      };
      Object.keys(fields || {}).forEach(function(k){ if(k !== 'no' && k !== 'order') data[k] = fields[k]; });
      return colRef.add(data).then(function(ref){
        logActivity(data, 'added');
        pushUndo({
          label: 'adding ' + no,
          undo: function(){ colRef.doc(ref.id).delete().catch(function(e){ console.error(e); }); },
          redo: function(){ colRef.doc(ref.id).set(data).catch(function(e){ console.error(e); }); }
        });
        return {id: ref.id, no: no};
      });
    }
    function addTaskWith(fields){ return addWith(fields, null); }
    function addChildWith(parentId, fields){ return addWith(fields, parentId); }

    function archiveTask(id){
      var t = state.tasks.find(function(x){ return x.id === id; });
      setField(id, 'archived', true);
      logActivity(t, 'deleted');
      pushUndo({
        label: 'deleting ' + (t && t.no ? t.no : 'a row'),
        undo: function(){ setField(id, 'archived', false); },
        redo: function(){ setField(id, 'archived', true); }
      });
    }
    function restoreTask(id){
      var t = state.tasks.find(function(x){ return x.id === id; });
      setField(id, 'archived', false);
      logActivity(t, 'restored');
      pushUndo({
        label: 'restoring ' + (t && t.no ? t.no : 'a row'),
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
      colRef.doc(id).delete().catch(function(e){ console.error(e); });
      logActivity(t, 'permanently deleted');
      pushUndo({
        label: 'permanently deleting ' + (t.no || 'a row'),
        undo: function(){ colRef.doc(id).set(data).catch(function(e){ console.error(e); }); },
        redo: function(){ colRef.doc(id).delete().catch(function(e){ console.error(e); }); }
      });
    }
    function toggleStrike(id){
      var t = state.tasks.find(function(x){ return x.id === id; });
      if(!t) return;
      var was = !!t.struck;
      setField(id, 'struck', !was);
      logActivity(t, was ? 'un-struck' : 'struck through');
      pushUndo({
        label: 'striking through ' + (t.no || 'a row'),
        undo: function(){ setField(id, 'struck', was); },
        redo: function(){ setField(id, 'struck', !was); }
      });
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
        '<div class="desc-text" contenteditable="true" data-id="'+t.id+'" data-field="description" data-ph="Untitled">'+escapeHTML(t.description)+'</div>' +
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
      } else if(confirming){
        actionsHTML = '<div class="cell rowactions"><button class="confirm" data-action="confirmdel" data-id="'+t.id+'">Delete?</button></div>';
      } else {
        var trashBtn = deleteMode === 'permanent'
          ? '<button class="del" data-action="del" data-id="'+t.id+'" title="Delete permanently"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg></button>'
          : '<button data-action="archive" data-id="'+t.id+'" title="Delete (moves to Archive)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg></button>';
        actionsHTML = '<div class="cell rowactions">' +
          '<button data-action="addsub" data-id="'+t.id+'" title="Add a row after this one"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg></button>' +
          '<button data-action="strike" data-id="'+t.id+'" title="'+(t.struck?'Remove strikethrough':'Cross out (stays visible)')+'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 12h14"/></svg></button>' +
          trashBtn +
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
      addTaskWith: addTaskWith,
      addChildWith: addChildWith,
      archiveTask: archiveTask,
      restoreTask: restoreTask,
      deleteTask: deleteTask,
      toggleStrike: toggleStrike,
      hasChildren: hasChildren,
      sectionColor: sectionColor,
      ancestorTitle: ancestorTitle,
      focusIdOnce: focusIdOnce,
      rowHTML: rowHTML,
      undo: undo,
      redo: redo,
      onUndoState: onUndoState,
      deleteMode: deleteMode
    };
  }

  var Tasks = makeTaskStore(db.collection('tasks'), {deleteMode:'archive'});
  var Events = makeTaskStore(db.collection('events'), {deleteMode:'permanent'});

  // ---------- reading list (separate collection, simpler flat list) ----------
  var readingCol = db.collection('reading');
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
        kind: data.kind === 'podcast' ? 'podcast' : 'read',
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

  function addReadingItem(kind){
    var maxOrder = readingState.items.reduce(function(m,r){ return Math.max(m, r.order||0); }, 0);
    var data = {ref:String(nextReadingRef()), category:'', title:'', author:'', year:'', pages:'', priority:'', status:'not-started', link:'', note:'', kind: kind === 'podcast' ? 'podcast' : 'read', order: maxOrder + 10};
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

  /* ---------- podcasts (live in the same "reading" collection, kind: 'podcast') ---------- */
  var PODCAST_STATUSES = {
    'not-started': {label:'To listen',  bg:'transparent', fg:'var(--muted)'},
    'reading':     {label:'Listening',  bg:'var(--accent-tint)', fg:'var(--accent)'},
    'finished':    {label:'Listened',   bg:'var(--cat4-bg)', fg:'var(--cat4-fg)'}
  };
  function platformFor(url){
    var host = '';
    try { host = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, ''); } catch(e){ return ''; }
    if(/(^|\.)spotify\.com$/.test(host)) return 'Spotify';
    if(host === 'podcasts.apple.com') return 'Apple Podcasts';
    if(host === 'youtube.com' || host === 'youtu.be') return 'YouTube';
    if(host === 'soundcloud.com') return 'SoundCloud';
    if(host === 'overcast.fm') return 'Overcast';
    return host;
  }
  /* One podcast per line: "Title - https://link", or just a link, or just a title. */
  function parsePodcastLines(text){
    return String(text || '').split(/\r?\n/).map(function(line){
      line = line.trim();
      if(!line) return null;
      var m = /https?:\/\/\S+/.exec(line);
      var url = m ? m[0].replace(/[)\].,;]+$/, '') : '';
      var title = line.replace(m ? m[0] : '', ' ').replace(/\s+/g, ' ').replace(/^[\s\-–—|:•*>]+|[\s\-–—|:•*(\[]+$/g, '');
      return {title: title, link: url, category: url ? platformFor(url) : ''};
    }).filter(Boolean);
  }
  function fillIfEmpty(id, patch){
    var cur = readingState.items.find(function(r){ return r.id === id; });
    if(!cur) return;
    var out = {};
    Object.keys(patch).forEach(function(k){ if(patch[k] && !cur[k]) out[k] = patch[k]; });
    if(Object.keys(out).length) readingCol.doc(id).update(out).catch(function(e){ console.error(e); });
  }
  /* Best effort only: YouTube and Apple Podcasts allow looking a link up from the
     browser; Spotify doesn't, so those titles are typed by hand. */
  function enrichPodcast(id, url){
    var u; try { u = new URL(url); } catch(e){ return; }
    var host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if(host === 'youtube.com' || host === 'youtu.be'){
      fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url))
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){ if(j) fillIfEmpty(id, {title: j.title, author: j.author_name}); })
        .catch(function(){});
    } else if(host === 'podcasts.apple.com'){
      var m = /\/id(\d+)/.exec(u.pathname), ep = u.searchParams.get('i');
      if(!m) return;
      fetch('https://itunes.apple.com/lookup?id=' + m[1] + '&entity=podcastEpisode&limit=200')
        .then(function(r){ return r.json(); })
        .then(function(j){
          var results = j.results || [], show = results.filter(function(x){ return x.kind === 'podcast'; })[0];
          var epr = ep ? results.filter(function(x){ return String(x.trackId) === ep; })[0] : null;
          var patch = {};
          if(show) patch.author = show.collectionName;
          if(epr){
            patch.title = epr.trackName;
            if(epr.trackTimeMillis) patch.pages = Math.round(epr.trackTimeMillis / 60000) + ' min';
          } else if(show && !ep){
            patch.title = show.collectionName;
          }
          fillIfEmpty(id, patch);
        }).catch(function(){});
    }
  }
  function addPodcasts(text){
    var lines = parsePodcastLines(text);
    if(!lines.length) return Promise.resolve([]);
    var maxOrder = readingState.items.reduce(function(m, r){ return Math.max(m, r.order || 0); }, 0);
    var ref = nextReadingRef();
    var batch = db.batch(), refs = [];
    lines.forEach(function(l, i){
      var docRef = readingCol.doc();
      refs.push({id: docRef.id, link: l.link});
      batch.set(docRef, {
        ref: String(ref + i), category: l.category, title: l.title, author: '', year: '', pages: '', priority: '',
        status: 'not-started', link: l.link, note: '', kind: 'podcast', order: maxOrder + 10 * (i + 1)
      });
    });
    return batch.commit().then(function(){
      refs.forEach(function(r){ if(r.link) setTimeout(function(){ enrichPodcast(r.id, r.link); }, 600); });
      return refs;
    });
  }
  function podcastRowHTML(r, confirmingId){
    var confirming = confirmingId === r.id;
    var status = PODCAST_STATUSES[r.status] ? r.status : 'not-started';
    var sStyle = PODCAST_STATUSES[status];
    var catStyle = catClassStyle(r.category);
    var statusHTML = '<div class="cell rstatus p-status">' +
      '<select data-action="setstatus" data-id="'+r.id+'" style="background:'+sStyle.bg+';color:'+sStyle.fg+'">' +
      Object.keys(PODCAST_STATUSES).map(function(k){
        return '<option value="'+k+'"'+(k===status?' selected':'')+'>'+PODCAST_STATUSES[k].label+'</option>';
      }).join('') + '</select></div>';
    var srcHTML = '<div class="cell p-src"><span class="tag" contenteditable="true" data-id="'+r.id+'" data-field="category" data-ph="source" style="background:'+catStyle.bg+';color:'+catStyle.fg+'">'+escapeHTML(r.category)+'</span></div>';
    var titleHTML = '<div class="cell desc-wrap p-title"><div class="desc-text" contenteditable="true" data-id="'+r.id+'" data-field="title" data-ph="Add the episode title">'+escapeHTML(r.title)+'</div></div>';
    var linkHTML = '<div class="cell linkcell p-link">' +
      (isURL(r.link) ? '<a class="linkopen" href="'+escapeHTML(r.link)+'" target="_blank" rel="noopener noreferrer">Listen ↗</a>' : '') +
      '<div class="cell-text" contenteditable="true" data-id="'+r.id+'" data-field="link" data-ph="paste link" style="'+(isURL(r.link)?'color:var(--muted);':'')+'">'+escapeHTML(r.link)+'</div>' +
      '</div>';
    var actionsHTML = confirming
      ? '<div class="cell rowactions p-del"><button class="confirm" data-action="confirmdel" data-id="'+r.id+'">Delete?</button></div>'
      : '<div class="cell rowactions p-del"><button class="del" data-action="del" data-id="'+r.id+'" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg></button></div>';
    return '<div class="row'+(status==='finished'?' done':'')+'" data-row-id="'+r.id+'">' +
      statusHTML + srcHTML + titleHTML +
      readingCellEditableHTML(r.id,'author',r.author,'show','p-show') +
      readingCellEditableHTML(r.id,'pages',r.pages,'length','ryear p-len') +
      linkHTML +
      readingCellEditableHTML(r.id,'note',r.note,'notes','wrap p-note') +
      actionsHTML +
      '</div>';
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

  // ---------- notes (brain dump — plain text blocks, no status/dates) ----------
  var notesCol = db.collection('notes');
  var notesState = { items: [] };
  var notesListeners = [];
  var notesStatusListeners = [];
  var notesReady = false;
  function onNotesChange(fn){ notesListeners.push(fn); if(notesReady) fn(); }
  function notifyNotes(){ notesListeners.forEach(function(fn){ fn(); }); }
  function onNotesStatus(fn){ notesStatusListeners.push(fn); }
  function notifyNotesStatus(kind, text){ notesStatusListeners.forEach(function(fn){ fn(kind, text); }); }

  notesCol.orderBy('order', 'asc').onSnapshot(function(snap){
    notesState.items = snap.docs.map(function(d){
      var data = d.data() || {};
      return { id: d.id, text: data.text || '', order: typeof data.order === 'number' ? data.order : 0 };
    });
    notesReady = true;
    notifyNotesStatus('ok', '');
    notifyNotes();
  }, function(err){
    notifyNotesStatus('err', 'Notes need their Firestore rule added — ' + (err && err.code ? err.code : 'error'));
    console.error(err);
  });

  var pendingNoteFocusId = null;
  function focusNoteIdOnce(){ var id = pendingNoteFocusId; pendingNoteFocusId = null; return id; }

  function addNote(){
    var maxOrder = notesState.items.reduce(function(m,n){ return Math.max(m, n.order||0); }, 0);
    notesCol.add({ text: '', order: maxOrder + 10 }).then(function(ref){
      pendingNoteFocusId = ref.id;
    }).catch(function(e){ console.error(e); });
  }
  function updateNoteText(id, field, value){
    notesCol.doc(id).update({ text: value }).catch(function(e){ console.error(e); });
  }
  function deleteNote(id){
    notesCol.doc(id).delete().catch(function(e){ console.error(e); });
  }

  function noteCardHTML(n){
    return '<div class="notecard" data-row-id="'+n.id+'">' +
      '<div class="note-text" contenteditable="true" data-id="'+n.id+'" data-field="text" data-ph="Type a note…">'+escapeHTML(n.text)+'</div>' +
      '<button class="note-del" data-action="delnote" data-id="'+n.id+'" title="Delete note"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg></button>' +
      '</div>';
  }

  // ---------- calls (paper calls + awards/grants/residencies — read-mostly, seeded data) ----------
  var callsCol = db.collection('calls');
  var callsMetaCol = db.collection('calls_meta');
  var callsState = { items: [], meta: null };
  var callsListeners = [];
  var callsStatusListeners = [];
  function onCallsChange(fn){ callsListeners.push(fn); }
  function notifyCalls(){ callsListeners.forEach(function(fn){ fn(); }); }
  function onCallsStatus(fn){ callsStatusListeners.push(fn); }
  function notifyCallsStatus(kind, text){ callsStatusListeners.forEach(function(fn){ fn(kind, text); }); }

  callsCol.onSnapshot(function(snap){
    callsState.items = snap.docs.map(function(d){
      var data = d.data() || {};
      return Object.assign({id: d.id}, data);
    });
    notifyCallsStatus('ok', 'Live — anyone with this link can edit');
    notifyCalls();
  }, function(err){
    notifyCallsStatus('err', 'Calls need their Firestore rule added — ' + (err && err.code ? err.code : 'error'));
    console.error(err);
  });

  callsMetaCol.doc('status').onSnapshot(function(doc){
    callsState.meta = doc.exists ? doc.data() : null;
    notifyCalls();
  }, function(err){ console.error(err); });

  function daysUntil(iso){
    if(!iso) return null;
    var today = new Date(todayISO() + 'T00:00:00');
    var d = new Date(iso + 'T00:00:00');
    return Math.round((d - today) / 86400000);
  }
  function callLinkHref(link){
    if(!link) return '';
    return /^https?:\/\//i.test(link) ? link : 'https://' + link;
  }

  /* Picking "Planning" on a call creates a matching task in her normal Tasks
     list (category "Calls") so it shows up in her everyday workflow — but
     only the first time, tracked via linkedTaskId, so toggling the dropdown
     back and forth doesn't spawn duplicate tasks. This never runs from the
     automated weekly refresh, only from her own dropdown click. */
  function nextTopLevelTaskNo(){
    var max = 0;
    Tasks.state.tasks.forEach(function(t){
      if(t.no && t.no.indexOf('.') === -1){
        var n = parseInt(t.no, 10);
        if(!isNaN(n) && n > max) max = n;
      }
    });
    return String(max + 1);
  }
  function nextTopLevelTaskOrder(){
    var max = 0;
    Tasks.state.tasks.forEach(function(t){ if(typeof t.order === 'number' && t.order > max) max = t.order; });
    return max + 10;
  }
  function createTaskFromCall(call){
    return db.collection('tasks').add({
      no: nextTopLevelTaskNo(),
      category: 'Calls',
      description: call.name || '',
      due: call.deadline || '',
      link: callLinkHref(call.link),
      dependency: '',
      owner: '',
      details: call.fit || '',
      order: nextTopLevelTaskOrder(),
      archived: false,
      struck: false
    }).then(function(ref){ return ref.id; });
  }
  function setCallMine(id, value){
    var call = callsState.items.find(function(c){ return c.id === id; });
    var updates = { mine: value };
    var chain = Promise.resolve();
    if(value === 'planning' && call && !call.linkedTaskId){
      chain = createTaskFromCall(call).then(function(taskId){ updates.linkedTaskId = taskId; });
    }
    chain.then(function(){
      return callsCol.doc(id).update(updates);
    }).catch(function(e){ console.error(e); });
  }

  // ---------- shared topbar wiring (undo/redo) ----------
  function wireTopbar(store){
    store = store || Tasks;
    var undoBtn = document.getElementById('undobtn');
    var redoBtn = document.getElementById('redobtn');
    if(undoBtn){ undoBtn.addEventListener('click', store.undo); }
    if(redoBtn){ redoBtn.addEventListener('click', store.redo); }
    store.onUndoState(function(st){
      if(undoBtn) undoBtn.disabled = !st.canUndo;
      if(redoBtn) redoBtn.disabled = !st.canRedo;
    });
    document.addEventListener('keydown', function(e){
      var mod = e.metaKey || e.ctrlKey;
      if(!mod) return;
      var k = e.key.toLowerCase();
      if(k === 'z' && !e.shiftKey){ e.preventDefault(); store.undo(); }
      else if((k === 'z' && e.shiftKey) || k === 'y'){ e.preventDefault(); store.redo(); }
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
    updateFn = updateFn || Tasks.updateField;
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
        if(el.dataset.field === 'details' || el.dataset.field === 'note' || el.dataset.field === 'text'){
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

  return {
    // Tasks store, exposed flat for backward compatibility with existing pages
    state: Tasks.state,
    onChange: Tasks.onChange,
    onStatus: Tasks.onStatus,
    updateField: Tasks.updateField,
    addTopLevel: Tasks.addTopLevel,
    addSiblingAfter: Tasks.addSiblingAfter,
    addTask: Tasks.addTaskWith,
    addChildTask: Tasks.addChildWith,
    archiveTask: Tasks.archiveTask,
    restoreTask: Tasks.restoreTask,
    deleteTask: Tasks.deleteTask,
    toggleStrike: Tasks.toggleStrike,
    hasChildren: Tasks.hasChildren,
    sectionColor: Tasks.sectionColor,
    ancestorTitle: Tasks.ancestorTitle,
    focusIdOnce: Tasks.focusIdOnce,
    rowHTML: Tasks.rowHTML,
    undo: Tasks.undo,
    redo: Tasks.redo,
    onUndoState: Tasks.onUndoState,

    // the new, independent Events store — same shape as the Tasks store above
    Events: Events,

    depthOf: depthOf,
    topSegment: topSegment,
    catClassStyle: catClassStyle,
    escapeHTML: escapeHTML,
    isURL: isURL,
    fmtISO: fmtISO,
    todayISO: todayISO,
    activityCol: activityCol,
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
    readingRowHTML: readingRowHTML,
    podcastRowHTML: podcastRowHTML,
    addPodcasts: addPodcasts,

    notesState: notesState,
    onNotesChange: onNotesChange,
    onNotesStatus: onNotesStatus,
    addNote: addNote,
    updateNoteText: updateNoteText,
    deleteNote: deleteNote,
    focusNoteIdOnce: focusNoteIdOnce,
    noteCardHTML: noteCardHTML,

    callsState: callsState,
    onCallsChange: onCallsChange,
    onCallsStatus: onCallsStatus,
    setCallMine: setCallMine,
    daysUntil: daysUntil,
    callLinkHref: callLinkHref
  };
})();
