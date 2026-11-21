/* השבת אבידה – מפת חיפוש רחוב אחר רחוב */
(function () {
'use strict';

// ================= settings =================
var RINGS = [300, 600, 1000, 1500, 2000, 3000];   // search order rings (m)
var STREET_R = 3200;                              // load streets/places within (m)
var COVER_R = 30;                                 // a GPS point "covers" this radius (m)
var CELL = 15;                                    // coverage grid cell (m)
var MAX_ACC = 60;                                 // ignore GPS fixes worse than this (m)
var SEG_LEN = 50;                                 // split streets into pieces of ~this length (m)
var RING_DONE = 0.9;                              // ring counts as done at 90%
var SECTOR = 50;                                  // half-width of direction band (deg)
var KEY = 'hashavat_v1', KEY_STREETS = 'hashavat_streets_v1';
var OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
var TILE_DEG = 0.02;
var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// ================= state =================
function blank() {
  return { center: null, seenAt: null, speed: 3.5, dir: null, startedAt: null,
    track: [], marks: [], manual: {}, sightings: [], poiDone: {}, parkDone: {}, log: [],
    person: { name: '', desc: '', phone: '', photo: '' },
    opts: { service: true, pois: true, voice: true, mode: 'car', wazeTip: false } };
}
var S = blank();
try { var sv = JSON.parse(localStorage.getItem(KEY) || 'null'); if (sv) { S = Object.assign(blank(), sv); S.opts = Object.assign(blank().opts, sv.opts || {}); S.person = Object.assign(blank().person, sv.person || {}); } } catch (e) {}
var saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(function () { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('שמירה בטלפון נכשלה (אולי תמונה גדולה מדי)'); } }, 300); }
function log(t) { S.log.push([Date.now(), t]); save(); }
function $(id) { return document.getElementById(id); }
function hhmm(t) { return new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); }
function fmtM(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' ק"מ' : Math.round(m) + ' מ\''; }
function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

// ================= map =================
var map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(S.center || [31.5, 34.9], S.center ? 15 : 8);
var tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
var rnd = L.canvas({ padding: 0.5 });
var L_reach = L.layerGroup().addTo(map), L_rings = L.layerGroup().addTo(map), L_active = L.layerGroup().addTo(map),
    L_dir = L.layerGroup().addTo(map), L_streets = L.layerGroup().addTo(map), L_marks = L.layerGroup().addTo(map),
    L_guide = L.layerGroup().addTo(map), L_pois = L.layerGroup();
var coverBand = L.polyline([], { color: '#00c853', weight: 12, opacity: .28, lineCap: 'round', lineJoin: 'round', renderer: rnd, interactive: false }).addTo(map);
var trackLine = L.polyline([], { color: '#1e88e5', weight: 4, opacity: .9, renderer: rnd, interactive: false }).addTo(map);
var lastAcc = 1e9, me = null, meAcc = null, lastPos = null, heading = null, follow = true, pick = null;

// ================= geo =================
var mLat = 111320;
function mLng(lat) { return 111320 * Math.cos(lat * Math.PI / 180); }
function dist(a, b) { var dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
  var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 12742000 * Math.asin(Math.sqrt(x)); }
function bearing(a, b) { return (Math.atan2((b[1] - a[1]) * mLng(a[0]), (b[0] - a[0]) * mLat) * 180 / Math.PI + 360) % 360; }
function angDiff(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function offset(c, m, deg) { var t = deg * Math.PI / 180; return [c[0] + m * Math.cos(t) / mLat, c[1] + m * Math.sin(t) / mLng(c[0])]; }
function inSector(p) { if (S.dir == null || !S.center) return true; return dist(S.center, p) < 120 || angDiff(bearing(S.center, p), S.dir) <= SECTOR; }
function ringOf(d) { for (var i = 0; i < RINGS.length; i++) if (d <= RINGS[i]) return i; return -1; }
function bandWeight() { var c = map.getCenter(); var mpp = 156543.03 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, map.getZoom()); return Math.max(8, 40 / mpp); }
map.on('zoomend', function () { coverBand.setStyle({ weight: bandWeight() }); updatePoiVisibility(); });

// ---- coverage grid ----
var covered = {}, LNG0 = mLng(S.center ? S.center[0] : 31.5);
function ck(i, j) { return i + ':' + j; }
function cellOf(lat, lng) { return [Math.floor(lat * mLat / CELL), Math.floor(lng * LNG0 / CELL)]; }
function coverPoint(lat, lng) {
  var n = Math.ceil(COVER_R / CELL), c = cellOf(lat, lng), lim = COVER_R * COVER_R + CELL * CELL;
  for (var i = -n; i <= n; i++) for (var j = -n; j <= n; j++) if ((i * i + j * j) * CELL * CELL <= lim) covered[ck(c[0] + i, c[1] + j)] = 1;
}
function isCov(p) { var c = cellOf(p[0], p[1]); return !!covered[ck(c[0], c[1])]; }
function rebuildCoverage() {
  covered = {}; LNG0 = mLng(S.center ? S.center[0] : 31.5);
  var prev = null;
  S.track.forEach(function (p) { if (prev) fillBetween(prev, p); coverPoint(p[0], p[1]); prev = p; });
  S.marks.forEach(function (m) { coverPoint(m[0], m[1]); });
}
function fillBetween(a, b) { var d = dist(a, b); if (d > 400) return; var n = Math.floor(d / 12); for (var k = 1; k < n; k++) { var t = k / n; coverPoint(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); } }
rebuildCoverage();

// ================= streets =================
var segs = [];
var CLS_NAME = ['רחוב ללא שם', 'דרך שירות / חניון / סמטה', 'דרך עפר', 'שביל להולכי רגל'];
function countable(s) { return S.opts.mode === 'foot' || s.cls < 3; }
function segVisited(s) { return !!S.manual[s.id] || isCov(s.mid) || (isCov(s.a) && isCov(s.b)); }
function styleSeg(s) {
  if (!countable(s)) return { color: s.visited ? '#43a047' : '#9e9e9e', weight: 2, opacity: .7, dashArray: '3 5' };
  var w = [6, 4, 4, 3][s.cls] || 6;
  return { color: s.visited ? '#43a047' : (s.cls === 0 ? '#e53935' : '#ff7043'), weight: w, opacity: .8, dashArray: s.cls >= 2 ? '6 4' : null };
}

function overpass(q, ms) {
  ms = ms || 25000;
  return new Promise(function (res, rej) {
    (function go(i) {
      if (i >= OVERPASS.length) return rej(new Error('blocked'));
      var ctl = ('AbortController' in window) ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
      fetch(OVERPASS[i], { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl ? ctl.signal : undefined })
        .then(function (r) { clearTimeout(to); if (!r.ok) throw 0; return r.json(); }).then(res).catch(function () { clearTimeout(to); go(i + 1); });
    })(0);
  });
}

