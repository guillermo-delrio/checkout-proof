#!/usr/bin/env bash
# Builds the read-only fallback copy of the evidence site into out/static-site/, for GitHub Pages (README "Fallback
# site"). Same pages and data as the hosted site; the live buttons and the scan box are replaced by "live demo at
# <URL>", and the saved live runs come from a snapshot of the live site's public GETs taken now.
#   bash scripts/build-static.sh [--base /checkout-proof/] [--live https://…run.app] [--out out/static-site]
# If the live site does not answer, the last snapshot (out/static-snapshot/) is used. Nothing is published here.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=/checkout-proof/ LIVE=https://checkout-proof-149219545146.us-central1.run.app OUT=out/static-site
while [ $# -gt 0 ]; do
  case "$1" in --base) BASE=$2; shift 2;; --live) LIVE=$2; shift 2;; --out) OUT=$2; shift 2;; *) echo "unknown: $1" >&2; exit 2;; esac
done
case "$BASE" in /*/) ;; /) ;; *) echo "--base must start and end with /" >&2; exit 2;; esac
SNAP=out/static-snapshot
OUT_ABS=$(mkdir -p "$OUT" && cd "$OUT" && pwd)

# 1. Saved live runs: history plus every finished run, from the live site (public, read-only GETs; no re-run).
python3 - "$LIVE" "$SNAP" <<'PY'
import json, os, sys, time, urllib.request
live, snap = sys.argv[1].rstrip("/"), sys.argv[2]
def get(path):
    req = urllib.request.Request(live + path, headers={"User-Agent": "checkout-proof static build"})
    with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)
try:
    hist = get("/api/rerun/history")
    runs = {}
    for r in hist.get("runs", []):
        if r.get("state") in ("done", "interrupted"):
            runs[r["id"]] = get("/api/rerun/" + r["id"]); time.sleep(2.5)  # the GETs allow 30/min per visitor
    hist["snapshotAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
except Exception as e:
    if not os.path.exists(os.path.join(snap, "history.json")): sys.exit(f"live site unreachable ({e}) and no snapshot in {snap}")
    print(f"live site unreachable ({e}); using the snapshot in {snap}"); sys.exit(0)
os.makedirs(os.path.join(snap, "runs"), exist_ok=True)
for i, j in runs.items(): json.dump(j, open(os.path.join(snap, "runs", i + ".json"), "w"))
json.dump(hist, open(os.path.join(snap, "history.json"), "w"))
print(f"snapshot: {len(runs)} saved live runs, {hist['snapshotAt']}")
PY

# 2. The pages, under the base path, in static mode.
(cd web && npx tsc --noEmit && VITE_CP_STATIC=1 VITE_CP_LIVE_URL="$LIVE" npx vite build --base "$BASE" --outDir "$OUT_ABS" --emptyOutDir >/dev/null)
rm -rf "$OUT/data/live"; mkdir -p "$OUT/data/live"; cp -r "$SNAP/history.json" "$SNAP/runs" "$OUT/data/live/"

# 3. GitHub Pages has no rewrites: every route gets its own copy of index.html (200, not 404), plus 404.html.
python3 - "$OUT" <<'PY'
import json, os, shutil, sys
out = sys.argv[1]
idx = json.load(open(os.path.join(out, "data", "index.json")))
hist = json.load(open(os.path.join(out, "data", "live", "history.json")))
routes = ["scan"] + [f"proof/{t['slug']}" for t in idx["targets"]] + [f"run/{f[:-5]}" for f in os.listdir(os.path.join(out, "data", "live", "runs"))]
for r in routes:
    os.makedirs(os.path.join(out, r), exist_ok=True); shutil.copy(os.path.join(out, "index.html"), os.path.join(out, r, "index.html"))
shutil.copy(os.path.join(out, "index.html"), os.path.join(out, "404.html"))
open(os.path.join(out, ".nojekyll"), "w").close()
print(f"routes: {len(routes)} + 404.html")
PY

# 4. Leak check, as ops/stage.sh does: no .env value may appear in the copy (key names only, never values).
if [ -f .env ]; then
python3 - "$OUT" <<'PY'
import os, sys
vals = {}
for line in open(".env"):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        if len(v) >= 6 and k != "PAYPAL_ENVIRONMENT": vals[k] = v.encode()
bad = [f"{os.path.join(r, f)}: {k}" for r, _, fs in os.walk(sys.argv[1]) for f in fs for k, v in vals.items() if v in open(os.path.join(r, f), "rb").read()]
if bad: sys.exit("LEAK: " + "; ".join(bad))
print(f"leak check: {len(vals)} .env values, none in {sys.argv[1]}")
PY
fi
du -sh "$OUT"
echo "built $OUT (base $BASE). Check: node web/scripts/check-phone.mjs --base http://127.0.0.1:<port>${BASE%/} --out static-check"
