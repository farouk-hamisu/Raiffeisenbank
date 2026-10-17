(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BLOCKS = {
    1: [[26, 16]],
    2: [[44, 28]],
    3: [[70, 44]],
    4: [[50, 32], [50, 32]],
    5: [[67, 43], [67, 43]],
    6: [[43, 27], [43, 27], [43, 27], [43, 27]],
    7: [[49, 31], [49, 31], [49, 31], [49, 31]],
    8: [[60, 38], [60, 38], [61, 39], [61, 39]],
    9: [[58, 36], [58, 36], [58, 36], [59, 37], [59, 37]],
    10: [[69, 43], [69, 43], [69, 43], [69, 43], [70, 44]],
    11: [[80, 50], [81, 51], [81, 51], [81, 51], [81, 51]],
    12: [[58, 36], [58, 36], [58, 36], [58, 36], [58, 36], [58, 36], [59, 37], [59, 37]],
    13: [[59, 37], [59, 37], [59, 37], [59, 37], [59, 37], [59, 37], [59, 37], [59, 37], [60, 38]],
    14: [[64, 40], [64, 40], [64, 40], [64, 40], [65, 41], [65, 41], [65, 41], [65, 41], [65, 41]],
    15: [[65, 41], [65, 41], [65, 41], [65, 41], [65, 41], [66, 42], [66, 42], [66, 42], [66, 42], [66, 42]],
    16: [[73, 45], [73, 45], [73, 45], [73, 45], [73, 45], [73, 45], [73, 45], [74, 46], [74, 46], [74, 46]],
    17: [[74, 46], [74, 46], [74, 46], [74, 46], [74, 46], [74, 46], [74, 46], [74, 46], [74, 46], [74, 46], [75, 47]],
    18: [[69, 43], [69, 43], [69, 43], [69, 43], [69, 43], [69, 43], [69, 43], [69, 43], [69, 43], [70, 44], [70, 44], [70, 44], [70, 44]],
    19: [[70, 44], [70, 44], [70, 44], [71, 45], [71, 45], [71, 45], [71, 45], [71, 45], [71, 45], [71, 45], [71, 45], [71, 45], [71, 45], [71, 45]],
    20: [[67, 41], [67, 41], [67, 41], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42], [68, 42]]
  };

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  }());

  function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsDivisor(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = mul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = mul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = new Uint8Array(divisor.length);
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (var i = 0; i < result.length; i++) result[i] ^= mul(divisor[i], factor);
    }
    return result;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(str));
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function capacityBits(version) {
    var blocks = BLOCKS[version];
    var dataCw = 0;
    for (var i = 0; i < blocks.length; i++) dataCw += blocks[i][1];
    return dataCw * 8;
  }

  function chooseVersion(byteLen) {
    for (var v = 1; v <= 20; v++) {
      var ccBits = v <= 9 ? 8 : 16;
      if (4 + ccBits + byteLen * 8 <= capacityBits(v)) return v;
    }
    return null;
  }

  function buildCodewords(bytes, version) {
    var blocks = BLOCKS[version];
    var totalData = 0;
    for (var i = 0; i < blocks.length; i++) totalData += blocks[i][1];
    var bits = [];
    function push(value, len) {
      for (var b = len - 1; b >= 0; b--) bits.push((value >>> b) & 1);
    }
    push(4, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (var j = 0; j < bytes.length; j++) push(bytes[j], 8);
    var capacity = totalData * 8;
    var terminator = Math.min(4, capacity - bits.length);
    push(0, terminator);
    while (bits.length % 8 !== 0) bits.push(0);
    var data = [];
    for (var k = 0; k < bits.length; k += 8) {
      var byte = 0;
      for (var m = 0; m < 8; m++) byte = (byte << 1) | bits[k + m];
      data.push(byte);
    }
    var padBytes = [0xec, 0x11];
    var p = 0;
    while (data.length < totalData) data.push(padBytes[p++ % 2]);

    var ecPerBlock = blocks[0][0] - blocks[0][1];
    var divisor = rsDivisor(ecPerBlock);
    var dataBlocks = [];
    var ecBlocks = [];
    var offset = 0;
    for (var g = 0; g < blocks.length; g++) {
      var chunk = data.slice(offset, offset + blocks[g][1]);
      offset += blocks[g][1];
      dataBlocks.push(chunk);
      ecBlocks.push(Array.prototype.slice.call(rsRemainder(chunk, divisor)));
    }
    var result = [];
    var maxData = 0;
    for (var d = 0; d < dataBlocks.length; d++) maxData = Math.max(maxData, dataBlocks[d].length);
    for (var idx = 0; idx < maxData; idx++) {
      for (var b2 = 0; b2 < dataBlocks.length; b2++) {
        if (idx < dataBlocks[b2].length) result.push(dataBlocks[b2][idx]);
      }
    }
    for (var e = 0; e < ecPerBlock; e++) {
      for (var b3 = 0; b3 < ecBlocks.length; b3++) result.push(ecBlocks[b3][e]);
    }
    return result;
  }

  var ALIGN = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
    11: [6, 30, 54],
    12: [6, 32, 58],
    13: [6, 34, 62],
    14: [6, 26, 46, 66],
    15: [6, 26, 48, 70],
    16: [6, 26, 50, 74],
    17: [6, 30, 54, 78],
    18: [6, 30, 56, 82],
    19: [6, 30, 58, 86],
    20: [6, 34, 62, 90]
  };

  function alignmentPositions(version) {
    return ALIGN[version] || [];
  }

  function newMatrix(size) {
    var m = [];
    for (var y = 0; y < size; y++) {
      var row = [];
      for (var x = 0; x < size; x++) row.push(false);
      m.push(row);
    }
    return m;
  }

  function drawFunctionPatterns(modules, isFunction, version) {
    var size = modules.length;
    for (var i = 0; i < size; i++) {
      setFn(modules, isFunction, 6, i, i % 2 === 0);
      setFn(modules, isFunction, i, 6, i % 2 === 0);
    }
    drawFinder(modules, isFunction, 3, 3);
    drawFinder(modules, isFunction, size - 4, 3);
    drawFinder(modules, isFunction, 3, size - 4);

    var aligns = alignmentPositions(version);
    for (var a = 0; a < aligns.length; a++) {
      for (var b = 0; b < aligns.length; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === aligns.length - 1) || (a === aligns.length - 1 && b === 0)) continue;
        drawAlignment(modules, isFunction, aligns[a], aligns[b]);
      }
    }

    drawFormat(modules, isFunction, 0, version);
    if (version >= 7) drawVersion(modules, isFunction, version);
  }

  function setFn(modules, isFunction, x, y, dark) {
    if (x < 0 || y < 0 || x >= modules.length || y >= modules.length) return;
    modules[y][x] = dark;
    isFunction[y][x] = true;
  }

  function drawFinder(modules, isFunction, cx, cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(modules, isFunction, cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawAlignment(modules, isFunction, cx, cy) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        setFn(modules, isFunction, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  function formatBits(mask) {
    var data = (0 << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(version) {
    var rem = version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
  }

  function bitAt(value, index) {
    return ((value >>> index) & 1) !== 0;
  }

  function drawFormat(modules, isFunction, mask, version) {
    var bits = formatBits(mask);
    var size = modules.length;
    for (var i = 0; i <= 5; i++) setFn(modules, isFunction, 8, i, bitAt(bits, i));
    setFn(modules, isFunction, 8, 7, bitAt(bits, 6));
    setFn(modules, isFunction, 8, 8, bitAt(bits, 7));
    setFn(modules, isFunction, 7, 8, bitAt(bits, 8));
    for (var j = 9; j < 15; j++) setFn(modules, isFunction, 14 - j, 8, bitAt(bits, j));
    for (var k = 0; k < 8; k++) setFn(modules, isFunction, size - 1 - k, 8, bitAt(bits, k));
    for (var m = 8; m < 15; m++) setFn(modules, isFunction, 8, size - 15 + m, bitAt(bits, m));
    setFn(modules, isFunction, 8, size - 8, true);
    void version;
  }

  function drawVersion(modules, isFunction, version) {
    if (version < 7) return;
    var bits = versionBits(version);
    var size = modules.length;
    for (var i = 0; i < 18; i++) {
      var bit = bitAt(bits, i);
      var a = size - 11 + (i % 3);
      var b = Math.floor(i / 3);
      setFn(modules, isFunction, a, b, bit);
      setFn(modules, isFunction, b, a, bit);
    }
  }

  function drawCodewords(modules, isFunction, data) {
    var size = modules.length;
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < data.length * 8) {
            modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  function maskCondition(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function applyMask(modules, isFunction, mask) {
    for (var y = 0; y < modules.length; y++) {
      for (var x = 0; x < modules.length; x++) {
        if (!isFunction[y][x] && maskCondition(mask, x, y)) modules[y][x] = !modules[y][x];
      }
    }
  }

  function penalty(modules) {
    var size = modules.length;
    var score = 0;
    var x, y, run, i;

    var runs = new Array(size + 1);
    for (i = 0; i <= size; i++) runs[i] = 0;
    for (y = 0; y < size; y++) {
      run = 1;
      for (x = 1; x < size; x++) {
        if (modules[y][x] === modules[y][x - 1]) run++;
        else {
          if (run >= 5) runs[run]++;
          run = 1;
        }
      }
      if (run >= 5) runs[run]++;
    }
    for (x = 0; x < size; x++) {
      run = 1;
      for (y = 1; y < size; y++) {
        if (modules[y][x] === modules[y - 1][x]) run++;
        else {
          if (run >= 5) runs[run]++;
          run = 1;
        }
      }
      if (run >= 5) runs[run]++;
    }
    for (i = 5; i <= size; i++) score += runs[i] * (i - 2);

    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var v = modules[y][x];
        if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) score += 3;
      }
    }

    function at(get, k) {
      return k >= 0 && k < size ? get(k) : false;
    }
    for (y = 0; y < size; y++) {
      (function (row) {
        var get = function (k) { return modules[row][k]; };
        for (var c = 0; c + 10 < size; c++) {
          if (!at(get, c + 1) && at(get, c + 4) && !at(get, c + 5) && at(get, c + 6) && !at(get, c + 9) &&
              ((at(get, c) && at(get, c + 2) && at(get, c + 3) &&
                !at(get, c + 7) && !at(get, c + 8) && !at(get, c + 10)) ||
               (!at(get, c) && !at(get, c + 2) && !at(get, c + 3) &&
                at(get, c + 7) && at(get, c + 8) && at(get, c + 10)))) score += 40;
          if (at(get, c + 10)) c++;
        }
      }(y));
    }
    for (x = 0; x < size; x++) {
      (function (col) {
        var get = function (k) { return modules[k][col]; };
        for (var r = 0; r + 10 < size; r++) {
          if (!at(get, r + 1) && at(get, r + 4) && !at(get, r + 5) && at(get, r + 6) && !at(get, r + 9) &&
              ((at(get, r) && at(get, r + 2) && at(get, r + 3) &&
                !at(get, r + 7) && !at(get, r + 8) && !at(get, r + 10)) ||
               (!at(get, r) && !at(get, r + 2) && !at(get, r + 3) &&
                at(get, r + 7) && at(get, r + 8) && at(get, r + 10)))) score += 40;
          if (at(get, r + 10)) r++;
        }
      }(x));
    }

    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (modules[y][x]) dark++;
    var total = size * size;
    var rating = Math.floor(Math.abs((dark * 100 / total) - 50) / 5);
    score += rating * 10;
    return score;
  }

  function encode(text, opts) {
    opts = opts || {};
    var bytes = utf8Bytes(String(text));
    var version = opts.version || chooseVersion(bytes.length);
    if (!version || !BLOCKS[version]) throw new Error('QR payload too large for supported versions (1-20)');
    var size = version * 4 + 17;
    var modules = newMatrix(size);
    var isFunction = newMatrix(size);
    drawFunctionPatterns(modules, isFunction, version);
    drawCodewords(modules, isFunction, buildCodewords(bytes, version));

    var forcedMask = typeof opts.mask === 'number' ? opts.mask : null;
    var best = null;
    if (forcedMask !== null) {
      applyMask(modules, isFunction, forcedMask);
      drawFormat(modules, isFunction, forcedMask, version);
      best = { mask: forcedMask, score: penalty(modules) };
    } else {
      var bestScore = Infinity;
      for (var m = 0; m < 8; m++) {
        applyMask(modules, isFunction, m);
        drawFormat(modules, isFunction, m, version);
        var s = penalty(modules);
        if (s < bestScore) {
          bestScore = s;
          best = { mask: m, score: s };
          var snapshot = modules.map(function (row) { return row.slice(); });
          best.matrix = snapshot;
        }
        applyMask(modules, isFunction, m);
      }
      modules = best.matrix;
    }
    return { size: size, version: version, mask: best.mask, modules: modules };
  }

  function toSvg(text, opts) {
    opts = opts || {};
    var qr = encode(text, opts);
    var margin = typeof opts.margin === 'number' ? opts.margin : 4;
    var dark = opts.dark || '#000000';
    var light = opts.light || '#ffffff';
    var total = qr.size + margin * 2;
    var path = '';
    for (var y = 0; y < qr.size; y++) {
      var x = 0;
      while (x < qr.size) {
        if (qr.modules[y][x]) {
          var run = 1;
          while (x + run < qr.size && qr.modules[y][x + run]) run++;
          path += 'M' + (x + margin) + ' ' + (y + margin) + 'h' + run + 'v1h-' + run + 'z';
          x += run;
        } else x++;
      }
    }
    var sizeAttr = typeof opts.px === 'number' ? ' width="' + opts.px + '" height="' + opts.px + '"' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '"' +
      sizeAttr + ' shape-rendering="crispEdges" role="img">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      '<path d="' + path + '" fill="' + dark + '"/></svg>';
  }

  return { encode: encode, svg: toSvg, penalty: penalty, BLOCKS: BLOCKS };
}));