function tileKeys(c, r) {
  var dLat = r / mLat, dLng = r / mLng(c[0]), keys = [];
  for (var a = Math.floor((c[0] - dLat) / TILE_DEG); a <= Math.floor((c[0] + dLat) / TILE_DEG); a++)
    for (var b = Math.floor((c[1] - dLng) / TILE_DEG); b <= Math.floor((c[1] + dLng) / TILE_DEG); b++) keys.push(a + '_' + b);
  return keys;
}
function loadLocal(c) {
  return Promise.all(tileKeys(c, STREET_R).map(function (k) {
    return fetch('data/t/' + k + '.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  })).then(function (list) {
    var got = list.filter(Boolean); if (!got.length) throw new Error('no local data');
    var seenW = {}, seenP = {}, seenA = {}, ways = [], ps = [], parks = [];
    got.forEach(function (t) {
      (t.w || []).forEach(function (w) { if (!seenW[w[0]]) { seenW[w[0]] = 1; ways.push(w); } });
      (t.p || []).forEach(function (p) { if (!seenP[p[0]] && dist(c, [p[3], p[4]]) <= STREET_R) { seenP[p[0]] = 1; ps.push(p); } });
      (t.a || []).forEach(function (a) { if (!seenA[a[0]] && a[2].length > 2 && dist(c, a[2][0]) <= STREET_R) { seenA[a[0]] = 1; parks.push(a); } });
    });
    return { ways: ways, pois: ps, parks: parks };
  });
}
function loadStreets(force) {
  if (!S.center) return;
  L_streets.clearLayers(); segs = [];
  if (!force) {
    try { var c = JSON.parse(localStorage.getItem(KEY_STREETS) || 'null');
      if (c && c.center && dist(c.center, S.center) < 50) { rawParks = c.parks || []; buildSegs(c.ways); buildPois(c.pois || []); toast('הרחובות נטענו מהזיכרון'); return; } } catch (e) {}
  }
  toast('טוען רחובות ומקומות באזור…', 15000);
  loadLocal(S.center).then(function (d) {
    try { localStorage.setItem(KEY_STREETS, JSON.stringify({ center: S.center, ways: d.ways, pois: d.pois, parks: d.parks })); } catch (e) {}
    rawParks = d.parks; buildSegs(d.ways); buildPois(d.pois);
    toast('נטענו ' + d.ways.length + ' רחובות ושבילים, ' + d.parks.length + ' חניונים ו-' + d.pois.length + ' מקומות לבדיקה', 3500);
  }).catch(function () { loadOverpass(); });
}
function loadOverpass() {
  var hw = 'primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|trunk|primary_link|secondary_link|tertiary_link|road|service|track|footway|path|steps';
  var c0 = S.center[0] + ',' + S.center[1];
  var q = '[out:json][timeout:60];(way(around:' + STREET_R + ',' + c0 + ')[highway~"^(' + hw + ')$"];' +
    'node(around:' + STREET_R + ',' + c0 + ')[highway=bus_stop];' +
    'nwr(around:' + STREET_R + ',' + c0 + ')[amenity~"^(bench|bus_station|fuel|pharmacy|shelter|police|hospital|clinic|toilets)$"];' +
    'nwr(around:' + STREET_R + ',' + c0 + ')[amenity=place_of_worship][religion=jewish];' +
    'nwr(around:' + STREET_R + ',' + c0 + ')[tourism~"^(hotel|hostel|guest_house|motel)$"];' +
    'nwr(around:' + STREET_R + ',' + c0 + ')[leisure~"^(park|playground)$"];' +
    'nwr(around:' + STREET_R + ',' + c0 + ')[shop~"^(supermarket|convenience|kiosk|mall)$"];' +
    ');out center geom qt;';
  overpass(q).then(function (data) {
    var ways = [], pois = [];
    data.elements.forEach(function (e) {
      var t = e.tags || {};
      if (e.type === 'way' && t.highway && e.geometry) {
        var cl = { service: 1, track: 2, footway: 3, path: 3, steps: 3, pedestrian: 3 }[t.highway] || 0;
        var ow = (t.oneway === 'yes' || t.junction === 'roundabout') ? 1 : (t.oneway === '-1' ? -1 : 0);
        ways.push([e.id, t['name:he'] || t.name || '', cl, e.geometry.map(function (g) { return [+g.lat.toFixed(6), +g.lon.toFixed(6)]; }), cl < 3 ? ow : 0]);
      } else {
        var ll = e.type === 'node' ? [e.lat, e.lon] : (e.center ? [e.center.lat, e.center.lon] : null);
        if (!ll) return; var k = poiKind(t); if (!k) return;
        pois.push([e.type[0] + e.id, k, t['name:he'] || t.name || '', +ll[0].toFixed(6), +ll[1].toFixed(6)]);
      }
    });
    try { localStorage.setItem(KEY_STREETS, JSON.stringify({ center: S.center, ways: ways, pois: pois })); } catch (e) {}
    buildSegs(ways); buildPois(pois);
    toast('נטענו ' + ways.length + ' רחובות ו-' + pois.length + ' מקומות לבדיקה', 3000);
  }).catch(function () {
    sheet('<h2>לא הצלחתי לטעון את רשימת הרחובות</h2><p>ייתכן שהשירות overpass-api.de חסום ברשת (למשל בסינון של נטפרי – אפשר לבקש מהם לפתוח אותו) או שאין קליטה. המיקום, המסלול, האזור שנסרק והמעגלים ממשיכים לעבוד, רק בלי צביעת רחובות ובלי ניווט לרחוב הבא.</p>',
      [['נסה שוב', function () { closeSheet(); loadStreets(true); }, 'primary'], ['המשך בלי', closeSheet]]);
  });
}
var rawWays = [], rawParks = [];
function buildSegs(ways) {
  if (ways) rawWays = ways; ways = rawWays;
  L_streets.clearLayers(); segs = [];
  ways.forEach(function (w) {
    var id = w[0], cls = +w[2] || 0, name = w[1] || CLS_NAME[cls], g = w[3];
    if ((cls === 1 || cls === 2) && !S.opts.service) return;
    for (var k = 0; k < g.length - 1; k++) {
      var a = g[k], b = g[k + 1], len = dist(a, b), parts = Math.max(1, Math.ceil(len / SEG_LEN));
      for (var p = 0; p < parts; p++) {
        var t0 = p / parts, t1 = (p + 1) / parts;
        var pa = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], pb = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
        var mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], rg = ringOf(dist(S.center, mid));
        if (rg < 0) continue;
        var s = { id: id + '_' + k + '_' + p, way: id, na: a, nb: b, a: pa, b: pb, mid: mid, name: name, len: len / parts, ring: rg, cls: cls };
        s.visited = segVisited(s);
        s.poly = L.polyline([pa, pb], Object.assign({ renderer: rnd }, styleSeg(s))).addTo(L_streets);
        s.poly.on('click', segClick.bind(null, s));
        segs.push(s);
      }
    }
  });
  buildParks(); buildGraph();
  stats(); if (navOn) pickNext(true);
}
function segClick(s, ev) {
  L.DomEvent.stopPropagation(ev);
  if (pick) { var cb = pick; pick = null; $('toast').style.display = 'none'; return cb([ev.latlng.lat, ev.latlng.lng]); }
  var pop = L.popup().setLatLng(s.mid).setContent('<b>' + esc(s.name) + '</b><br>' + (s.visited ? 'נבדק ✓' : 'לא נבדק') +
    '<br><button id="pt">' + (S.manual[s.id] ? 'בטל סימון ידני' : (s.visited ? 'נבדק אוטומטית' : 'סמן כנבדק (נבדק ברגל)')) + '</button>').openOn(map);
  setTimeout(function () { var b = $('pt'); if (b) b.onclick = function () { if (S.manual[s.id]) delete S.manual[s.id]; else S.manual[s.id] = 1; save(); refreshSeg(s); stats(); map.closePopup(pop); }; }, 0);
}
function refreshSeg(s) { var v = segVisited(s); if (v !== s.visited) { s.visited = v; s.poly.setStyle(styleSeg(s)); } }
function refreshNear(lat, lng) {
  for (var i = 0; i < segs.length; i++) { var s = segs[i]; if (!s.visited && Math.abs(s.mid[0] - lat) < 0.0008 && Math.abs(s.mid[1] - lng) < 0.0009) refreshSeg(s); }
  for (var j = 0; j < parks.length; j++) { var k = parks[j]; if (!k.visited && lat > k.bb[0] - 0.0005 && lat < k.bb[2] + 0.0005 && lng > k.bb[1] - 0.0005 && lng < k.bb[3] + 0.0005) refreshPark(k); }
}

// ---------- parking lots ----------
var parks = [], L_parks = L.layerGroup().addTo(map);
S.parkDone = S.parkDone || {};
function inPoly(pt, poly) { var x = pt[1], y = pt[0], c = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) { var xi = poly[i][1], yi = poly[i][0], xj = poly[j][1], yj = poly[j][0];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; }
function parkVisited(k) {
  if (S.parkDone[k.id]) return true;
  var cov = 0; for (var i = 0; i < k.samples.length; i++) if (isCov(k.samples[i])) cov++;
  return cov / k.samples.length >= 0.3;
}
function stylePark(k) { return { color: '#ff6f00', weight: 2, fillColor: k.visited ? '#00c853' : '#ff9800', fillOpacity: k.visited ? .35 : .25 }; }
function buildParks() {
  L_parks.clearLayers(); parks = [];
  rawParks.forEach(function (a) {
    var poly = a[2], bb = [90, 180, -90, -180];
    poly.forEach(function (p) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); });
    var mid = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], rg = ringOf(dist(S.center, mid)); if (rg < 0) return;
    var samples = [], stLat = 12 / mLat, stLng = 12 / mLng(mid[0]);
    for (var la = bb[0]; la <= bb[2]; la += stLat) for (var ln = bb[1]; ln <= bb[3]; ln += stLng) if (inPoly([la, ln], poly)) samples.push([la, ln]);
    if (!samples.length) samples.push(mid);
    var k = { id: a[0], name: a[1] || 'חניון', outline: poly, bb: bb, mid: mid, ring: rg, samples: samples };
    k.visited = parkVisited(k);
    k.layer = L.polygon(poly, Object.assign({ renderer: rnd }, stylePark(k))).addTo(L_parks);
    k.layer.on('click', function (ev) {
      L.DomEvent.stopPropagation(ev);
      if (pick) { var cb = pick; pick = null; $('toast').style.display = 'none'; return cb([ev.latlng.lat, ev.latlng.lng]); }
      var pop = L.popup().setLatLng(ev.latlng).setContent('<b>🅿️ ' + esc(k.name) + '</b><br>' + (k.visited ? 'נבדק ✓' : 'לא נבדק') + '<br><button id="pk">' + (S.parkDone[k.id] ? 'בטל סימון' : 'סמן: בדקתי את החניון') + '</button>').openOn(map);
      setTimeout(function () { var b = $('pk'); if (b) b.onclick = function () { if (S.parkDone[k.id]) delete S.parkDone[k.id]; else { S.parkDone[k.id] = Date.now(); log('נבדק חניון: ' + k.name); } save(); refreshPark(k); map.closePopup(pop); updateNav(); }; }, 0);
    });
    parks.push(k);
  });
}
function refreshPark(k) { var v = parkVisited(k); if (v !== k.visited) { k.visited = v; k.layer.setStyle(stylePark(k)); if (v) log('נסרק חניון: ' + k.name); } }

// ================= places to check (POI) =================
var POI = { bus: ['🚏', 'תחנת אוטובוס'], bench: ['🪑', 'ספסל'], park: ['🌳', 'פארק / גינה'], hotel: ['🏨', 'מלון'], fuel: ['⛽', 'תחנת דלק'],
  pharm: ['💊', 'בית מרקחת'], shop: ['🏪', 'מכולת / סופר'], shelter: ['⛱️', 'מחסה / צל'], police: ['🚓', 'משטרה'], hosp: ['🏥', 'מרפאה / בית חולים'],
  syn: ['🕍', 'בית כנסת'], wc: ['🚻', 'שירותים ציבוריים'], mall: ['🛍️', 'קניון'] };
