#!/usr/bin/env bash
# Stage web/ into build/site, which the `window-seat` nginx container in the Web stack serves
# at https://window.magehome.duckdns.org (no size limit, unlike GitHub Pages).
# --delete-after keeps old files until the new set is in place.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f web/precache.json ] || { echo "run scripts/build.sh first"; exit 1; }
mkdir -p build/site
rsync -a --delete-after --exclude 'js/sw-template.js' --exclude '.DS_Store' web/ build/site/
echo "Staged $(python3 -c "import json;m=json.load(open('build/site/precache.json'));print(m['version'], round(sum(e['size'] for e in m['entries'])/1e9,2), 'GB')")"
