# Checkout Proof on Cloud Run: the gallery server (web/dist + exported evidence), the scan box, and "re-run proof"
# (the upgraded simple-clothing-store and, for "watch the original lose money", the original one, both built, plus Playwright's headless Chromium for the sandbox buyer).
# Built from the staging folder that ops/stage.sh assembles; no credential is ever in the build context or image:
# PayPal sandbox values arrive as env vars from Secret Manager at run time.
FROM node:22-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOST=0.0.0.0 CP_TRUST_PROXY=1 CP_RERUN=cloud
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /root/.npm /var/lib/apt/lists/*
COPY out/work/simple-clothing-store-upgraded/package.json out/work/simple-clothing-store-upgraded/package-lock.json out/work/simple-clothing-store-upgraded/
RUN cd out/work/simple-clothing-store-upgraded && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm
COPY out/work/simple-clothing-store/package.json out/work/simple-clothing-store/package-lock.json out/work/simple-clothing-store/
RUN cd out/work/simple-clothing-store && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm
COPY . .
RUN chown -R node:node /app/out
USER node
CMD ["node", "--import", "tsx", "server/index.ts"]
