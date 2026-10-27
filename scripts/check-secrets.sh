#!/usr/bin/env bash
# Fails if any .env value appears in what is about to be committed. Prints only the variable NAME, never the value.
#   scripts/check-secrets.sh                 # the staged diff
#   scripts/check-secrets.sh <paths...>      # working-tree diff of those paths plus their untracked files
#                                            # (the repo rule: commit with `git commit -- <paths>`, nothing staged)
set -euo pipefail
ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"
cd "$(git rev-parse --show-toplevel)"
if [[ $# -gt 0 ]]; then
  diff=$(git diff HEAD -U0 -- "$@"; git ls-files --others --exclude-standard -z -- "$@" | xargs -0 -r cat)
else
  diff=$(git diff --cached -U0)
fi
bad=0
while IFS='=' read -r k v; do
  [[ -z "$k" || "$k" =~ ^# || "$k" == PAYPAL_ENVIRONMENT || ${#v} -lt 6 ]] && continue
  if grep -qF -- "$v" <<<"$diff"; then echo "diff contains the value of $k"; bad=1; fi
done < "$ENV"
[[ $bad = 0 ]] && echo "check-secrets: clean"
exit $bad
