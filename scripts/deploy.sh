#!/usr/bin/env bash
# Publish web/ to the gh-pages branch as a single orphan commit (force-pushed), so ~300 MB of
# tiles never accumulate in history. GitHub Pages serves that branch.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f web/precache.json ] || { echo "web/precache.json missing: run scripts/build.sh first"; exit 1; }
REMOTE=$(git remote get-url origin)
VERSION=$(python3 -c "import json;print(json.load(open('web/precache.json'))['version'])")
# every file must be under GitHub's 100 MB limit
big=$(find web -type f -size +95M)
[ -z "$big" ] || { echo "files too large for GitHub: $big"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
rsync -a --exclude 'js/sw-template.js' --exclude '.DS_Store' web/ "$TMP/"
touch "$TMP/.nojekyll"
(
  cd "$TMP"
  git init -q -b gh-pages
  git add -A
  git -c commit.gpgsign=false commit -q -m "Deploy data version $VERSION"
  for i in 1 2 3 4; do
    git push -f "$REMOTE" gh-pages && break
    echo "push failed, retrying in $((i * 5))s"; sleep $((i * 5))
  done
)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
if ! gh api "repos/$REPO/pages" >/dev/null 2>&1; then
  gh api -X POST "repos/$REPO/pages" -f "source[branch]=gh-pages" -f "source[path]=/" >/dev/null
  echo "GitHub Pages enabled on gh-pages."
fi
URL=$(gh api "repos/$REPO/pages" -q .html_url)
echo "Deployed $VERSION -> $URL  (Pages takes a minute or two to publish)"
