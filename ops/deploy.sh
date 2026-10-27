#!/usr/bin/env bash
# Deploys the judge-facing site to Cloud Run (project checkout-proof-gdr, behind ops/kill-switch.sh's EUR 2 cap).
# Caps: one instance at most, scale to zero, 1 vCPU / 2 GiB, CPU only during requests, 80 requests per instance
# (20 gave Cloud Run's own 429 "Rate exceeded" on a phone page load while a re-run held the CPU, 18 Oct).
# max-instances is best effort: during a rollout or a CPU-bound re-run Cloud Run briefly started a second instance
# (18 Oct). The daily caps, the one-re-run-at-a-time slot and every finished live run are in Firestore (Native,
# database "(default)", free tier; runtime SA cp-run@ has roles/datastore.user), so restarts and extra instances
# share them. A running job writes its progress to Firestore as each scenario finishes, and a PayPal delivery that
# reaches another instance is stored there and handed to the running shop (21 Oct incident, PROGRESS).
# CPU stays request-based (--cpu-throttling): while a live run goes on, the server holds one request to itself through
# CP_PUBLIC_URL, so the run finishes with the tab closed and is billed only for the run's minutes (PROGRESS, review r2
# A2 item 4: always-allocated CPU would bill every idle minute before scale-down, for no gain). --timeout 1200: that
# hold is one request for the whole run (≤ 15 min + margin); with 300 s it had to be re-opened, and on 21 Oct Cloud Run
# stopped the run's instance in that gap (a second instance existed; the idle one is the one scaled in). A longer
# timeout costs nothing by itself: billing is per open request, and every request here ends on its own.
# Re-run caps (25 Oct, review r3 A2): the budget excludes all credits, so Cloud Run usage counts at gross price
# (~EUR 0.000024 per instance-second at 1 vCPU / 2 GiB: Oct's EUR 0.17 matches the month's 6,900 billable s).
# 6 upgraded runs a day projected EUR 1.4-1.6 for 1-16 Nov against the EUR 2 cap; 3 a day, ~EUR 0.9. The four slices
# of the UTC day stay (3 slices would open the original's 6th run at 16:00 instead of 18:00): upgraded 1 at 00:00,
# 2 from 06:00, 3 from 12:00; original 2, 3, 5, 6 as before. Tighten only; never raise.
# Judges only (28 Oct, owner): a run needs CP_JUDGE_CODE (Secret Manager; given to the judges in Devpost's private
# testing instructions), so the public costs nothing but page loads and scans. 10 a day of each kind, one slice (judges
# come at any hour), 5 each per visitor, and hard monthly caps, counted in Firestore like the daily ones: 70 upgraded
# × ~530 s + 60 original × ~78 s ≈ 48,000 instance-s ≈ EUR 1.0 a month at most, under the EUR 2 cap even if the code
# leaks (EUR 0.15 a day at the full daily caps would trip it in ~13 days without them).
# CP_NOINDEX=0: public since 27 Oct 2026 (owner's OK), so search engines may index it.
# Secrets come from Secret Manager (names only here). PAYPAL_WEBHOOK_ID is added once the sandbox webhook exists.
set -euo pipefail
cd "$(dirname "$0")"
PROJECT=checkout-proof-gdr REGION=us-central1
bash stage.sh
SECRETS=PAYPAL_CLIENT_ID=PAYPAL_CLIENT_ID:latest,PAYPAL_CLIENT_SECRET=PAYPAL_CLIENT_SECRET:latest,PAYPAL_SANDBOX_BUYER_EMAIL=PAYPAL_SANDBOX_BUYER_EMAIL:latest,PAYPAL_SANDBOX_BUYER_PASSWORD=PAYPAL_SANDBOX_BUYER_PASSWORD:latest,CP_JUDGE_CODE=CP_JUDGE_CODE:latest
if gcloud --project "$PROJECT" secrets describe PAYPAL_WEBHOOK_ID >/dev/null 2>&1; then SECRETS="$SECRETS,PAYPAL_WEBHOOK_ID=PAYPAL_WEBHOOK_ID:latest"; fi
gcloud run deploy checkout-proof --project "$PROJECT" --region "$REGION" --source ../out/deploy --quiet \
  --service-account "cp-run@$PROJECT.iam.gserviceaccount.com" --allow-unauthenticated \
  --execution-environment gen2 --cpu 1 --memory 2Gi --cpu-throttling --no-cpu-boost \
  --min-instances 0 --max-instances 1 --concurrency 80 --timeout 1200 --session-affinity \
  --set-env-vars "CP_NOINDEX=0,PAYPAL_ENVIRONMENT=sandbox,CP_STORE=firestore,CP_FIRESTORE_PROJECT=$PROJECT,CP_RERUN=cloud,CP_RERUN_DAILY=10,CP_RERUN_PER_VISITOR=5,CP_ORIGINAL_DAILY=10,CP_ORIGINAL_PER_VISITOR=5,CP_RERUN_MONTHLY=70,CP_ORIGINAL_MONTHLY=60,CP_RERUN_SLICES=1,CP_PUBLIC_URL=https://checkout-proof-149219545146.us-central1.run.app,CP_SCAN_PER_MIN=4,CP_SCAN_PER_DAY=20,CP_SCAN_GLOBAL_PER_DAY=200" \
  --set-secrets "$SECRETS"
