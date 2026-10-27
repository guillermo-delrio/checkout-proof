#!/usr/bin/env bash
# Assembles the Cloud Run build context in out/deploy/ from tracked sources, the built gallery and the built
# upgraded simple-clothing-store work copy, then fails if any .env value appears anywhere in it.
set -euo pipefail
cd "$(dirname "$0")/.."
D=out/deploy
rm -rf "$D"; mkdir -p "$D/out/work"
(cd web && npm run build >/dev/null)
cp package.json package-lock.json tsconfig.json "$D/"
cp -r server src harness "$D/"
mkdir -p "$D/web"; cp -r web/dist "$D/web/dist"
W=out/work/simple-clothing-store-upgraded
mkdir -p "$D/$W"
cp -r "$W/server.js" "$W/lib" "$W/build" "$W/package.json" "$W/package-lock.json" "$W/LICENSE.md" "$D/$W/"
git -C "$W" rev-parse --short HEAD > "$D/$W/.cp-commit"
# The original shop too, for "watch the original lose money" (it has no git: name the upstream commit it came from).
O=out/work/simple-clothing-store
mkdir -p "$D/$O"
cp -r "$O/server.js" "$O/lib" "$O/build" "$O/package.json" "$O/package-lock.json" "$O/LICENSE.md" "$D/$O/"
echo "upstream $(git -C out/targets/simple-clothing-store rev-parse --short HEAD)" > "$D/$O/.cp-commit"
cp ops/Dockerfile "$D/Dockerfile"
printf '.gcloudignore\n' > "$D/.gcloudignore"
# Leak check: no .env value (6+ chars) may appear in the context. Prints key names only, never values.
python3 - "$D" <<'PY'
import os, sys
vals = {}
for line in open(".env"):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        if len(v) >= 6 and k != "PAYPAL_ENVIRONMENT": vals[k] = v.encode()
bad = []
for root, _, files in os.walk(sys.argv[1]):
    for f in files:
        b = open(os.path.join(root, f), "rb").read()
        bad += [f"{os.path.join(root, f)}: {k}" for k, v in vals.items() if v in b]
if bad: sys.exit("LEAK: " + "; ".join(bad))
print(f"leak check: {len(vals)} .env values, none in {sys.argv[1]}")
PY
du -sh "$D"
