"""Doppelpult nach Änderungen an doppelpult/index.html (oder livefassung/index.html) fertig machen:
   live.html aus der Live-Fassung erzeugen (Schriften aus dem Paket), Build-Kennung, Offline-Liste (sw.js), version.txt."""
import hashlib, json, os, re, sys
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); D = R + '/doppelpult'
# 1. live.html: Live-Fassung mit eigenen Schriften statt Google Fonts
live = open(R + '/livefassung/index.html', encoding='utf-8').read()
old = open(D + '/live.html', encoding='utf-8').read()
faces = re.search(r'<style>@font-face.*?</style>', old).group(0)       # Schriftblock aus dem bisherigen Paket übernehmen
live = re.sub(r'<link rel="preconnect" href="https://fonts\.googleapis\.com"><link rel="preconnect" href="https://fonts\.gstatic\.com" crossorigin>\n?', '', live, count=1)
live, n = re.subn(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com/css2\?family=Literata[^"]*">', lambda m: faces, live, count=1)
assert n == 1, 'Schrift-Link der Live-Fassung nicht gefunden'
open(D + '/live.html', 'w', encoding='utf-8').write(live)
# 2. Build-Kennung
page = open(D + '/index.html', encoding='utf-8').read()
ver = re.search(r'const VERSION = (\d+);', page).group(1)
neutral = re.sub(r"const BUILD = '[0-9a-f]{8}'", "const BUILD = ''", page)
build = hashlib.sha256((neutral + live).encode('utf-8')).hexdigest()[:8]
page = re.sub(r"const BUILD = '[0-9a-f]{8}'", "const BUILD = '" + build + "'", page, count=1)
open(D + '/index.html', 'w', encoding='utf-8').write(page)
# 3. Offline-Liste
sw = open(D + '/sw.js', encoding='utf-8').read()
files = ['./']
for base, dirs, names in os.walk(D):
    dirs[:] = [d for d in dirs if d not in ('netlify', '.git')]
    for nm in sorted(names):
        rel = os.path.relpath(os.path.join(base, nm), D).replace(os.sep, '/')
        if not rel.lower().endswith('.txt') and 'LICENSE' not in rel and rel not in ('sw.js', 'netlify.toml'):
            files.append(rel)
files = ['./'] + sorted(f for f in files if f != './')
sw = re.sub(r'Stand [0-9a-f]{8}', 'Stand ' + build, sw, count=1)
sw = re.sub(r"const CACHE = 'doppelpult-[0-9a-f]{8}';", "const CACHE = 'doppelpult-" + build + "';", sw, count=1)
sw = re.sub(r'const FILES = \[.*?\];', 'const FILES = ' + json.dumps(files, indent=1) + ';', sw, count=1, flags=re.S)
open(D + '/sw.js', 'w', encoding='utf-8').write(sw)
open(D + '/version.txt', 'w').write(ver + '\n')
print('Doppelpult', ver, 'Build', build, len(files), 'Dateien im Vorrat')