function poiKind(t) {
  if (t.highway === 'bus_stop' || t.amenity === 'bus_station') return 'bus';
  if (t.amenity === 'bench') return 'bench'; if (t.amenity === 'fuel') return 'fuel'; if (t.amenity === 'pharmacy') return 'pharm';
  if (t.amenity === 'shelter') return 'shelter'; if (t.amenity === 'police') return 'police'; if (t.amenity === 'hospital' || t.amenity === 'clinic') return 'hosp';
  if (t.amenity === 'toilets') return 'wc'; if (t.amenity === 'place_of_worship') return 'syn';
  if (t.tourism) return 'hotel'; if (t.leisure) return 'park'; if (t.shop === 'mall') return 'mall'; if (t.shop) return 'shop';
  return null;
}
var pois = [];
function buildPois(list) {
  L_pois.clearLayers(); pois = [];
  list.forEach(function (p) {
    var o = { id: p[0], k: p[1], name: p[2], ll: [p[3], p[4]] };
    var ic = POI[o.k] || ['📍', ''];
    o.m = L.marker(o.ll, { icon: poiIcon(o) }).addTo(L_pois);
    o.m.on('click', function () {
      var done = !!S.poiDone[o.id];
      var pop = L.popup().setLatLng(o.ll).setContent('<b>' + ic[0] + ' ' + esc(o.name || ic[1]) + '</b><br>' + ic[1] + (done ? '<br>נבדק בשעה ' + hhmm(S.poiDone[o.id]) : '') +
        '<br><button id="pp">' + (done ? 'בטל סימון' : 'סמן: בדקתי כאן') + '</button>').openOn(map);
      setTimeout(function () { var b = $('pp'); if (b) b.onclick = function () { if (S.poiDone[o.id]) delete S.poiDone[o.id]; else { S.poiDone[o.id] = Date.now(); log('נבדק: ' + ic[1] + (o.name ? ' – ' + o.name : '')); } o.m.setIcon(poiIcon(o)); save(); map.closePopup(pop); }; }, 0);
    });
    pois.push(o);
  });
  updatePoiVisibility();
}
function poiIcon(o) { var ic = POI[o.k] || ['📍']; return L.divIcon({ html: '<div class="poi' + (S.poiDone[o.id] ? ' done' : '') + '">' + ic[0] + '</div>', className: '', iconSize: [22, 22], iconAnchor: [11, 11] }); }
function updatePoiVisibility() { var show = S.opts.pois && map.getZoom() >= 16; if (show && !map.hasLayer(L_pois)) map.addLayer(L_pois); if (!show && map.hasLayer(L_pois)) map.removeLayer(L_pois); }
var poiWarned = {};
function poiNearby(ll) {
  if (!S.opts.pois) return;
  for (var i = 0; i < pois.length; i++) { var o = pois[i]; if (S.poiDone[o.id] || poiWarned[o.id]) continue;
    if (o.k === 'bench' || o.k === 'shop' || o.k === 'pharm' || o.k === 'wc') continue;
    if (Math.abs(o.ll[0] - ll[0]) < 0.0006 && dist(ll, o.ll) < 50) { poiWarned[o.id] = 1; var ic = POI[o.k]; toast(ic[0] + ' ' + ic[1] + ' בצד שלך – כדאי להציץ', 5000); say(ic[1] + ' בצד שלך'); break; } }
}

// ================= rings, reach, direction =================
function minutesSince(t) { return Math.max(0, (Date.now() - t) / 60000); }
function reachM() { if (!S.seenAt) return 0; return Math.min(30000, S.speed * 1000 / 60 * minutesSince(S.seenAt)); }
var reachCircle = null;
function drawReach() {
  if (!S.center || !S.seenAt) { L_reach.clearLayers(); reachCircle = null; $('sReach').textContent = ''; return; }
  var r = reachM();
  if (!reachCircle) { L_reach.clearLayers(); reachCircle = L.circle(S.center, { radius: Math.max(r, 20), color: '#6a1b9a', weight: 2, dashArray: '2 6', fillColor: '#ce93d8', fillOpacity: .07, interactive: false }).addTo(L_reach); }
  else reachCircle.setLatLng(S.center).setRadius(Math.max(r, 20));
  var mins = Math.round(minutesSince(S.seenAt));
  $('sReach').textContent = 'טווח הליכה: ' + fmtM(r) + ' (' + (mins < 60 ? mins + ' דק\'' : Math.floor(mins / 60) + ':' + ('0' + mins % 60).slice(-2) + ' שע\'') + ')';
}
setInterval(drawReach, 30000);

function drawRings() {
  L_rings.clearLayers(); lastActiveKey = '';
  if (!S.center) return;
  L.marker(S.center, { icon: L.divIcon({ html: '<div style="font-size:26px">🎯</div>', className: '', iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false }).addTo(L_rings);
  RINGS.forEach(function (r) {
    L.circle(S.center, { radius: r, color: '#6a1b9a', weight: 1.5, opacity: .6, fill: false, dashArray: '6 6', interactive: false }).addTo(L_rings);
    L.marker(offset(S.center, r, 0), { icon: L.divIcon({ html: '<div class="lab">' + fmtM(r) + '</div>', className: '', iconSize: null }), interactive: false }).addTo(L_rings);
  });
  S.sightings.forEach(function (s) {
    L.marker([s[0], s[1]], { icon: L.divIcon({ html: '<div style="font-size:22px">👁️</div>', className: '', iconSize: [24, 24], iconAnchor: [12, 12] }) })
      .bindPopup('דווח שנראה כאן בשעה ' + hhmm(s[2])).addTo(L_rings);
  });
}
function drawDir() {
  L_dir.clearLayers(); if (S.dir == null || !S.center) return;
  var r = RINGS[RINGS.length - 1], pts = [S.center];
  for (var a = S.dir - SECTOR; a <= S.dir + SECTOR; a += 5) pts.push(offset(S.center, r, a));
  L.polygon(pts, { color: '#ff6f00', weight: 2, fillColor: '#ffb300', fillOpacity: .10, interactive: false }).addTo(L_dir);
  L.polyline([S.center, offset(S.center, r, S.dir)], { color: '#ff6f00', weight: 4, dashArray: '10 6', interactive: false }).addTo(L_dir);
}
var lastActiveKey = '', curTarget = 0;
function ringProgress() {
  var ra = RINGS.map(function () { return 0; }), rv = ra.slice();
  segs.forEach(function (s) { if (!countable(s) || !inSector(s.mid)) return; ra[s.ring] += s.len; if (s.visited) rv[s.ring] += s.len; });
  var frac = ra.map(function (a, i) { return a ? rv[i] / a : 1; });
  var t = 0; while (t < RINGS.length - 1 && frac[t] >= RING_DONE) t++;
  return { ra: ra, rv: rv, frac: frac, target: t };
}
function drawActive(pr) {
  var key = pr.target + '|' + S.center + '|' + S.dir + '|' + pr.frac.map(function (f) { return f >= RING_DONE ? 1 : 0; }).join('');
  if (key === lastActiveKey) return;
  var grew = lastActiveKey && pr.target > curTarget;
  lastActiveKey = key; curTarget = pr.target; L_active.clearLayers();
  for (var i = 0; i <= pr.target; i++) {
    var done = pr.frac[i] >= RING_DONE;
    L.circle(S.center, { radius: RINGS[i], stroke: i === pr.target, color: '#ff6f00', weight: 3, fillColor: done ? '#00c853' : '#ffb300', fillOpacity: i === pr.target ? .10 : .05, interactive: false }).addTo(L_active);
  }
  if (grew) { var m = 'המעגל הושלם – מתרחבים ל-' + fmtM(RINGS[pr.target]); toast(m, 4000); say(m); log(m); }
}

// ================= stats =================
function stats() {
  var tot = 0; for (var i = 1; i < S.track.length; i++) { var d = dist(S.track[i - 1], S.track[i]); if (d < 400) tot += d; }
  $('sDist').textContent = 'נסעת ' + fmtM(tot);
  var el = $('rings'); el.innerHTML = '';
  if (!segs.length) { $('sStreets').textContent = S.center ? '' : 'אין חיפוש פעיל'; return; }
  var pr = ringProgress(), vis = 0, all = 0;
  pr.ra.forEach(function (a, i) { all += a; vis += pr.rv[i]; });
  $('sStreets').textContent = 'נבדקו ' + (all ? Math.round(100 * vis / all) : 0) + '% מהרחובות' + (S.dir != null ? ' בכיוון' : '');
  RINGS.forEach(function (r, i) {
    var pct = Math.round(100 * pr.frac[i]), d = document.createElement('span');
    d.className = 'rp' + (i === pr.target ? ' act' : ''); d.textContent = fmtM(r) + ' ' + pct + '%';
    if (pct >= RING_DONE * 100) d.style.background = '#c8e6c9'; else if (pct > 0) d.style.background = '#fff3c4';
    el.appendChild(d);
  });
  drawActive(pr);
}

// ================= GPS =================
function onPos(p) {
  var lat = p.coords.latitude, lng = p.coords.longitude, acc = p.coords.accuracy, ll = [lat, lng];
  if (p.coords.heading != null && !isNaN(p.coords.heading) && p.coords.speed > 1) heading = p.coords.heading;
  $('sGps').textContent = '📡 דיוק ' + Math.round(acc) + ' מ\'' + (acc > MAX_ACC ? ' – חלש, לא נרשם' : '');
  if (!me) {
    me = L.circleMarker(ll, { radius: 9, color: '#fff', weight: 3, fillColor: '#1565c0', fillOpacity: 1, interactive: false }).addTo(map);
    meAcc = L.circle(ll, { radius: acc, color: '#1565c0', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
    if (!S.center) map.setView(ll, 16);
  } else { me.setLatLng(ll); meAcc.setLatLng(ll).setRadius(acc); }
  lastPos = ll; lastAcc = acc;
  if (follow && !pick) map.panTo(ll, { animate: true });
  if (!S.center || acc > MAX_ACC) { updateNav(); return; }
  var prev = S.track[S.track.length - 1];
  if (prev && dist(prev, ll) < 8) { updateNav(); return; }
  if (prev && dist(prev, ll) > 300 && (Date.now() - prev[2]) < 20000) return;       // GPS jump
  if (prev) fillBetween(prev, ll);
  S.track.push([+lat.toFixed(6), +lng.toFixed(6), Date.now()]);
  coverPoint(lat, lng); trackLine.addLatLng(ll); coverBand.addLatLng(ll); refreshNear(lat, lng);
  save(); stats(); updateNav(); poiNearby(ll);
}
function onErr(e) {
  $('sGps').textContent = e.code === 1 ? '⚠️ אין הרשאת מיקום' : '⚠️ אין מיקום';
  if (e.code === 1 && !onErr.shown) { onErr.shown = 1; sheet('<h2>אין הרשאת מיקום</h2><p>בלי מיקום המפה לא יודעת איפה עברת.</p><p class="hint">באנדרואיד: לחץ על סמל המנעול ליד הכתובת ← הרשאות ← מיקום ← אפשר. ואז רענן את הדף.<br>באייפון: הגדרות ← פרטיות ← שירותי מיקום ← Safari ← בזמן השימוש.</p>', [['הבנתי', closeSheet]]); }
}
var watchId = null;
function startGps() { if (!('geolocation' in navigator)) return onErr({ code: 2 }); if (watchId != null) return; watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }); }

// keep the screen on
var wake = null;
function keepAwake() { try { if (navigator.wakeLock && !wake) navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }).catch(function () {}); } catch (e) {} }
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') keepAwake(); });
document.addEventListener('click', keepAwake);

