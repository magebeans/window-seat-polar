#!/usr/bin/env bash
# Full data + site build. Run from anywhere; re-runnable. Steps can be run individually:
#   scripts/build.sh            setup + route + basemap + pois + assets
#   scripts/build.sh route      just one step (setup|route|plan|basemap|pois|assets)
# Extra args after the step go to that script, e.g.  scripts/build.sh basemap --override 4=11
set -euo pipefail
cd "$(dirname "$0")/.."
PY=".venv/bin/python -I -u"

setup() {
  command -v uv >/dev/null || { echo "need uv (brew install uv)"; exit 1; }
  [ -d .venv ] || uv venv -q .venv
  uv pip install -q --python .venv/bin/python pmtiles
  [ -d node_modules ] || npm install --silent
  if ! command -v pmtiles >/dev/null && [ ! -x .cache/bin/go-pmtiles ]; then
    command -v go >/dev/null || { echo "need the pmtiles CLI: brew install pmtiles, or install Go"; exit 1; }
    GOBIN="$PWD/.cache/bin" go install github.com/protomaps/go-pmtiles@latest
  fi
  [ -d .cache/basemaps-assets ] || git clone -q --depth 1 https://github.com/protomaps/basemaps-assets .cache/basemaps-assets
  mkdir -p .cache/ne
  [ -f .cache/ne/countries50.geojson ] || curl -sfL -o .cache/ne/countries50.geojson \
    https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
}

step="${1:-all}"; shift || true
case "$step" in
  setup)   setup ;;
  route)   $PY pipeline/route.py "$@" ;;
  plan)    $PY pipeline/basemap.py --plan "$@" ;;
  basemap) $PY pipeline/basemap.py "$@" ;;
  pois)    $PY pipeline/pois.py "$@" ;;
  assets)  $PY pipeline/assets.py "$@" ;;
  all)     setup; $PY pipeline/route.py; $PY pipeline/basemap.py; $PY pipeline/pois.py; $PY pipeline/assets.py ;;
  *) echo "unknown step $step"; exit 1 ;;
esac
