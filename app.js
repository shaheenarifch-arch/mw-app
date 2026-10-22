/* Minimal QR Code encoder (byte mode, versions 1–40, ECC L/M/Q/H), after Project Nayuki's
   reference algorithm. qrEncode(text, ecl) -> { size, version, mask, get(x, y) } */
var QR = (function () {
  'use strict';
  // ECC level index: 0=L 1=M 2=Q 3=H ; format bits use L=1 M=0 Q=3 H=2
  var FORMAT_BITS = [1, 0, 3, 2];
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  function numRawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { var n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return r;
  }
  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
  }

  // GF(256) Reed–Solomon
  function rsMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var result = []; for (var i = 0; i < degree - 1; i++) result.push(0); result.push(1);
    var root = 1;
    for (var i2 = 0; i2 < degree; i2++) {
      for (var j = 0; j < result.length; j++) { result[j] = rsMul(result[j], root); if (j + 1 < result.length) result[j] ^= result[j + 1]; }
      root = rsMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift(); result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= rsMul(coef, factor); });
    });
    return result;
  }

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return unescape(encodeURIComponent(text)).split('').map(function (c) { return c.charCodeAt(0); });
  }

  function encode(text, ecl) {
    var data = utf8(text);
    var ver, cap;
    for (ver = 1; ver <= 40; ver++) {
      cap = numDataCodewords(ver, ecl) * 8;
      var ccBits = ver <= 9 ? 8 : 16;
      if (4 + ccBits + data.length * 8 <= cap) break;
    }
    if (ver > 40) throw new Error('Text is too long for a QR code (max about 2,900 bytes at Low correction).');
    // Boost ECC level if it still fits
    for (var e = 3; e > ecl; e--) {
      if (4 + (ver <= 9 ? 8 : 16) + data.length * 8 <= numDataCodewords(ver, e) * 8) { ecl = e; break; }
    }
    cap = numDataCodewords(ver, ecl) * 8;
    var bits = [];
    var put = function (val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(data.length, ver <= 9 ? 8 : 16); data.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) { var v = 0; for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k]; codewords.push(v); }

    // Split into blocks, add ECC, interleave
    var nb = NUM_BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver], raw = Math.floor(numRawModules(ver) / 8);
    var shortLen = Math.floor(raw / nb), numShort = nb - raw % nb;
    var div = rsDivisor(eccLen), blocks = [];
    for (var b = 0, pos = 0; b < nb; b++) {
      var dat = codewords.slice(pos, pos + shortLen - eccLen + (b < numShort ? 0 : 1));
      pos += dat.length;
      var ecc = rsRemainder(dat, div);
      if (b < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var all = [];
    for (var c = 0; c < blocks[0].length; c++) {
      blocks.forEach(function (blk, bi) { if (c !== shortLen - eccLen || bi >= numShort) all.push(blk[c]); });
    }

    var size = ver * 4 + 17;
    var mods = [], fn = [];
    for (var y = 0; y < size; y++) { mods.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    var set = function (x, y, dark) { mods[y][x] = dark; fn[y][x] = true; };

    // Timing
    for (var t = 0; t < size; t++) { set(6, t, t % 2 === 0); set(t, 6, t % 2 === 0); }
    // Finders
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (p) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = p[0] + dx, yy = p[1] + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4);
      }
    });
    // Alignment
    var align = [];
    if (ver > 1) {
      var n = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      align = [6]; for (var a = size - 7; align.length < n; a -= step) align.splice(1, 0, a);
    }
    align.forEach(function (ay, i) {
      align.forEach(function (ax, j) {
        if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });
    var drawFormat = function (mask) {
      var d = FORMAT_BITS[ecl] << 3 | mask, rem = d;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bitsF = (d << 10 | rem) ^ 0x5412;
      var g = function (i) { return ((bitsF >>> i) & 1) !== 0; };
      for (var i1 = 0; i1 <= 5; i1++) set(8, i1, g(i1));
      set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
      for (var i2 = 9; i2 < 15; i2++) set(14 - i2, 8, g(i2));
      for (var i3 = 0; i3 < 8; i3++) set(size - 1 - i3, 8, g(i3));
      for (var i4 = 8; i4 < 15; i4++) set(8, size - 15 + i4, g(i4));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      var rem = ver; for (var i5 = 0; i5 < 12; i5++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = ver << 12 | rem;
      for (var i6 = 0; i6 < 18; i6++) {
        var bit = ((vb >>> i6) & 1) !== 0, aa = size - 11 + i6 % 3, bb = Math.floor(i6 / 3);
        set(aa, bb, bit); set(bb, aa, bit);
      }
    }
    // Data placement
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var jj = 0; jj < 2; jj++) {
        var x = right - jj, upward = ((right + 1) & 2) === 0, yy2 = upward ? size - 1 - vert : vert;
        if (!fn[yy2][x] && idx < all.length * 8) { mods[yy2][x] = ((all[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0; idx++; }
      }
    }
    var applyMask = function (m) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        var inv;
        switch (m) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = x * y % 2 + x * y % 3 === 0; break;
          case 6: inv = (x * y % 2 + x * y % 3) % 2 === 0; break;
          default: inv = ((x + y) % 2 + x * y % 3) % 2 === 0;
        }
        if (inv) mods[y][x] = !mods[y][x];
      }
    };
    var penalty = function () {
      var p = 0, dark = 0;
      var runs = function (get) {
        for (var a = 0; a < size; a++) {
          var color = null, len = 0, hist = [0, 0, 0, 0, 0, 0, 0];
          for (var b = 0; b < size; b++) {
            var c = get(a, b);
            if (c === color) { len++; if (len === 5) p += 3; else if (len > 5) p++; }
            else { color = c; len = 1; }
          }
          // finder-like patterns 1:1:3:1:1 with 4 light modules on a side
          for (var b2 = 0; b2 + 6 < size; b2++) {
            if (get(a, b2) && !get(a, b2 + 1) && get(a, b2 + 2) && get(a, b2 + 3) && get(a, b2 + 4) && !get(a, b2 + 5) && get(a, b2 + 6)) {
              var before = true, after = true;
              for (var k = 1; k <= 4; k++) { if (b2 - k >= 0 && get(a, b2 - k)) before = false; if (b2 + 6 + k < size && get(a, b2 + 6 + k)) after = false; }
              if (before || after) p += 40;
            }
          }
          void hist;
        }
      };
      runs(function (a, b) { return mods[a][b]; });
      runs(function (a, b) { return mods[b][a]; });
      for (var y = 0; y < size - 1; y++) for (var x = 0; x < size - 1; x++) {
        var c = mods[y][x];
        if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) p += 3;
      }
      mods.forEach(function (row) { row.forEach(function (c) { if (c) dark++; }); });
      var total = size * size, kk = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      return p + kk * 10;
    };
    var best = 0, bestP = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      var pp = penalty(); if (pp < bestP) { bestP = pp; best = m; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return { size: size, version: ver, ecl: ecl, mask: best, get: function (x, y) { return mods[y][x]; } };
  }
  return { encode: encode };
})();
/* MW App — tool logic. Everything runs locally in the browser. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('mwapp:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('mwapp:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  /* ---------- toast & copy ---------- */
  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function copy(text, what) {
    if (!text) { toast('Nothing to copy yet'); return; }
    var done = function () { toast((what || 'Text') + ' copied'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — select and copy manually'); }
      document.body.removeChild(ta);
    }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------- navigation ---------- */
  var TOOLS = ['text', 'units', 'json', 'color', 'markdown', 'base64', 'password', 'qr'];
  function show(tool, focus) {
    if (TOOLS.indexOf(tool) < 0) tool = 'text';
    TOOLS.forEach(function (t) { $('tool-' + t).hidden = t !== tool; });
    document.querySelectorAll('#nav button').forEach(function (b) {
      if (b.dataset.tool === tool) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (location.hash !== '#' + tool) history.replaceState(null, '', '#' + tool);
    store.set('tool', tool);
    if (tool === 'password' && !$('pw-out').value) genPassword();
    if (focus) $('main').focus({ preventScroll: true });
  }
  $('nav').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tool]'); if (b) show(b.dataset.tool, true);
  });
  window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });

  /* ---------- text ---------- */
  var tIn = $('text-in'), tOut = $('text-out');
  function textStats() {
    var s = tIn.value, words = (s.match(/\S+/g) || []).length;
    var sentences = (s.match(/[^.!?\n]+[.!?]+/g) || []).length || (s.trim() ? 1 : 0);
    var lines = s ? s.split(/\r\n|\r|\n/).length : 0;
    var mins = Math.max(1, Math.round(words / 220));
    $('text-stats').innerHTML =
      '<span><b>' + s.length + '</b> characters</span>' +
      '<span><b>' + s.replace(/\s/g, '').length + '</b> without spaces</span>' +
      '<span><b>' + words + '</b> words</span>' +
      '<span><b>' + sentences + '</b> ' + (sentences === 1 ? 'sentence' : 'sentences') + '</span>' +
      '<span><b>' + lines + '</b> ' + (lines === 1 ? 'line' : 'lines') + '</span>' +
      '<span>~<b>' + (words ? mins : 0) + '</b> min read</span>';
  }
  var CONV = {
    upper: function (s) { return s.toUpperCase(); },
    lower: function (s) { return s.toLowerCase(); },
    title: function (s) { return s.toLowerCase().replace(/(^|[\s\-("'])(\p{L})/gu, function (m, a, b) { return a + b.toUpperCase(); }); },
    sentence: function (s) { return s.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, function (m, a, b) { return a + b.toUpperCase(); }); },
    reverse: function (s) { return Array.from(s).reverse().join(''); },
    reversewords: function (s) { return s.split(/\r?\n/).map(function (l) { return l.split(/\s+/).filter(Boolean).reverse().join(' '); }).join('\n'); },
    spaces: function (s) { return s.split(/\r?\n/).map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n').replace(/\n{3,}/g, '\n\n').trim(); }
  };
  tIn.addEventListener('input', function () { textStats(); store.set('text', tIn.value); });
  document.querySelectorAll('[data-conv]').forEach(function (b) {
    b.addEventListener('click', function () { tOut.value = CONV[b.dataset.conv](tIn.value); });
  });
  $('text-copy').addEventListener('click', function () { copy(tOut.value, 'Result'); });
  $('text-use').addEventListener('click', function () { if (tOut.value) { tIn.value = tOut.value; tOut.value = ''; textStats(); } });
  $('text-clear').addEventListener('click', function () { tIn.value = tOut.value = ''; textStats(); store.set('text', ''); tIn.focus(); });

  /* ---------- units ---------- */
  var UNITS = {
    length: { m: ['Meters', 1], km: ['Kilometers', 1000], cm: ['Centimeters', .01], mm: ['Millimeters', .001], mi: ['Miles', 1609.344], yd: ['Yards', .9144], ft: ['Feet', .3048], in: ['Inches', .0254], nmi: ['Nautical miles', 1852] },
    weight: { kg: ['Kilograms', 1], g: ['Grams', .001], mg: ['Milligrams', 1e-6], t: ['Metric tonnes', 1000], lb: ['Pounds', .45359237], oz: ['Ounces', .028349523125], st: ['Stones', 6.35029318] },
    temperature: { c: ['Celsius'], f: ['Fahrenheit'], k: ['Kelvin'] },
    volume: { l: ['Liters', 1], ml: ['Milliliters', .001], m3: ['Cubic meters', 1000], gal: ['US gallons', 3.785411784], qt: ['US quarts', .946352946], pt: ['US pints', .473176473], cup: ['US cups', .2365882365], floz: ['US fluid ounces', .0295735295625], ukgal: ['UK gallons', 4.54609], tbsp: ['Tablespoons (US)', .01478676478125], tsp: ['Teaspoons (US)', .00492892159375] }
  };
  var DEFAULT_PAIR = { length: ['m', 'ft'], weight: ['kg', 'lb'], temperature: ['c', 'f'], volume: ['l', 'gal'] };
  function toBase(cat, u, v) {
    if (cat !== 'temperature') return v * UNITS[cat][u][1];
    return u === 'c' ? v : u === 'f' ? (v - 32) * 5 / 9 : v - 273.15;
  }
  function fromBase(cat, u, v) {
    if (cat !== 'temperature') return v / UNITS[cat][u][1];
    return u === 'c' ? v : u === 'f' ? v * 9 / 5 + 32 : v + 273.15;
  }
  function fmtNum(n) {
    if (!isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a !== 0 && (a < 1e-6 || a >= 1e15)) return n.toExponential(6).replace(/\.?0+e/, 'e');
    return parseFloat(n.toPrecision(10)).toLocaleString(undefined, { maximumFractionDigits: 10 });
  }
  function fillUnits(keep) {
    var cat = $('u-cat').value, opts = Object.keys(UNITS[cat]).map(function (k) { return '<option value="' + k + '">' + UNITS[cat][k][0] + '</option>'; }).join('');
    $('u-from').innerHTML = opts; $('u-to').innerHTML = opts;
    var pair = keep || DEFAULT_PAIR[cat];
    $('u-from').value = pair[0]; $('u-to').value = pair[1];
  }
  function convert() {
    var cat = $('u-cat').value, raw = $('u-val').value.trim().replace(/,/g, '');
    var v = Number(raw), err = $('u-error'), tbody = $('u-table').tBodies[0];
    if (raw === '' || isNaN(v)) { err.textContent = raw === '' ? '' : 'Please enter a number, for example 12.5'; $('u-result').textContent = ''; tbody.innerHTML = ''; return; }
    if (cat === 'temperature' && toBase(cat, $('u-from').value, v) < -273.15) { err.textContent = 'That is below absolute zero.'; $('u-result').textContent = ''; tbody.innerHTML = ''; return; }
    err.textContent = '';
    var from = $('u-from').value, to = $('u-to').value, base = toBase(cat, from, v);
    $('u-result').textContent = fmtNum(v) + ' ' + UNITS[cat][from][0] + ' = ' + fmtNum(fromBase(cat, to, base)) + ' ' + UNITS[cat][to][0];
    tbody.innerHTML = Object.keys(UNITS[cat]).map(function (k) {
      return '<tr' + (k === to ? ' class="is-current"' : '') + '><td>' + UNITS[cat][k][0] + '</td><td>' + fmtNum(fromBase(cat, k, base)) + '</td></tr>';
    }).join('');
  }
  $('u-cat').addEventListener('change', function () { fillUnits(); convert(); });
  ['u-from', 'u-to'].forEach(function (id) { $(id).addEventListener('change', convert); });
  $('u-val').addEventListener('input', convert);
  $('u-swap').addEventListener('click', function () { var f = $('u-from').value; $('u-from').value = $('u-to').value; $('u-to').value = f; convert(); });

  /* ---------- JSON ---------- */
  var jIn = $('json-in'), jOut = $('json-out'), jStatus = $('json-status');
  function jStat(msg, ok) { jStatus.textContent = msg; jStatus.className = 'status ' + (ok ? 'ok' : 'err'); }
  function parseJSON() {
    var s = jIn.value;
    if (!s.trim()) { jStat('Paste some JSON first.', false); return undefined; }
    try { return { v: JSON.parse(s) }; } catch (e) {
      var m = /line \d+/i.test(e.message) ? null : String(e.message).match(/position (\d+)/i), where = '';
      if (m) { var pos = +m[1], before = s.slice(0, pos).split('\n'); where = ' (line ' + before.length + ', column ' + (before[before.length - 1].length + 1) + ')'; }

      jStat('Invalid JSON' + where + ': ' + String(e.message).replace(/^JSON\.parse: /, ''), false);
      return undefined;
    }
  }
  function indent() { var v = $('json-indent').value; return v === 'tab' ? '\t' : +v; }
  function sortKeys(x) {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x && typeof x === 'object') { var o = {}; Object.keys(x).sort().forEach(function (k) { o[k] = sortKeys(x[k]); }); return o; }
    return x;
  }
  function describe(v) {
    var count = 0, depth = 0;
    (function walk(x, d) { count++; depth = Math.max(depth, d); if (x && typeof x === 'object') Object.keys(x).forEach(function (k) { walk(x[k], d + 1); }); })(v, 0);
    return (Array.isArray(v) ? 'array of ' + v.length : v && typeof v === 'object' ? 'object with ' + Object.keys(v).length + ' keys' : typeof v) + ', ' + count + ' values, depth ' + depth;
  }
  $('json-format').addEventListener('click', function () { var r = parseJSON(); if (r) { jOut.value = JSON.stringify(r.v, null, indent()); jStat('Valid JSON — ' + describe(r.v) + '.', true); } });
  $('json-minify').addEventListener('click', function () { var r = parseJSON(); if (r) { jOut.value = JSON.stringify(r.v); jStat('Minified: ' + jOut.value.length.toLocaleString() + ' characters (was ' + jIn.value.length.toLocaleString() + ').', true); } });
  $('json-sort').addEventListener('click', function () { var r = parseJSON(); if (r) { jOut.value = JSON.stringify(sortKeys(r.v), null, indent()); jStat('Keys sorted alphabetically.', true); } });
  $('json-validate').addEventListener('click', function () { var r = parseJSON(); if (r) jStat('Valid JSON — ' + describe(r.v) + '.', true); });
  $('json-copy').addEventListener('click', function () { copy(jOut.value, 'Output'); });
  $('json-use').addEventListener('click', function () { if (jOut.value) { jIn.value = jOut.value; jOut.value = ''; } });
  $('json-clear').addEventListener('click', function () { jIn.value = jOut.value = ''; jStatus.textContent = ''; jIn.focus(); });

  /* ---------- color ---------- */
  function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); var n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgbToHex(r, g, b) { return '#' + [r, g, b].map(function (x) { return Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0'); }).join(''); }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2, d = max - min;
    if (d) {
      s = l > .5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
    }
    return [h, s * 100, l * 100];
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
    var k = function (n) { return (n + h / 30) % 12; }, a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
  }
  function luminance(hex) {
    var c = hexToRgb(hex).map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
  }
  function contrast(a, b) { var x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
  function palette(hex, scheme) {
    var hsl = rgbToHsl.apply(null, hexToRgb(hex)), h = hsl[0], s = hsl[1], l = hsl[2];
    switch (scheme) {
      case 'complementary': return [hex, hslToHex(h, s, Math.min(l + 18, 92)), hslToHex(h + 180, s, l), hslToHex(h + 180, s, Math.max(l - 18, 8)), hslToHex(h, s * .35, 95)];
      case 'triadic': return [hex, hslToHex(h + 120, s, l), hslToHex(h + 240, s, l), hslToHex(h, s, Math.max(l - 20, 8)), hslToHex(h, s * .3, 95)];
      case 'tetradic': return [hex, hslToHex(h + 90, s, l), hslToHex(h + 180, s, l), hslToHex(h + 270, s, l)];
      case 'mono': return [18, 32, 46, 60, 74, 88].map(function (L) { return hslToHex(h, s, L); });
      case 'shades': return [-40, -30, -20, -10, 0, 10, 20, 30, 40].map(function (d) { return hslToHex(h, s, Math.max(4, Math.min(97, l + d))); });
      default: return [-40, -20, 0, 20, 40].map(function (d) { return hslToHex(h + d, s, l); });
    }
  }
  var current = store.get('color', '#2f5bea');
  function swatch(hex) {
    var fg = contrast(hex, '#ffffff') > contrast(hex, '#111111') ? '#ffffff' : '#111111';
    return '<button type="button" class="swatch" data-hex="' + hex + '" style="background:' + hex + ';color:' + fg + '" title="Copy ' + hex + '"><span>' + hex + '</span></button>';
  }
  function renderColor() {
    var rgb = hexToRgb(current), hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    $('c-pick').value = current; if (document.activeElement !== $('c-hex')) $('c-hex').value = current;
    $('c-preview').style.background = current;
    var codes = [
      ['HEX', current.toUpperCase()],
      ['RGB', 'rgb(' + rgb.join(', ') + ')'],
      ['HSL', 'hsl(' + Math.round(hsl[0]) + ', ' + Math.round(hsl[1]) + '%, ' + Math.round(hsl[2]) + '%)'],
      ['On white', contrast(current, '#ffffff').toFixed(2) + ':1'],
      ['On black', contrast(current, '#000000').toFixed(2) + ':1']
    ];
    $('c-codes').innerHTML = codes.map(function (c, i) {
      return '<div class="code-chip"><span>' + c[0] + ': ' + esc(c[1]) + '</span>' + (i < 3 ? '<button type="button" data-copy="' + esc(c[1]) + '">Copy</button>' : '') + '</div>';
    }).join('');
    $('c-palette').innerHTML = palette(current, $('c-scheme').value).map(swatch).join('');
    var saved = store.get('saved', []);
    $('c-saved').innerHTML = saved.map(swatch).join('');
    $('c-saved-empty').hidden = saved.length > 0;
  }
  function setColor(hex) { current = hex.toLowerCase(); store.set('color', current); $('c-error').textContent = ''; renderColor(); }
  $('c-pick').addEventListener('input', function () { setColor(this.value); });
  $('c-hex').addEventListener('input', function () {
    var v = this.value.trim(); if (v && v[0] !== '#') v = '#' + v;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { if (v.length === 4) v = '#' + v.slice(1).replace(/./g, '$&$&'); setColor(v); }
    else $('c-error').textContent = v.length >= 4 ? 'Use a hex code like #2f5bea or #fff.' : '';
  });
  $('c-hex').addEventListener('blur', function () { this.value = current; $('c-error').textContent = ''; });
  $('c-random').addEventListener('click', function () { var b = new Uint8Array(3); crypto.getRandomValues(b); setColor(rgbToHex(b[0], b[1], b[2])); });
  $('c-save').addEventListener('click', function () {
    var s = store.get('saved', []).filter(function (x) { return x !== current; }); s.unshift(current); store.set('saved', s.slice(0, 24)); renderColor(); toast('Color saved');
  });
  $('c-scheme').addEventListener('change', renderColor);
  $('c-copyall').addEventListener('click', function () { copy(palette(current, $('c-scheme').value).join(', '), 'Palette'); });
  $('tool-color').addEventListener('click', function (e) {
    var sw = e.target.closest('.swatch'); if (sw) { copy(sw.dataset.hex, sw.dataset.hex); return; }
    var cp = e.target.closest('[data-copy]'); if (cp) copy(cp.dataset.copy, 'Code');
  });
  $('tool-color').addEventListener('dblclick', function (e) { var sw = e.target.closest('.swatch'); if (sw) setColor(sw.dataset.hex); });

  /* ---------- markdown ---------- */
  function inline(s) {
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (m, alt, src, title) { return '<img src="' + safeUrl(src) + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : '') + '>'; })
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (m, txt, href, title) { return '<a href="' + safeUrl(href) + '"' + (title ? ' title="' + title + '"' : '') + '>' + txt + '</a>'; })
      .replace(/(^|[^"=])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2">$2</a>')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
      .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code>' + esc(codes[+i]) + '</code>'; });
  }
  function safeUrl(u) { return /^\s*(javascript|vbscript|data):/i.test(u) ? '#' : u.replace(/"/g, '%22'); }
  function markdown(src) {
    var lines = src.replace(/\r\n?/g, '\n').split('\n'), out = [], i = 0;
    var isBlank = function (l) { return !l.trim(); };
    while (i < lines.length) {
      var l = lines[i], m;
      if (isBlank(l)) { i++; continue; }
      if ((m = l.match(/^\s*(```|~~~)\s*([\w+-]*)/))) {
        var fence = m[1], lang = m[2], code = []; i++;
        while (i < lines.length && lines[i].trim().indexOf(fence) !== 0) code.push(lines[i++]);
        i++; out.push('<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>'); continue;
      }
      if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(l)) {
        var q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + markdown(q.join('\n')) + '</blockquote>'); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        var cells = function (r) { return r.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(l), aligns = cells(lines[i + 1]).map(function (c) { return /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''; });
        i += 2; var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        var cell = function (tag, c, k) { return '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c) + '</' + tag + '>'; };
        out.push('<table><thead><tr>' + head.map(function (c, k) { return cell('th', c, k); }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c, k) { return cell('td', c, k); }).join('') + '</tr>'; }).join('') + '</tbody></table>');
        continue;
      }
      if ((m = l.match(/^(\s*)([-*+]|\d+[.)])\s+/))) {
        var ordered = /\d/.test(m[2]), items = [], start = ordered ? parseInt(m[2], 10) : 1;
        var itemRe = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        while (i < lines.length && itemRe.test(lines[i])) {
          var text = lines[i].match(itemRe)[1]; i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !itemRe.test(lines[i])) text += ' ' + lines[i++].trim();
          var task = text.match(/^\[([ xX])\]\s+(.*)$/);
          items.push(task ? '<li><input type="checkbox" disabled' + (task[1] !== ' ' ? ' checked' : '') + '> ' + inline(task[2]) + '</li>' : '<li>' + inline(text) + '</li>');
        }
        out.push(ordered ? '<ol' + (start !== 1 ? ' start="' + start + '"' : '') + '>' + items.join('') + '</ol>' : '<ul>' + items.join('') + '</ul>');
        continue;
      }
      var para = [];
      while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
      out.push('<p>' + para.map(function (p, k) { return inline(p.replace(/\s{2,}$/, '')) + (k < para.length - 1 && /\s{2,}$/.test(p) ? '<br>' : ''); }).join('\n') + '</p>');
    }
    return out.join('\n');
  }
  var mdIn = $('md-in'), mdView = 'preview';
  function renderMd() {
    var html = markdown(mdIn.value);
    $('md-preview').innerHTML = html; $('md-html').value = html; store.set('md', mdIn.value);
  }
  function setMdView(v) {
    mdView = v;
    $('md-view-preview').setAttribute('aria-pressed', String(v === 'preview'));
    $('md-view-html').setAttribute('aria-pressed', String(v === 'html'));
    $('md-preview').hidden = v !== 'preview'; $('md-html').hidden = v !== 'html';
  }
  var MD_SAMPLE = '# Project notes\n\nMW App turns **Markdown** into clean HTML, with *emphasis*, `inline code` and [links](https://example.com).\n\n## Checklist\n\n- [x] Write the outline\n- [ ] Review the draft\n- Share with the team\n\n1. First step\n2. Second step\n\n> Tip: switch to **HTML source** to copy the markup.\n\n```js\nconsole.log("Hello from MW App");\n```\n\n| Tool | Works offline |\n|:-----|:-------------:|\n| Text | Yes |\n| QR code | Yes |\n';
  mdIn.addEventListener('input', renderMd);
  $('md-view-preview').addEventListener('click', function () { setMdView('preview'); });
  $('md-view-html').addEventListener('click', function () { setMdView('html'); });
  $('md-copy').addEventListener('click', function () { copy($('md-html').value, 'HTML'); });
  $('md-sample').addEventListener('click', function () { mdIn.value = MD_SAMPLE; renderMd(); });
  $('md-clear').addEventListener('click', function () { mdIn.value = ''; renderMd(); mdIn.focus(); });

  /* ---------- base64 ---------- */
  var bMode = 'enc', bIn = $('b64-in'), bOut = $('b64-out');
  function b64enc(s, url) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    var r = btoa(bin); return url ? r.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : r;
  }
  function b64dec(s) {
    s = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error('This contains characters that are not valid Base64.');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  function runB64() {
    var err = $('b64-error'); err.textContent = '';
    if (!bIn.value) { bOut.value = ''; return; }
    try { bOut.value = bMode === 'enc' ? b64enc(bIn.value, $('b64-url').checked) : b64dec(bIn.value); }
    catch (e) { bOut.value = ''; err.textContent = bMode === 'dec' ? (e instanceof TypeError ? 'The decoded data is not readable text (it may be a binary file).' : e.message || 'This is not valid Base64.') : 'Could not encode this text.'; }
  }
  function setB64(mode) {
    bMode = mode;
    $('b64-enc').setAttribute('aria-pressed', String(mode === 'enc')); $('b64-dec').setAttribute('aria-pressed', String(mode === 'dec'));
    $('b64-in-label').textContent = mode === 'enc' ? 'Text to encode' : 'Base64 to decode';
    runB64();
  }
  bIn.addEventListener('input', runB64);
  $('b64-url').addEventListener('change', runB64);
  $('b64-enc').addEventListener('click', function () { setB64('enc'); });
  $('b64-dec').addEventListener('click', function () { setB64('dec'); });
  $('b64-copy').addEventListener('click', function () { copy(bOut.value, 'Result'); });
  $('b64-swap').addEventListener('click', function () { if (!bOut.value) return; bIn.value = bOut.value; setB64(bMode === 'enc' ? 'dec' : 'enc'); });
  $('b64-clear').addEventListener('click', function () { bIn.value = bOut.value = ''; $('b64-error').textContent = ''; bIn.focus(); });

  /* ---------- password ---------- */
  var SETS = { lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', digits: '0123456789', symbols: '!@#$%^&*()-_=+[]{};:,.?/~' };
  function randInt(n) { var max = Math.floor(0x100000000 / n) * n, b = new Uint32Array(1); do { crypto.getRandomValues(b); } while (b[0] >= max); return b[0] % n; }
  function genPassword() {
    var len = +$('pw-len').value, ambig = $('pw-ambig').checked, groups = [];
    Object.keys(SETS).forEach(function (k) {
      if ($('pw-' + k).checked) groups.push(ambig ? SETS[k].replace(/[Il1O0o]/g, '') : SETS[k]);
    });
    var err = $('pw-error');
    if (!groups.length) { err.textContent = 'Choose at least one character type.'; $('pw-out').value = ''; meter(0, 0); return; }
    err.textContent = '';
    var all = groups.join(''), chars = groups.map(function (g) { return g[randInt(g.length)]; });
    while (chars.length < len) chars.push(all[randInt(all.length)]);
    for (var i = chars.length - 1; i > 0; i--) { var j = randInt(i + 1), t = chars[i]; chars[i] = chars[j]; chars[j] = t; }
    $('pw-out').value = chars.slice(0, len).join('');
    meter(len * Math.log2(all.length), len);
  }
  function meter(bits) {
    var lvl = bits >= 100 ? 4 : bits >= 75 ? 3 : bits >= 55 ? 2 : bits >= 35 ? 1 : 0;
    var names = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'], colors = ['#d64545', '#e8833a', '#d9b42b', '#3b9d5d', '#1f7a4a'];
    $('pw-bar').style.width = bits ? Math.min(100, bits / 1.28) + '%' : '0';
    $('pw-bar').style.background = colors[lvl];
    $('pw-strength').textContent = bits ? names[lvl] + ' · about ' + Math.round(bits) + ' bits of entropy' : '';
  }
  $('pw-len').addEventListener('input', function () { $('pw-len-out').textContent = this.value; genPassword(); });
  ['pw-lower', 'pw-upper', 'pw-digits', 'pw-symbols', 'pw-ambig'].forEach(function (id) { $(id).addEventListener('change', genPassword); });
  $('pw-gen').addEventListener('click', genPassword);
  $('pw-copy').addEventListener('click', function () { copy($('pw-out').value, 'Password'); });

  /* ---------- QR ---------- */
  var qrTimer, ECC_NAMES = ['Low', 'Medium', 'Quartile', 'High'];
  function renderQR() {
    var text = $('qr-in').value, canvas = $('qr-canvas'), err = $('qr-error');
    err.textContent = ''; $('qr-info').textContent = '';
    if (!text) { canvas.hidden = true; $('qr-empty').hidden = false; $('qr-download').disabled = true; return; }
    var q;
    try { q = QR.encode(text, +$('qr-ecc').value); }
    catch (e) { err.textContent = e.message; canvas.hidden = true; $('qr-empty').hidden = false; $('qr-download').disabled = true; return; }
    var scale = +$('qr-scale').value, quiet = 4, dim = (q.size + quiet * 2) * scale, ctx = canvas.getContext('2d');
    canvas.width = canvas.height = dim;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dim, dim); ctx.fillStyle = '#000000';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (q.get(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    canvas.hidden = false; $('qr-empty').hidden = true; $('qr-download').disabled = false;
    canvas.setAttribute('aria-label', 'QR code for: ' + text.slice(0, 80));
    $('qr-info').textContent = 'Version ' + q.version + ' · ' + q.size + '×' + q.size + ' modules · ' + ECC_NAMES[q.ecl] + ' error correction · ' + dim + '×' + dim + ' px';
  }
  $('qr-in').addEventListener('input', function () { clearTimeout(qrTimer); qrTimer = setTimeout(renderQR, 120); });
  $('qr-ecc').addEventListener('change', renderQR);
  $('qr-scale').addEventListener('input', function () { $('qr-scale-out').textContent = this.value; renderQR(); });
  $('qr-download').addEventListener('click', function () {
    var a = document.createElement('a'); a.download = 'qr-code.png'; a.href = $('qr-canvas').toDataURL('image/png');
    document.body.appendChild(a); a.click(); a.remove();
  });
  $('qr-clear').addEventListener('click', function () { $('qr-in').value = ''; renderQR(); $('qr-in').focus(); });

  /* ---------- init ---------- */
  tIn.value = store.get('text', ''); textStats();
  fillUnits(); convert();
  renderColor();
  mdIn.value = store.get('md', ''); renderMd(); setMdView('preview');
  setB64('enc');
  show(location.hash.slice(1) || store.get('tool', 'text'));
})();