// ================= voice =================
function say(t) {
  if (!S.opts.voice || !('speechSynthesis' in window)) return;
  try { var u = new SpeechSynthesisUtterance(t); u.lang = 'he-IL'; u.rate = 1; var v = speechSynthesis.getVoices().filter(function (v) { return /^he|^iw/i.test(v.lang); })[0]; if (v) u.voice = v; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {}
}

// ================= routing graph (runs on the phone, no server) =================
var G = null;
function nk(p) { return p[0].toFixed(6) + ',' + p[1].toFixed(6); }
function buildGraph() {
  var idx = {}, ll = [], adj = [], names = [], foot = S.opts.mode === 'foot';
  function node(p) { var k = nk(p), i = idx[k]; if (i == null) { i = idx[k] = ll.length; ll.push(p); adj.push([]); } return i; }
  rawWays.forEach(function (w) {
    var cls = +w[2] || 0, ow = foot ? 0 : (+w[4] || 0), g = w[3];
    if (!foot && cls === 3) return;
    var ni = names.length; names.push(w[1] || CLS_NAME[cls]);
    var pen = cls === 0 ? 1 : (cls === 1 ? 1.3 : 1.6);
    for (var i = 0; i < g.length - 1; i++) {
      var u = node(g[i]), v = node(g[i + 1]), d = dist(g[i], g[i + 1]);
      if (ow >= 0) adj[u].push([v, d * pen, ni]);
      if (ow <= 0) adj[v].push([u, d * pen, ni]);
    }
  });
  var grid = {};
  for (var i = 0; i < ll.length; i++) { var k = Math.floor(ll[i][0] * mLat / 100) + ':' + Math.floor(ll[i][1] * LNG0 / 100); (grid[k] = grid[k] || []).push(i); }
  G = { ll: ll, adj: adj, names: names, grid: grid, idx: idx };
}
function nearestNode(p, maxM, needOut) {
  if (!G) return -1;
  var ci = Math.floor(p[0] * mLat / 100), cj = Math.floor(p[1] * LNG0 / 100), best = -1, bd = maxM, r = Math.ceil(maxM / 100);
  for (var a = -r; a <= r; a++) for (var b = -r; b <= r; b++) { var c = G.grid[(ci + a) + ':' + (cj + b)]; if (!c) continue;
    for (var i = 0; i < c.length; i++) { if (needOut && !G.adj[c[i]].length) continue; var d = dist(p, G.ll[c[i]]); if (d < bd) { bd = d; best = c[i]; } } }
  return best;
}
function nearestEdge(p, maxM) {
  var ci = Math.floor(p[0] * mLat / 100), cj = Math.floor(p[1] * LNG0 / 100), best = null, bd = maxM;
  for (var a = -2; a <= 2; a++) for (var b = -2; b <= 2; b++) { var c = G.grid[(ci + a) + ':' + (cj + b)]; if (!c) continue;
    for (var i = 0; i < c.length; i++) { var u = c[i], A = G.adj[u];
      for (var k = 0; k < A.length; k++) { var v = A[k][0], pa = G.ll[u], pb = G.ll[v], kx = mLng(pa[0]);
        var bx = (pb[1] - pa[1]) * kx, by = (pb[0] - pa[0]) * mLat, px = (p[1] - pa[1]) * kx, py = (p[0] - pa[0]) * mLat;
        var L2 = bx * bx + by * by, t = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0, dx = px - t * bx, dy = py - t * by, d = Math.sqrt(dx * dx + dy * dy);
        if (d < bd) { bd = d; var len = Math.sqrt(L2); best = { u: u, v: v, t: t, d: d, du: t * len, dv: (1 - t) * len, ni: A[k][2] }; } } } }
  return best;
}
function hasEdge(u, v) { var A = G.adj[u]; for (var i = 0; i < A.length; i++) if (A[i][0] === v) return true; return false; }
function dijkstra(srcs, targets) {
  var n = G.ll.length, D = new Float64Array(n).fill(Infinity), P = new Int32Array(n).fill(-1), E = new Int32Array(n).fill(-1);
  var h = [];
  srcs.forEach(function (sc) { if (sc[1] < D[sc[0]]) { D[sc[0]] = sc[1]; E[sc[0]] = sc[2] == null ? -1 : sc[2]; h.push([sc[1], sc[0]]); } });
  h.sort(function (a, b) { return a[0] - b[0]; });
  function push(x) { h.push(x); var i = h.length - 1; while (i > 0) { var j = (i - 1) >> 1; if (h[j][0] <= h[i][0]) break; var t = h[i]; h[i] = h[j]; h[j] = t; i = j; } }
  function pop() { var top = h[0], last = h.pop(); if (h.length) { h[0] = last; var i = 0; for (;;) { var l = 2 * i + 1, r = l + 1, m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break; var t = h[i]; h[i] = h[m]; h[m] = t; i = m; } } return top; }
  var steps = 0;
  while (h.length) {
    var cur = pop(), u = cur[1]; if (cur[0] > D[u]) continue;
    if (targets[u]) { var path = [], ns = []; for (var x = u; x !== -1; x = P[x]) { path.push(x); ns.push(E[x]); } return { path: path.reverse(), names: ns.reverse() }; }
    if (++steps > 300000) break;
    var A = G.adj[u]; for (var i = 0; i < A.length; i++) { var v = A[i][0], nd = D[u] + A[i][1]; if (nd < D[v]) { D[v] = nd; P[v] = u; E[v] = A[i][2]; push([nd, v]); } }
  }
  return null;
}
function turnWord(ang) {
  var a = Math.abs(ang), side = ang > 0 ? 'ימינה' : 'שמאלה';
  if (a > 150) return ['פרסה', '↶'];
  if (a > 60) return ['פנה ' + side, ang > 0 ? '↱' : '↰'];
  return ['פנה קלות ' + side, ang > 0 ? '↗' : '↖'];
}
function makeRoute(from, seg) {
  if (!G) return null;
  var srcs = [], e = nearestEdge(from, 60);
  if (e) {
    srcs.push([e.v, e.dv, e.ni]);
    if (hasEdge(e.v, e.u)) srcs.push([e.u, e.du, e.ni]);
    // already on the target's own street piece → just drive along it
    if (seg.na && ((nk(G.ll[e.u]) === nk(seg.na) && nk(G.ll[e.v]) === nk(seg.nb)) || (nk(G.ll[e.u]) === nk(seg.nb) && nk(G.ll[e.v]) === nk(seg.na)))) {
      var dd = dist(from, seg.mid); return { pts: [from, seg.mid], cum: [0, dd], instr: [], len: dd }; }
  } else { var src = nearestNode(from, 250, true); if (src < 0) return null; srcs.push([src, dist(from, G.ll[src])]); }
  var tg = {}, t1, t2;
  if (seg.na) { t1 = G.idx[nk(seg.na)]; t2 = G.idx[nk(seg.nb)]; }
  if (t1 == null) t1 = nearestNode(seg.a || seg.mid, 150); if (t2 == null) t2 = nearestNode(seg.b || seg.mid, 150);
  if (t1 >= 0) tg[t1] = 1; if (t2 >= 0) tg[t2] = 1;
  if (!Object.keys(tg).length) return null;
  var r = dijkstra(srcs, tg); if (!r) return null;
  var pts = [from].concat(r.path.map(function (i) { return G.ll[i]; })), cum = [0];
  pts.push(seg.mid);   // finish on the target itself
  for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  // r.names[k] = street of the edge arriving at r.path[k] (= pts[k+1])
  var instr = [];
  for (var k = 1; k < r.path.length - 1; k++) {
    var pi = k + 1, bin = bearing(pts[pi - 1], pts[pi]), bout = bearing(pts[pi], pts[pi + 1]);
    var ang = ((bout - bin + 540) % 360) - 180, nmIn = r.names[k], nmOut = r.names[k + 1];
    if (Math.abs(ang) > 35 || (nmIn !== nmOut && Math.abs(ang) > 20)) { var tw = turnWord(ang); instr.push({ i: pi, text: tw[0], icon: tw[1], name: G.names[nmOut] || '' }); }
  }
  return { pts: pts, cum: cum, instr: instr, len: cum[cum.length - 1] };
}
function projOnRoute(rt, p) {
  var best = 1e12, bi = 0, bt = 0;
  for (var i = 0; i < rt.pts.length - 1; i++) {
    var a = rt.pts[i], b = rt.pts[i + 1], kx = mLng(a[0]);
    var bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * mLat, px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * mLat;
    var L2 = bx * bx + by * by, t = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
    var dx = px - t * bx, dy = py - t * by, d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) { best = d; bi = i; bt = t; }
  }
  return { off: best, along: rt.cum[bi] + bt * (rt.cum[bi + 1] - rt.cum[bi]) };
}

