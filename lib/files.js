/* Lib.files - file access helpers for the library page.
 *
 *   Lib.files.pickPdf()                  -> Promise<File|null>
 *   Lib.files.fingerprint(bufferOrBlob)  -> Promise<string>   (16 hex chars)
 *   Lib.files.toBuffer(blobOrBuffer)     -> Promise<ArrayBuffer>
 *   Lib.files.cache.get(id) / put(id, blob) / del(id) / has(id)   (IndexedDB 'lib-files', failures swallowed)
 *   Lib.files.folder.available() / connect() / disconnect() / name() / find(pathOrName) / ready() / info()
 *
 * Plain ES5, no dependencies. The pure parts (sha256, basename, folder index) also run under node
 * for tests; the browser-only parts check for their APIs before using them.
 */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : globalThis;
  root.Lib = root.Lib || {};

  var HEAD_BYTES = 256 * 1024;
  var files = {};

  /* ------------------------------------------------------------------ */
  /* SHA-256 (pure JS fallback, used when crypto.subtle is not available, */
  /* e.g. a page opened over plain http on a LAN address)                */
  /* ------------------------------------------------------------------ */
  var K = [], H0 = [];
  (function () {
    var n = 2, c = 0, i, isPrime;
    while (c < 64) {
      isPrime = true;
      for (i = 2; i * i <= n; i++) { if (n % i === 0) { isPrime = false; break; } }
      if (isPrime) {
        if (c < 8) { H0[c] = ((Math.pow(n, 0.5) % 1) * 4294967296) | 0; }
        K[c] = ((Math.pow(n, 1 / 3) % 1) * 4294967296) | 0;
        c++;
      }
      n++;
    }
  })();

  function ror(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256hex(bytes) {
    var l = bytes.length;
    var padLen = ((l + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(padLen);
    buf.set(bytes);
    buf[l] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, Math.floor(l / 536870912));
    dv.setUint32(padLen - 4, (l * 8) >>> 0);
    var h = H0.slice(0), w = new Array(64), off, t;
    for (off = 0; off < padLen; off += 64) {
      for (t = 0; t < 16; t++) { w[t] = dv.getInt32(off + 4 * t); }
      for (t = 16; t < 64; t++) {
        var x15 = w[t - 15], x2 = w[t - 2];
        var s0 = ror(x15, 7) ^ ror(x15, 18) ^ (x15 >>> 3);
        var s1 = ror(x2, 17) ^ ror(x2, 19) ^ (x2 >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[t] + w[t]) | 0;
        var S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = '';
    for (t = 0; t < 8; t++) { out += ('00000000' + (h[t] >>> 0).toString(16)).slice(-8); }
    return out;
  }
  files._sha256hex = sha256hex; // exposed for tests

  function hexOf(buf) {
    var u = new Uint8Array(buf), s = '', i;
    for (i = 0; i < u.length; i++) { s += (u[i] < 16 ? '0' : '') + u[i].toString(16); }
    return s;
  }

  function digestHex(bytes) {
    var subtle = root.crypto && root.crypto.subtle;
    if (subtle && typeof subtle.digest === 'function') {
      try {
        return subtle.digest('SHA-256', bytes).then(hexOf, function () { return sha256hex(bytes); });
      } catch (e) { /* fall through */ }
    }
    return Promise.resolve(sha256hex(bytes));
  }

  /* ------------------------------------------------------------------ */
  /* Blob / buffer helpers                                               */
  /* ------------------------------------------------------------------ */
  function isBlob(x) { return typeof Blob !== 'undefined' && x instanceof Blob; }
  function isView(x) { return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(x); }
  function isBuf(x) { return typeof ArrayBuffer !== 'undefined' && x instanceof ArrayBuffer; }

  function readBlob(blob) {
    if (typeof blob.arrayBuffer === 'function') { return blob.arrayBuffer(); }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  /* Resolves an ArrayBuffer for a Blob/File, ArrayBuffer or typed array. Always a copy for views. */
  files.toBuffer = function (x) {
    if (isBuf(x)) { return Promise.resolve(x); }
    if (isView(x)) { return Promise.resolve(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)); }
    if (isBlob(x)) { return readBlob(x); }
    return Promise.reject(new Error('Not a file'));
  };

  /* fingerprint = first 16 hex chars of SHA-256(first 256 KiB of bytes + ASCII decimal byteLength).
     Accepts ArrayBuffer, typed array, Blob/File. Resolves '' for anything else. */
  files.fingerprint = function (input) {
    var head, len, getHead;
    try {
      // The head is copied right now, so the caller may transfer or detach the buffer straight after.
      if (isBuf(input)) {
        len = input.byteLength;
        getHead = Promise.resolve(new Uint8Array(input.slice(0, Math.min(len, HEAD_BYTES))));
      } else if (isView(input)) {
        len = input.byteLength;
        getHead = Promise.resolve(new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + Math.min(len, HEAD_BYTES))));
      } else if (isBlob(input)) {
        len = input.size;
        getHead = readBlob(input.slice(0, HEAD_BYTES)).then(function (b) { return new Uint8Array(b); });
      } else {
        return Promise.resolve('');
      }
    } catch (e) { return Promise.resolve(''); }
    return getHead.then(function (h) {
      head = h;
      var tail = [], s = String(len), i;
      for (i = 0; i < s.length; i++) { tail.push(s.charCodeAt(i)); }
      var payload = new Uint8Array(head.length + tail.length);
      payload.set(head, 0);
      payload.set(tail, head.length);
      return digestHex(payload);
    }).then(function (hex) { return hex.slice(0, 16); }, function () { return ''; });
  };

  /* ------------------------------------------------------------------ */
  /* Pick a PDF (works on iOS Safari: the input is in the DOM and clicked */
  /* inside the tap that called us)                                      */
  /* ------------------------------------------------------------------ */
  var pending = null;
  files.pickPdf = function () {
    if (typeof document === 'undefined') { return Promise.resolve(null); }
    if (pending) { pending(null); pending = null; }
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      var done = false;
      input.type = 'file';
      input.accept = 'application/pdf,.pdf';
      input.setAttribute('aria-hidden', 'true');
      input.tabIndex = -1;
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
      function finish(file) {
        if (done) { return; }
        done = true;
        pending = null;
        try { if (input.parentNode) { input.parentNode.removeChild(input); } } catch (e) { /* ignore */ }
        resolve(file || null);
      }
      pending = finish;
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        finish(f || null);
      });
      input.addEventListener('cancel', function () { finish(null); });
      (document.body || document.documentElement).appendChild(input);
      try { input.click(); } catch (e) { finish(null); }
    });
  };

  /* ------------------------------------------------------------------ */
  /* IndexedDB 'lib-files': store 'files' (cache) and 'kv' (folder handle) */
  /* ------------------------------------------------------------------ */
  var dbPromise = null;
  function openDb() {
    if (dbPromise) { return dbPromise; }
    dbPromise = new Promise(function (resolve) {
      try {
        if (!root.indexedDB) { resolve(null); return; }
        var req = root.indexedDB.open('lib-files', 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('files')) { db.createObjectStore('files'); }
          if (!db.objectStoreNames.contains('kv')) { db.createObjectStore('kv'); }
        };
        req.onsuccess = function () {
          var db = req.result;
          db.onversionchange = function () { try { db.close(); } catch (e) { /* ignore */ } dbPromise = null; };
          resolve(db);
        };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbPromise;
  }

  /* Runs one request in its own transaction. Resolves {ok, value}; never rejects. */
  function dbDo(store, mode, make) {
    return openDb().then(function (db) {
      if (!db) { return { ok: false, value: null }; }
      return new Promise(function (resolve) {
        var req, settled = false;
        function done(ok, v) { if (!settled) { settled = true; resolve({ ok: ok, value: v }); } }
        try {
          var t = db.transaction(store, mode);
          req = make(t.objectStore(store));
          t.oncomplete = function () { done(true, req && req.result !== undefined ? req.result : null); };
          t.onerror = function () { done(false, null); };
          t.onabort = function () { done(false, null); };
        } catch (e) { done(false, null); }
      });
    }, function () { return { ok: false, value: null }; });
  }

  files.cache = {
    get: function (id) {
      return dbDo('files', 'readonly', function (os) { return os.get(String(id)); }).then(function (r) {
        var rec = r.ok ? r.value : null;
        if (!rec || !rec.buf) { return null; }
        try { return new Blob([rec.buf], { type: rec.type || 'application/pdf' }); } catch (e) { return null; }
      });
    },
    put: function (id, blob) {
      return files.toBuffer(blob).then(function (buf) {
        var type = (blob && blob.type) || 'application/pdf';
        return dbDo('files', 'readwrite', function (os) {
          return os.put({ buf: buf, type: type, size: buf.byteLength, at: Date.now() }, String(id));
        });
      }).then(function (r) { return !!r.ok; }, function () { return false; });
    },
    del: function (id) {
      return dbDo('files', 'readwrite', function (os) { return os.delete(String(id)); }).then(function (r) { return !!r.ok; });
    },
    has: function (id) {
      return dbDo('files', 'readonly', function (os) { return os.count(String(id)); }).then(function (r) { return !!(r.ok && r.value > 0); });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Folder (File System Access API: Chrome / Edge on desktop)           */
  /* ------------------------------------------------------------------ */
  var SKIP_DIRS = /^(\.|node_modules$)/;
  var MAX_ENTRIES = 200000;
  var MAX_DEPTH = 14;

  var state = {
    handle: null,
    name: '',
    permission: '',
    index: null,       // { key -> [ {name, path:[...segments lowercased], handle} ] }
    count: 0,
    indexPromise: null,
    loadPromise: null
  };

  function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (root.localStorage) { if (v === null) { root.localStorage.removeItem(k); } else { root.localStorage.setItem(k, v); } } } catch (e) { /* ignore */ } }

  function nfc(s) {
    s = String(s == null ? '' : s);
    try { return s.normalize ? s.normalize('NFC') : s; } catch (e) { return s; }
  }
  function lower(s) { return nfc(s).toLowerCase(); }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /* Splits a path or file:// url into cleaned segments. */
  function segmentsOf(p) {
    var s = String(p == null ? '' : p).trim();
    var isFileUrl = /^file:\/\//i.test(s);
    s = s.replace(/^file:\/\/(localhost)?/i, '');
    if (isFileUrl) { s = s.split(/[?#]/)[0]; }          // only a url has a query or fragment; a plain path may hold '#' or '?' in a file name
    if (/%[0-9a-f]{2}/i.test(s)) { s = safeDecode(s); }
    var parts = s.split(/[\\/]+/), out = [], i;
    for (i = 0; i < parts.length; i++) { if (parts[i]) { out.push(parts[i]); } }
    return out;
  }
  files._segmentsOf = segmentsOf;

  function isRemoteUrl(p) { return /^(https?|ftp|blob|data):/i.test(String(p == null ? '' : p).trim()); }

  function loadHandle() {
    if (state.loadPromise) { return state.loadPromise; }
    state.loadPromise = dbDo('kv', 'readonly', function (os) { return os.get('folder'); }).then(function (r) {
      if (!state.handle && r.ok && r.value && typeof r.value === 'object' && r.value.kind === 'directory') {
        state.handle = r.value;
        state.name = r.value.name || '';
      } else if (!state.handle) {
        state.name = '';
        lsSet('lib-folder-name', null);
      }
      return state.name;
    });
    return state.loadPromise;
  }

  function resetIndex() { state.index = null; state.indexPromise = null; state.count = 0; }

  function listDir(dir) {
    return new Promise(function (resolve) {
      var out = [], it, pairs = false;
      try {
        if (typeof dir.values === 'function') { it = dir.values(); }
        else if (typeof dir.entries === 'function') { it = dir.entries(); pairs = true; }
        else { resolve(out); return; }
      } catch (e) { resolve(out); return; }
      (function step() {
        var p;
        try { p = it.next(); } catch (e) { resolve(out); return; }
        Promise.resolve(p).then(function (r) {
          if (!r || r.done) { resolve(out); return; }
          out.push(pairs ? r.value[1] : r.value);
          step();
        }, function () { resolve(out); });
      })();
    });
  }

  /* Breadth-first walk, one directory at a time (shallow files win ties). */
  function buildIndex(handle) {
    var index = {}, count = 0;
    var queue = [{ dir: handle, path: [lower(handle.name || '')], depth: 0 }];
    function next() {
      if (!queue.length || count >= MAX_ENTRIES) { return Promise.resolve(); }
      var job = queue.shift();
      return listDir(job.dir).then(function (kids) {
        var i, k, nm;
        for (i = 0; i < kids.length; i++) {
          k = kids[i];
          if (!k || !k.name) { continue; }
          nm = k.name;
          if (k.kind === 'directory') {
            if (!SKIP_DIRS.test(nm) && job.depth < MAX_DEPTH) { queue.push({ dir: k, path: job.path.concat(lower(nm)), depth: job.depth + 1 }); }
          } else if (k.kind === 'file') {
            if (nm.charAt(0) === '.') { continue; }
            var key = lower(nm);
            (index[key] = index[key] || []).push({ name: nm, path: job.path.concat(key), handle: k });
            count++;
          }
        }
        return next();
      });
    }
    return next().then(function () { state.count = count; return index; });
  }

  function ensureIndex() {
    if (state.index) { return Promise.resolve(state.index); }
    if (!state.indexPromise) {
      var h = state.handle;
      state.indexPromise = buildIndex(h).then(function (idx) {
        if (state.handle === h) { state.index = idx; }
        return idx;
      }, function () { state.indexPromise = null; return {}; });
    }
    return state.indexPromise;
  }

  function permissionFor(h) {
    try {
      if (h && typeof h.requestPermission === 'function') {
        // Must be called while the click that started find() is still fresh.
        return Promise.resolve(h.requestPermission({ mode: 'read' })).then(function (s) { return s; }, function () { return 'denied'; });
      }
    } catch (e) { return Promise.resolve('denied'); }
    return Promise.resolve('granted');
  }

  function pickEntry(index, query) {
    var segs = segmentsOf(query), i, j;
    if (!segs.length) { return null; }
    var base = lower(segs[segs.length - 1]);
    var list = index[base];
    if (!list || !list.length) { return null; }
    var q = [];
    for (i = 0; i < segs.length; i++) { q.push(lower(segs[i])); }
    var best = null, bestScore = -1, score, e;
    for (i = 0; i < list.length; i++) {
      e = list[i];
      score = 0;
      for (j = 1; j <= q.length && j <= e.path.length; j++) {
        if (q[q.length - j] === e.path[e.path.length - j]) { score++; } else { break; }
      }
      if (score > bestScore) { best = e; bestScore = score; }
    }
    return best;
  }
  files._pickEntry = pickEntry;

  files.folder = {
    available: function () { return typeof root.showDirectoryPicker === 'function'; },

    /* Call inside a click. Resolves the folder name, or null if cancelled/unsupported. */
    connect: function () {
      if (!files.folder.available()) { return Promise.resolve(null); }
      var p;
      try { p = root.showDirectoryPicker({ id: 'lib-folder', mode: 'read' }); } catch (e) { return Promise.resolve(null); }
      return Promise.resolve(p).then(function (h) {
        state.handle = h;
        state.name = h.name || '';
        state.permission = 'granted';
        resetIndex();
        lsSet('lib-folder-name', state.name);
        dbDo('kv', 'readwrite', function (os) { return os.put(h, 'folder'); });
        return state.name;
      }, function () { return null; });
    },

    disconnect: function () {
      state.handle = null;
      state.name = '';
      state.permission = '';
      resetIndex();
      lsSet('lib-folder-name', null);
      return dbDo('kv', 'readwrite', function (os) { return os.delete('folder'); }).then(function () { return true; });
    },

    /* Synchronous: the connected folder's name or ''. */
    name: function () { return state.name || (state.handle ? '' : (lsGet('lib-folder-name') || '')); },

    /* Resolves once a previously saved folder has been read back from IndexedDB. */
    ready: function () { return loadHandle(); },

    info: function () {
      return { connected: !!state.handle, name: state.name, indexed: !!state.index, count: state.count, permission: state.permission };
    },

    /* Forget the in-memory index (the next find() walks the folder again). */
    rescan: function () { resetIndex(); },

    /* Test hook: use a fake FileSystemDirectoryHandle-like object. */
    _inject: function (h) {
      state.handle = h || null;
      state.name = h ? (h.name || '') : '';
      state.loadPromise = Promise.resolve(state.name);
      resetIndex();
    },

    /* find('/Users/me/Papers/X.pdf' | 'X.pdf') -> Promise<File|null>. Matches by basename, case-insensitive,
       preferring the candidate whose parent folders also match. Call it straight from a click so the
       permission prompt is allowed. */
    find: function (pathOrName, opts) {
      if (pathOrName == null || isRemoteUrl(pathOrName)) { return Promise.resolve(null); }
      var segs = segmentsOf(pathOrName);
      if (!segs.length) { return Promise.resolve(null); }
      if (opts && opts.rescan) { resetIndex(); }

      function run() {
        var h = state.handle;
        if (!h) { return Promise.resolve(null); }
        return permissionFor(h).then(function (perm) {
          state.permission = perm;
          if (perm !== 'granted') { return null; }
          return ensureIndex().then(function (index) {
            var entry = pickEntry(index, pathOrName);
            if (!entry) { return null; }
            return Promise.resolve(entry.handle.getFile()).then(function (f) { return f || null; }, function () {
              resetIndex(); // moved or deleted since the index was built
              return null;
            });
          });
        }).catch(function () { return null; });
      }
      if (state.handle) { return run(); }
      return loadHandle().then(run);
    }
  };

  // Read a previously connected folder in the background so name() and find() work after a reload.
  try { if (typeof indexedDB !== 'undefined' && typeof window !== 'undefined') { loadHandle(); } } catch (e) { /* ignore */ }

  root.Lib.files = files;
  if (typeof module !== 'undefined') { module.exports = root.Lib.files; }
})();
