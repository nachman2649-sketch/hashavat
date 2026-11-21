"""Split filtered OSM GeoJSON-seq into small JSON tiles the app loads directly.
Tile = 0.02 x 0.02 degrees. Format per tile:
  {"w": [[id, name, svc, [[lat,lon],...]], ...], "p": [[id, kind, name, lat, lon], ...]}
"""
import json, sys, os, math, datetime
from collections import defaultdict

T = 0.02
src, out = sys.argv[1], sys.argv[2]
HW = {'primary','secondary','tertiary','unclassified','residential','living_street','pedestrian','trunk',
      'primary_link','secondary_link','tertiary_link','road','service'}

def key(lat, lon): return f"{math.floor(lat / T)}_{math.floor(lon / T)}"

def kind(t):
    a, h = t.get('amenity'), t.get('highway')
    if h == 'bus_stop' or a == 'bus_station': return 'bus'
    m = {'bench':'bench','fuel':'fuel','pharmacy':'pharm','shelter':'shelter','police':'police',
         'hospital':'hosp','clinic':'hosp','toilets':'wc'}
    if a in m: return m[a]
    if a == 'place_of_worship': return 'syn' if t.get('religion') == 'jewish' else None
    if t.get('tourism'): return 'hotel'
    if t.get('leisure'): return 'park'
    if t.get('shop') == 'mall': return 'mall'
    if t.get('shop'): return 'shop'
    return None

def first_ring(g):
    c = g['coordinates']
    if g['type'] == 'Point': return [c]
    if g['type'] == 'LineString': return c
    if g['type'] == 'Polygon': return c[0]
    if g['type'] == 'MultiPolygon': return c[0][0]
    if g['type'] == 'MultiLineString': return c[0]
    return []

tiles = defaultdict(lambda: {'w': [], 'p': []})
nw = np = 0
with open(src, encoding='utf-8') as f:
    for line in f:
        line = line.strip().lstrip('\x1e')
        if not line: continue
        ft = json.loads(line)
        t, g, fid = ft.get('properties') or {}, ft.get('geometry'), ft.get('id', '')
        if not g: continue
        name = t.get('name:he') or t.get('name') or ''
        if t.get('highway') in HW and g['type'] in ('LineString', 'MultiLineString'):
            lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
            for li, ln in enumerate(lines):
                pts = [[round(c[1], 6), round(c[0], 6)] for c in ln]
                if len(pts) < 2: continue
                wid = f"{fid}" if li == 0 else f"{fid}.{li}"
                rec = [wid, name, 1 if t.get('highway') == 'service' else 0, pts]
                for k in {key(p[0], p[1]) for p in pts}: tiles[k]['w'].append(rec)
                nw += 1
            continue
        k = kind(t)
        if not k: continue
        ring = first_ring(g)
        if not ring: continue
        lat = sum(c[1] for c in ring) / len(ring); lon = sum(c[0] for c in ring) / len(ring)
        tiles[key(lat, lon)]['p'].append([fid, k, name, round(lat, 6), round(lon, 6)])
        np += 1

os.makedirs(os.path.join(out, 't'), exist_ok=True)
for k, v in tiles.items():
    with open(os.path.join(out, 't', k + '.json'), 'w', encoding='utf-8') as f:
        json.dump(v, f, ensure_ascii=False, separators=(',', ':'))
with open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8') as f:
    json.dump({'built': datetime.date.today().isoformat(), 'tile': T, 'tiles': len(tiles), 'ways': nw, 'pois': np}, f)
print(f"tiles={len(tiles)} ways={nw} pois={np}")