// ================= navigation =================
var lastArr = { name: '', t: 0 }, navOn = false, navT = null, skipped = {}, navFirst = true, lastSaid = 0, route = null, offCount = 0, lastRoute = 0, spoken = {};
function candidates(from, pr, reach) {
  var best = null, bd = 1e12;
  function consider(o, d, useSec, useReach) {
    if (useSec && !inSector(o.mid)) return; if (useReach && reach > 200 && dist(S.center, o.mid) > reach * 1.15) return;
    if (d < bd) { bd = d; best = o; } }
  for (var pass = 0; pass < 3 && !best; pass++) {
    var useSec = pass < 2, useReach = pass < 1;
    for (var i = 0; i < segs.length; i++) { var s = segs[i];
      if (s.visited || skipped[s.id] || s.ring > pr.target || !countable(s)) continue;
      consider(s, dist(from, s.mid) * (s.cls === 0 ? 1 : 1.25), useSec, useReach); }
    for (var j = 0; j < parks.length; j++) { var k = parks[j];
      if (k.visited || skipped[k.id] || k.ring > pr.target) continue;
      consider(k, dist(from, k.mid) * 0.8, useSec, useReach); }
  }
  return best ? { o: best, d: bd } : null;
}
function targetName() { return navT ? (navT.outline ? '🅿️ ' + navT.name : navT.name) : ''; }
function pickNext(quiet) {
  L_guide.clearLayers(); navT = null; route = null;
  if (!segs.length && !parks.length) { $('nav').style.display = 'none'; if (!quiet) toast(S.center ? 'אין רשימת רחובות' : 'קודם התחל חיפוש'); return; }
  var from = lastPos || S.center, r = candidates(from, ringProgress(), reachM());
  if (!r) { $('nav').style.display = 'none'; if (!quiet) { toast('כל הרחובות באזור הזה נבדקו'); say('כל הרחובות באזור נבדקו'); } return; }
  navT = r.o; navT.isPark = !!navT.outline;
  if (navT.isPark) L.polygon(navT.outline, { color: '#ff6f00', weight: 4, fill: false, interactive: false }).addTo(L_guide);
  else L.polyline([navT.a, navT.b], { color: '#ff6f00', weight: 14, opacity: .65, interactive: false }).addTo(L_guide);
  $('nav').style.display = 'block';
  $('navWaze').href = 'https://waze.com/ul?ll=' + navT.mid[0].toFixed(6) + ',' + navT.mid[1].toFixed(6) + '&navigate=yes';
  doRoute(from);
  if (navFirst) { navFirst = false; map.fitBounds(L.latLngBounds([from, navT.mid]).pad(0.5)); setFollow(false); setTimeout(function () { setFollow(true); }, 4000); }
  if (Date.now() - lastSaid > 4000 && !(lastPos && nearTarget(lastPos))) { lastSaid = Date.now(); var dd = route ? route.len : r.d; say('היעד הבא: ' + (navT.isPark ? 'חניון ' + navT.name : navT.name) + (dd > 30 ? ', ' + Math.round(dd / 10) * 10 + ' מטר' : '')); }
  updateNav();
}
function doRoute(from) {
  L_guide.eachLayer(function (l) { if (l._g) L_guide.removeLayer(l); });
  var seg = navT.isPark ? { a: navT.mid, b: navT.outline[0], mid: navT.mid } : navT;
  route = makeRoute(from, seg); lastRoute = Date.now(); offCount = 0; spoken = {};
  var ln = route ? L.polyline(route.pts, { color: '#ff6f00', weight: 6, opacity: .85, interactive: false })
                 : L.polyline([from, navT.mid], { color: '#ff6f00', weight: 3, dashArray: '4 8', interactive: false });
  ln._g = 1; ln.addTo(L_guide);
}
function nearTarget(p) {
  if (navT.isPark) return (p[0] > navT.bb[0] - 0.0003 && p[0] < navT.bb[2] + 0.0003 && p[1] > navT.bb[1] - 0.0003 && p[1] < navT.bb[3] + 0.0003);
  return Math.min(dist(p, navT.a), dist(p, navT.b), dist(p, navT.mid)) < 35;
}
function updateNav() {
  if (!navOn) return;
  if (!navT || navT.visited) return pickNext(true);
  var from = lastPos || S.center;
  if (lastPos && nearTarget(from)) {
    $('navArrow').style.transform = 'none'; $('navArrow').textContent = navT.isPark ? '🅿️' : '⬆';
    $('navLbl').textContent = 'הגעת'; $('navName').textContent = targetName();
    $('navDist').textContent = navT.isPark ? 'סע בין שורות החניון עד שייצבע ירוק' : 'סע לאורך הקטע עד שייצבע ירוק';
    if (!spoken.arr) { spoken.arr = 1;
      var nm = navT.isPark ? 'P' + navT.id : navT.name;
      if (nm !== lastArr.name || Date.now() - lastArr.t > 90000) say(navT.isPark ? 'הגעת לחניון. סע בין השורות' : 'סע לאורך ' + navT.name);
      lastArr = { name: nm, t: Date.now() }; }
    offCount = 0; return;
  }
  if (route) {
    var pr = projOnRoute(route, from);
    if (pr.off > 45) offCount++; else offCount = 0;
    if (offCount >= 2 && Date.now() - lastRoute > 6000) { doRoute(from); if (!route) return updateNav(); pr = projOnRoute(route, from); }
    var next = null; for (var i = 0; i < route.instr.length; i++) if (route.cum[route.instr[i].i] > pr.along + 5) { next = route.instr[i]; break; }
    var toEnd = Math.max(0, route.len - pr.along);
    $('navArrow').style.transform = 'none';
    if (next) {
      var dn = route.cum[next.i] - pr.along, nm = next.name ? ' ל' + next.name : '';
      $('navArrow').textContent = next.icon;
      $('navLbl').textContent = 'בעוד ' + fmtM(dn);
      $('navName').textContent = next.text + nm;
      $('navDist').textContent = 'יעד: ' + targetName() + ' · ' + fmtM(toEnd);
      if (dn < 170 && dn > 60 && !spoken[next.i + 'f']) { spoken[next.i + 'f'] = 1; say('בעוד ' + Math.round(dn / 10) * 10 + ' מטר, ' + next.text + nm); }
      if (dn <= 40 && !spoken[next.i + 'n']) { spoken[next.i + 'n'] = 1; say(next.text + nm); }
    } else {
      $('navArrow').textContent = '⬆';
      $('navLbl').textContent = toEnd < 40 ? 'הגעת' : 'המשך ישר ' + fmtM(toEnd);
      $('navName').textContent = targetName();
      $('navDist').textContent = navT.isPark ? 'סע בין שורות החניון' : 'סע לאורך הרחוב עד שייצבע ירוק';

    }
    L_guide.eachLayer(function (l) { if (l._g) { var p = route.pts.slice(); p[0] = from; l.setLatLngs(p); } });
    return;
  }
  // no street graph here – straight-line guidance
  var d = dist(from, navT.mid), b = bearing(from, navT.mid);
  $('navArrow').textContent = '⬆'; $('navArrow').style.transform = 'rotate(' + ((b - (heading || 0) + 360) % 360) + 'deg)';
  $('navLbl').textContent = 'היעד הבא לבדיקה'; $('navName').textContent = targetName(); $('navDist').textContent = fmtM(d) + ' (קו אווירי)';
  L_guide.eachLayer(function (l) { if (l._g) l.setLatLngs([from, navT.mid]); });
}
function setNav(on) {
  navOn = on; $('bNav').className = on ? 'on' : ''; $('bNav').textContent = on ? '➡️ מנווט' : '➡️ נווט';
  if (on) { navFirst = true; pickNext(); } else { L_guide.clearLayers(); navT = null; route = null; $('nav').style.display = 'none'; }
}
$('bNav').onclick = function () { if (!S.center) return startWizard(); setNav(!navOn); };
$('navSkip').onclick = function () { if (navT) { skipped[navT.id] = 1; pickNext(); } };

// ---------- Waze hand-off ----------
var wazeAt = 0, wazeTarget = null, hiddenAt = 0;
$('navWaze').addEventListener('click', function (e) {
  wazeAt = Date.now(); wazeTarget = navT;
  if (S.opts.wazeTip) return;
  e.preventDefault(); var href = this.href;
  S.opts.wazeTip = true; save();
  sheet('<h2>לפני שעוברים לווייז</h2><p>כשווייז פתוח על המסך, הטלפון <b>עוצר את האפליקציה הזו</b>, והרחובות שתעבור בהם לא יסומנו אוטומטית.</p>' +
    '<p><b>מומלץ:</b> לנווט עם הניווט של האפליקציה (הפס הכתום וההנחיה הקולית) – כך הכול נרשם.</p>' +
    '<p class="hint">באנדרואיד אפשר גם <b>מסך מפוצל</b>: במסך האפליקציות האחרונות, לחיצה על הסמל של Chrome ← "פיצול מסך", ובחצי השני ווייז. כך שתיהן פועלות.</p>' +
    '<p class="hint">כשתחזור מווייז אשאל אם לסמן את הרחוב כנבדק.</p>' +
    '<p><a id="wzGo" href="' + href + '" target="_blank" rel="noopener" style="display:block;text-align:center;background:#33ccff;color:#000;font-weight:700;padding:12px;border-radius:12px;text-decoration:none">פתח בווייז</a></p>',
    [['הישאר בניווט של האפליקציה', closeSheet, 'primary']]);
  setTimeout(function () { var a = $('wzGo'); if (a) a.onclick = function () { wazeAt = Date.now(); wazeTarget = navT; closeSheet(); }; }, 0);
});
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  var away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
  if (away < 20000 || !S.center) return;
  var mins = Math.max(1, Math.round(away / 60000));
  if (wazeTarget && Date.now() - wazeAt < away + 60000 && !wazeTarget.visited) {
    var t = wazeTarget; wazeTarget = null;
    sheet('<h2>חזרת מווייז</h2><p>בזמן שווייז היה פתוח, המסלול לא נרשם (' + mins + ' דק\').</p><p>עברת ב<b>' + esc(t.isPark ? 'חניון ' + t.name : t.name) + '</b>?</p>', [
      ['✅ כן, סמן כנבדק', function () { markTargetDone(t); closeSheet(); }, 'primary'], ['לא', closeSheet]]);
  } else toast('המעקב היה מושהה ' + mins + ' דק\' בזמן שהאפליקציה לא הייתה על המסך', 5000);
});
function markTargetDone(t) {
  if (t.isPark) { S.parkDone[t.id] = Date.now(); refreshPark(t); log('סומן ידנית: חניון ' + t.name); }
  else { segs.forEach(function (s) { if (s.way === t.way && dist(s.mid, t.mid) < 200) { S.manual[s.id] = 1; refreshSeg(s); } }); log('סומן ידנית (אחרי ווייז): ' + t.name); }
  save(); stats(); updateNav();
}

// ================= sheets / toast =================
function sheet(html, btns, cls) {
  var b = $('sheetBody'); b.innerHTML = html;
  if (btns && btns.length) { var w = document.createElement('div'); w.className = cls || 'btns';
    btns.forEach(function (x) { var e = document.createElement('button'); e.textContent = x[0]; if (x[2]) e.className = x[2]; e.onclick = x[1]; w.appendChild(e); }); b.appendChild(w); }
  $('sheet').style.display = 'flex'; b.scrollTop = 0;
}
function closeSheet() { $('sheet').style.display = 'none'; }
$('sheet').addEventListener('click', function (e) { if (e.target.id === 'sheet') closeSheet(); });
var toastT = null;
function toast(t, ms) { var e = $('toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(function () { e.style.display = 'none'; }, ms || 2500); }
function setFollow(v) { follow = v; $('bFollow').className = v ? 'on' : ''; if (v && lastPos) map.panTo(lastPos); }
$('bFollow').onclick = function () { setFollow(!follow); };
function showMode() { $('bMode').textContent = S.opts.mode === 'foot' ? '🚶' : '🚗'; }
$('bMode').onclick = function () {
  S.opts.mode = S.opts.mode === 'foot' ? 'car' : 'foot'; save(); showMode();
  toast(S.opts.mode === 'foot' ? 'מצב רגלי: כולל שבילים ומעברים להולכי רגל' : 'מצב רכב: כבישים, דרכי שירות, חניונים ודרכי עפר', 3500);
  segs.forEach(function (s) { s.poly.setStyle(styleSeg(s)); }); buildGraph(); lastActiveKey = ''; stats(); if (navOn) pickNext(true);
};
showMode();
map.on('dragstart', function () { setFollow(false); });
$('bOverview').onclick = function () { setFollow(false); if (S.center) map.fitBounds(L.latLng(S.center).toBounds(Math.max(RINGS[RINGS.length - 1], Math.min(reachM(), 8000)) * 2)); else if (lastPos) map.setView(lastPos, 15); };

// ================= picking on map =================
function pickOnMap(text, cb) { closeSheet(); pick = cb; setFollow(false); toast(text, 6000); }
map.on('click', function (e) { if (pick) { var cb = pick; pick = null; $('toast').style.display = 'none'; cb([e.latlng.lat, e.latlng.lng]); } });

// ================= self check =================
function selfCheck(then) {
  var rows = [['https', 'הדף נפתח כאתר מאובטח'], ['gps', 'מיקום (GPS)'], ['tiles', 'מפה'], ['streets', 'רשימת רחובות'], ['voice', 'הנחיה קולית']];
  sheet('<h2>בדיקת מערכת</h2><p class="hint">בודק שהכול עובד לפני שיוצאים לחפש.</p>' + rows.map(function (r) { return '<div class="chk"><span>' + r[1] + '</span><span class="st wait" id="ck_' + r[0] + '">בודק…</span></div>'; }).join('') + '<div id="ckNote" class="hint" style="margin-top:8px"></div>',
    [['המשך', function () { closeSheet(); if (then) then(); }, 'primary']]);
  var notes = [];
  function set(id, ok, txt, note) { var e = $('ck_' + id); if (!e) return; e.className = 'st ' + (ok ? 'ok' : 'bad'); e.textContent = (ok ? '✓ ' : '✗ ') + (txt || ''); if (note) { notes.push(note); $('ckNote').innerHTML = notes.join('<br>'); } }
  var sec = window.isSecureContext && /^https?:$/.test(location.protocol);
  set('https', sec, sec ? '' : 'לא', sec ? null : '⚠️ הדף נפתח כקובץ ולא כאתר – הטלפון לא ייתן מיקום. יש לפתוח אותו דרך הקישור (https).');
  if (!('geolocation' in navigator) || !sec) set('gps', false, 'לא זמין');
  else {
    var gpsOk = function (p) { var a = p.coords.accuracy;
      if (a <= 100) set('gps', true, 'דיוק ' + Math.round(a) + ' מ\'');
      else set('gps', true, 'מתקבל, לא מדויק (' + fmtM(a) + ')', 'ℹ️ המיקום מתקבל אבל לא מדויק. במחשב זה רגיל (אין בו GPS). בטלפון, בחוץ, עם GPS דלוק – הדיוק יהיה של כמה מטרים.');
      startGps(); onPos(p); };
    var gpsBad = function (e) { set('gps', false, e.code === 1 ? 'אין הרשאה' : 'לא התקבל', e.code === 1 ? '⚠️ צריך לאשר מיקום: סמל המנעול ליד הכתובת ← הרשאות ← מיקום.' : 'נסה לצאת לשטח פתוח ולוודא שה-GPS בטלפון דלוק.'); startGps(); };
    navigator.geolocation.getCurrentPosition(gpsOk, function (e) {
      if (e.code === 1) return gpsBad(e);
      navigator.geolocation.getCurrentPosition(gpsOk, gpsBad, { enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 });
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  }
  var img = new Image(), done = false;
  img.onload = function () { done = true; set('tiles', true, 'תקין'); };
  img.onerror = function () { done = true; set('tiles', false, 'חסום', '⚠️ המפה לא נטענת – ייתכן שהאתר tile.openstreetmap.org חסום בסינון.'); };
  img.src = TILE_URL.replace('{z}', '10').replace('{x}', '611').replace('{y}', '424') + '?t=' + Date.now();
  setTimeout(function () { if (!done) set('tiles', false, 'איטי'); }, 10000);
  fetch('data/meta.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (m) { set('streets', true, 'מאגר מקומי (' + m.built + ')'); })
    .catch(function () {
      overpass('[out:json][timeout:10];node(1);out;', 10000).then(function () { set('streets', true, 'משרת חיצוני'); })
        .catch(function () { set('streets', false, 'לא זמין', '⚠️ רשימת הרחובות לא זמינה כרגע – אפשר לחפש, אבל בלי צביעת רחובות וניווט.'); });
    });
  var v = 'speechSynthesis' in window; set('voice', v, v ? 'זמין' : 'לא נתמך');
}

// ================= wizard =================
var W = {};
function startWizard() {
  W = { center: lastPos || null, seenAt: Date.now(), speed: 3.5, dir: null, keep: false };
  wizWhere();
}
function wizWhere() {
  sheet('<h2>1. איפה ראו אותו לאחרונה?</h2><p class="hint">לדוגמה: היציאה מהקניון שממנה יצא, או המקום האחרון שבו נראה.</p>', [
    ['📍 המיקום שלי עכשיו', function () { if (!lastPos) return toast('עוד אין מיקום GPS – אפשר לבחור על המפה'); if (lastAcc > 200) return toast('המיקום לא מדויק כרגע (' + fmtM(lastAcc) + ') – עדיף לבחור על המפה', 5000); W.center = lastPos; wizWhen(); }, 'primary'],
    ['👆 אבחר על המפה', function () { pickOnMap('לחץ על המפה במקום שבו נראה לאחרונה', function (ll) { W.center = ll; wizWhen(); }); }],
    ['ביטול', closeSheet]], 'col');
}
function wizWhen() {
  var now = new Date(), v = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
  sheet('<h2>2. מתי ראו אותו שם?</h2><p class="hint">לפי זה המפה מחשבת כמה רחוק הוא יכול היה ללכת מאז, והמעגל הסגול יגדל עם הזמן.</p>' +
    '<div class="seg" id="qmin"><button data-m="0">עכשיו</button><button data-m="15">לפני 15 דק\'</button><button data-m="30">לפני חצי שעה</button><button data-m="60">לפני שעה</button></div>' +
    '<label>או שעה מדויקת</label><input type="time" id="wTime" value="' + v + '">' +
    '<h3>קצב ההליכה שלו</h3><div class="seg" id="qspd"><button data-s="2.5">איטי (מבוגר)</button><button data-s="3.5" class="sel">רגיל</button><button data-s="5">מהיר</button></div>',
    [['המשך', function () {
      var t = $('wTime').value.split(':'), d = new Date(); d.setHours(+t[0], +t[1], 0, 0); if (d.getTime() > Date.now() + 60000) d.setDate(d.getDate() - 1);
      W.seenAt = d.getTime(); wizDir(); }, 'primary'], ['חזור', wizWhere]]);
  [].forEach.call($('qmin').children, function (b) { b.onclick = function () { var d = new Date(Date.now() - b.dataset.m * 60000); $('wTime').value = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); [].forEach.call($('qmin').children, function (x) { x.className = x === b ? 'sel' : ''; }); }; });
  [].forEach.call($('qspd').children, function (b) { b.onclick = function () { W.speed = +b.dataset.s; [].forEach.call($('qspd').children, function (x) { x.className = x === b ? 'sel' : ''; }); }; });
}
function wizDir() {
  sheet('<h2>3. ידוע לאיזה כיוון הלך?</h2><p class="hint">למשל לפי מצלמות האבטחה. אם כן – החיפוש יתמקד ברצועה בכיוון הזה.</p>', [
    ['👆 כן, אסמן כיוון על המפה', function () {
      map.setView(W.center, 16);
      pickOnMap('לחץ על נקודה בכיוון שאליו הלך', function (ll) { W.dir = bearing(W.center, ll); wizGo(); }); }, 'primary'],
    ['לא ידוע – חפש בכל הכיוונים', function () { W.dir = null; wizGo(); }], ['חזור', wizWhen]], 'col');
}
function wizGo() {
  var keep = S.center && (S.track.length || Object.keys(S.manual).length);
  function go(keepCov) {
    if (!keepCov) { var opts = S.opts, person = S.person; S = blank(); S.opts = opts; S.person = person; trackLine.setLatLngs([]); coverBand.setLatLngs([]); L_marks.clearLayers(); }
    S.center = W.center; S.seenAt = W.seenAt; S.speed = W.speed; S.dir = W.dir; S.startedAt = S.startedAt || Date.now();
    log('חיפוש התחיל. נראה לאחרונה בשעה ' + hhmm(S.seenAt) + (S.dir != null ? ', כיוון ' + Math.round(S.dir) + '°' : ''));
    save(); closeSheet(); rebuildCoverage(); drawAll(); loadStreets(); map.setView(S.center, 16);
    setTimeout(function () { setNav(true); }, 800);
  }
  if (keep) sheet('<h2>לשמור את מה שכבר נבדק?</h2><p>יש מסלול קודם בטלפון.</p>', [['שמור (אותו חיפוש)', function () { go(true); }, 'primary'], ['התחל נקי', function () { go(false); }]]);
  else go(false);
}

// ================= buttons =================
$('bMark').onclick = function () {
  if (!lastPos) return toast('אין עדיין מיקום');
  if (!S.center) return startWizard();
  var m = [lastPos[0], lastPos[1], Date.now()]; S.marks.push(m); coverPoint(m[0], m[1]); refreshNear(m[0], m[1]); addMark(m);
  log('נבדק במקום (סימון ידני)'); save(); stats(); updateNav(); toast('סומן ✅');
};
function addMark(m) { L.marker([m[0], m[1]], { icon: L.divIcon({ html: '<div style="font-size:20px">✅</div>', className: '', iconSize: [22, 22], iconAnchor: [11, 11] }) }).bindPopup('נבדק בשעה ' + hhmm(m[2])).addTo(L_marks); }

$('bSeen').onclick = function () {
  if (!S.center) return startWizard();
  sheet('<h2>דיווח: נראה כאן</h2><p class="hint">מישהו ראה אותו? סמן איפה ומתי. אפשר להזיז את מרכז החיפוש לשם.</p><label>לפני כמה דקות?</label><input type="number" id="seenMin" value="0" min="0">', [
    ['📍 במיקום שלי', function () { if (!lastPos) return toast('אין מיקום'); addSighting(lastPos); }, 'primary'],
    ['👆 אבחר על המפה', function () { var m = +$('seenMin').value || 0; pickOnMap('לחץ איפה ראו אותו', function (ll) { addSighting(ll, m); }); }],
    ['ביטול', closeSheet]], 'col');
};
function addSighting(ll, minAgo) {
  if (minAgo == null) minAgo = +(($('seenMin') || {}).value || 0);
  var t = Date.now() - minAgo * 60000; S.sightings.push([ll[0], ll[1], t]); log('דווח שנראה (שעה ' + hhmm(t) + ')'); save(); drawRings();
  sheet('<h2>להזיז את מרכז החיפוש לכאן?</h2><p>המעגלים והטווח יתחילו מהנקודה הזו והשעה ' + hhmm(t) + '. מה שכבר נבדק יישמר.</p>', [
    ['כן, הזז', function () { S.center = ll; S.seenAt = t; save(); closeSheet(); drawAll(); loadStreets(true); log('מרכז החיפוש הוזז לנקודת הדיווח'); if (navOn) { navFirst = true; } }, 'primary'],
    ['לא, רק סמן', closeSheet]]);
}

// ---------- menu ----------
$('bMenu').onclick = function () {
  sheet('<h2>תפריט</h2>', [
    ['🆕 חיפוש חדש / עדכון נקודת התחלה', function () { startWizard(); }],
    ['🧭 שנה כיוון', function () { if (!S.center) return startWizard(); sheet('<h2>כיוון</h2>', [['👆 אסמן על המפה', function () { pickOnMap('לחץ בכיוון ההליכה', function (ll) { S.dir = bearing(S.center, ll); save(); drawDir(); lastActiveKey = ''; stats(); if (navOn) pickNext(); }); }, 'primary'], ['בטל כיוון', function () { S.dir = null; save(); drawDir(); lastActiveKey = ''; stats(); closeSheet(); }]], 'col'); }],
    ['🪪 כרטיס נעדר (תמונה ותיאור לשיתוף)', personCard],
    ['📋 דוח ויומן חיפוש', report],
    ['⚙️ הגדרות ושכבות', settings],
    ['✔️ בדיקת מערכת', function () { selfCheck(); }],
    ['❓ איך משתמשים', help],
    ['סגור', closeSheet]], 'col');
};
function help() {
  sheet('<h2>איך משתמשים</h2><ol style="padding-right:18px;margin:0">' +
    '<li><b>חיפוש חדש:</b> איפה ומתי ראו אותו, ואם ידוע – לאיזה כיוון הלך.</li>' +
    '<li><b>➡️ נווט:</b> הפס הכתום מראה את הרחוב הבא שלא נבדק, עם חץ, מרחק וכפתור Waze. כשעוברים בו – הוא נצבע ירוק והיעד הבא נבחר לבד.</li>' +
    '<li><b>צבעים:</b> אדום = עוד לא נבדק, ירוק = נבדק, כחול = המסלול שלך, פס ירוק שקוף = השטח שנסרק.</li>' +
    '<li><b>מעגלים:</b> מסיימים קודם את הקרוב (300 מ\'), ואז מתרחבים. המעגל הכתום הוא המעגל הנוכחי. העיגול הסגול המנוקד = כמה רחוק יכול היה ללכת מאז שנראה, והוא גדל עם הזמן.</li>' +
    '<li><b>מקומות לבדיקה</b> (בזום קרוב): תחנות, מלונות, פארקים, בתי כנסת ועוד. לחיצה ← "בדקתי כאן".</li>' +
    '<li><b>✅ בדקתי כאן:</b> כשיורדים לבדוק ברגל. <b>👁️ נראה כאן:</b> כשמישהו ראה אותו.</li>' +
    '<li>לחיצה על רחוב מאפשרת לסמן אותו כנבדק (למשל אם מישהו עבר בו ברגל).</li>' +
    '<li><b>🚗 / 🚶</b> למעלה: מצב רכב (כבישים, דרכי שירות, חניונים, דרכי עפר) או מצב רגלי (גם שבילים ומעברים). חניונים מסומנים בכתום ונצבעים ירוק כשעוברים בהם.</li>' +
    '<li><b>ניווט:</b> הפס הכתום אומר מתי ולאן לפנות, עם הנחיה קולית, ומחשב מחדש אם יוצאים מהמסלול.</li>' +
    '<li><b>ווייז:</b> כשווייז פתוח, האפליקציה מושהית ולא רושמת. עדיף לנווט עם האפליקציה עצמה.</li></ol>' +
    '<p class="hint">שמישהו אחר יפעיל את הטלפון בזמן הנהיגה. הכול נשמר בטלפון גם אם הדף נסגר.</p>', [['סגור', closeSheet]]);
}
function settings() {
  sheet('<h2>הגדרות</h2>' +
    '<div class="toggle"><span>הנחיה קולית</span><input type="checkbox" id="oV"' + (S.opts.voice ? ' checked' : '') + '></div>' +
    '<div class="toggle"><span>מקומות לבדיקה על המפה</span><input type="checkbox" id="oP"' + (S.opts.pois ? ' checked' : '') + '></div>' +
    '<div class="toggle"><span>כלול דרכי שירות, חניונים ודרכי עפר</span><input type="checkbox" id="oS"' + (S.opts.service ? ' checked' : '') + '></div>' +
    '<h3>מחיקה</h3><p class="hint">מוחק את המסלול, הסימונים והדוח מהטלפון הזה.</p>',
    [['שמור', function () {
      var sv = S.opts.service; S.opts.voice = $('oV').checked; S.opts.pois = $('oP').checked; S.opts.service = $('oS').checked; save(); updatePoiVisibility(); closeSheet();
      if (sv !== S.opts.service) { buildSegs(); } }, 'primary'],
     ['🗑️ מחק הכל', function () { sheet('<h2>למחוק הכל?</h2><p>המסלול, הסימונים, היומן וכרטיס הנעדר יימחקו מהטלפון.</p>', [['כן, מחק', function () { try { localStorage.removeItem(KEY); localStorage.removeItem(KEY_STREETS); } catch (e) {} location.reload(); }, 'warn'], ['ביטול', closeSheet]]); }, 'warn']]);
}

// ---------- person card ----------
function personCard() {
  var p = S.person;
  sheet('<h2>כרטיס נעדר</h2><p class="hint">נשמר רק בטלפון הזה. משמש לשיתוף מהיר בוואטסאפ.</p>' +
    '<label>שם</label><input id="pN" value="' + esc(p.name) + '">' +
    '<label>תיאור: גיל, מראה, בגדים, מה חשוב לדעת</label><textarea id="pD" rows="4">' + esc(p.desc) + '</textarea>' +
    '<label>טלפון ליצירת קשר</label><input id="pP" type="tel" value="' + esc(p.phone) + '">' +
    '<label>תמונה</label>' + (p.photo ? '<img class="photo" src="' + p.photo + '">' : '') + '<input type="file" id="pF" accept="image/*">',
    [['שמור', function () { savePerson(closeSheet); }, 'primary'], ['📤 שתף', function () { savePerson(sharePerson); }], ['סגור', closeSheet]]);
}
function savePerson(then) {
  S.person.name = $('pN').value.trim(); S.person.desc = $('pD').value.trim(); S.person.phone = $('pP').value.trim();
  var f = $('pF').files && $('pF').files[0];
  if (!f) { save(); return then && then(); }
  var img = new Image(), url = URL.createObjectURL(f);
  img.onload = function () { var k = Math.min(1, 640 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); S.person.photo = c.toDataURL('image/jpeg', .75); URL.revokeObjectURL(url); save(); then && then(); };
  img.onerror = function () { toast('לא הצלחתי לקרוא את התמונה'); save(); then && then(); };
  img.src = url;
}
function personText() {
  var p = S.person, t = '🔴 נעדר/ת' + (p.name ? ': ' + p.name : '') + '\n';
  if (p.desc) t += p.desc + '\n';
  if (S.seenAt) t += 'נראה/תה לאחרונה בשעה ' + hhmm(S.seenAt) + (S.center ? ' – https://maps.google.com/?q=' + S.center[0].toFixed(5) + ',' + S.center[1].toFixed(5) : '') + '\n';
  if (p.phone) t += 'מי שראה – נא להתקשר: ' + p.phone + '\n';
  return t + 'במקרה חירום – משטרה 100';
}
function sharePerson() {
  var t = personText(), p = S.person;
  function fallback() {
    sheet('<h2>שיתוף</h2><textarea rows="7" id="shT">' + esc(t) + '</textarea>' + (p.photo ? '<p class="hint">את התמונה אפשר לשלוח בנפרד – לחיצה ארוכה עליה ← שמירה.</p><img class="photo" src="' + p.photo + '">' : ''),
      [['💬 וואטסאפ', function () { window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank'); }, 'primary'],
       ['📋 העתק', function () { try { navigator.clipboard.writeText(t).then(function () { toast('הועתק'); }); } catch (e) { $('shT').select(); } }], ['סגור', closeSheet]]);
  }
  if (!navigator.share) return fallback();
  var data = { text: t };
  try { if (p.photo) { var bin = atob(p.photo.split(',')[1]), arr = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var file = new File([arr], 'nehedar.jpg', { type: 'image/jpeg' }); if (navigator.canShare && navigator.canShare({ files: [file] })) data.files = [file]; } } catch (e) {}
  navigator.share(data).then(closeSheet).catch(function (e) { if (e && e.name !== 'AbortError') fallback(); });
}

// ---------- report ----------
function reportText() {
  var pr = segs.length ? ringProgress() : null, tot = 0;
  for (var i = 1; i < S.track.length; i++) { var d = dist(S.track[i - 1], S.track[i]); if (d < 400) tot += d; }
  var t = 'דוח חיפוש' + (S.person.name ? ' – ' + S.person.name : '') + '\n';
  if (S.seenAt) t += 'נראה לאחרונה: ' + hhmm(S.seenAt) + (S.center ? ' (' + S.center[0].toFixed(5) + ', ' + S.center[1].toFixed(5) + ')' : '') + '\n';
  t += 'מרחק שנסרק ברכב: ' + fmtM(tot) + '\n';
  if (pr) t += RINGS.map(function (r, i) { return 'עד ' + fmtM(r) + ': ' + Math.round(100 * pr.frac[i]) + '% מהרחובות'; }).join('\n') + '\n';
  t += 'מקומות שנבדקו: ' + Object.keys(S.poiDone).length + ', סימוני "בדקתי כאן": ' + S.marks.length + ', דיווחי "נראה": ' + S.sightings.length + '\n\nיומן:\n';
  t += S.log.map(function (l) { return hhmm(l[0]) + ' – ' + l[1]; }).join('\n');
  return t;
}
function report() {
  var t = reportText();
  sheet('<h2>דוח ויומן</h2><div class="log">' + S.log.slice().reverse().map(function (l) { return '<div><b>' + hhmm(l[0]) + '</b> ' + esc(l[1]) + '</div>'; }).join('') + '</div>' +
    '<h3>הוספת הערה ליומן</h3><input id="logIn" placeholder="למשל: שאלנו בלובי המלון – לא ראו">',
    [['➕ הוסף', function () { var v = $('logIn').value.trim(); if (v) { log(v); report(); } }],
     ['📤 שתף דוח', function () { if (navigator.share) navigator.share({ text: reportText() }).catch(function () {}); else { try { navigator.clipboard.writeText(t); toast('הדוח הועתק'); } catch (e) {} } }, 'primary'],
     ['סגור', closeSheet]]);
}

// ================= draw all / restore =================
function drawAll() { drawRings(); drawDir(); reachCircle = null; drawReach(); stats(); }
trackLine.setLatLngs(S.track.map(function (p) { return [p[0], p[1]]; }));
coverBand.setLatLngs(trackLine.getLatLngs()); coverBand.setStyle({ weight: bandWeight() });
S.marks.forEach(addMark);
if (S.center) { drawAll(); loadStreets(); }
stats();

// service worker (offline)
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () {});

// first run: self check, then wizard
if (!S.center) selfCheck(function () { startWizard(); });
else { startGps(); toast('ממשיכים את החיפוש הקודם'); }

function pointAt(rt, d) { for (var i = 1; i < rt.pts.length; i++) if (rt.cum[i] >= d) { var t = (d - rt.cum[i - 1]) / ((rt.cum[i] - rt.cum[i - 1]) || 1); return [rt.pts[i - 1][0] + (rt.pts[i][0] - rt.pts[i - 1][0]) * t, rt.pts[i - 1][1] + (rt.pts[i][1] - rt.pts[i - 1][1]) * t]; } return rt.pts[rt.pts.length - 1]; }
window.__app = { T: function (a, b) { var s0 = segs.filter(function (s) { return dist(s.mid, b) < 40; })[0]; var r = makeRoute(a, s0); return r ? { len: Math.round(r.len), instr: r.instr.map(function (x) { return x.text + (x.name ? " ל" + x.name : "") + " @" + Math.round(r.cum[x.i]); }) } : null; }, R: function () { return route ? { pts: route.pts.map(function (p) { return [+p[0].toFixed(5), +p[1].toFixed(5)]; }), cum: route.cum.map(Math.round), pr: lastPos ? projOnRoute(route, lastPos) : null } : null; }, S: function () { return S; }, segs: function () { return segs; }, pois: function () { return pois; }, parks: function () { return parks.map(function (k) { return [k.name, k.visited]; }); },
  // test helper: a point m metres further along the current route (or along the target street once there)
  step: function (m) { if (!navT) return null; var from = lastPos || S.center;
    if (route && !nearTarget(from)) { var pr = projOnRoute(route, from); return pointAt(route, Math.min(route.len, pr.along + m)); }
    var end = navT.b; if (navT.isPark) { var far = 0; navT.outline.forEach(function (q) { var dq = dist(from, q); if (dq > far) { far = dq; end = q; } }); }
    var d = dist(from, end); if (d < m) return end; var t = m / d; return [from[0] + (end[0] - from[0]) * t, from[1] + (end[1] - from[1]) * t]; } };
})();
