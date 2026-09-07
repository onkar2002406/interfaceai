# CoreBank + MERIDIAN control panel image.
#
# Based on the official Playwright image so the Chromium build the surface
# driver needs — and every system library it links against — is already
# present and already the right version for playwright@1.62.1. Installing
# Chromium into a plain node image is possible but is a long list of apt
# packages that drifts every release; this keeps the two in lockstep.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV NODE_ENV=development \
    CI=1

WORKDIR /app

# Dependencies first, as their own layer, so a source-only change does not
# reinstall node_modules. devDependencies are kept: `npm run panel` runs
# `vite build` for the React front end, and vite/tsx/typescript live there.
COPY package.json package-lock.json ./
RUN npm ci

# Application source.
COPY . .

# Pre-build the React panel bundle into the image. `npm run panel` would do
# this on boot, but doing it here means the container starts serving in
# seconds instead of running a Vite build every time.
RUN npm run build:ui

# Typecheck and the full suite, at BUILD time rather than on every container
# start. Build time is the right moment for both reasons: the image cannot be
# produced from a red tree, and the e2e file — which starts its own CoreBank
# instances on 4000-4002 and drives a real browser — has those ports to itself
# here, where nothing else is listening yet. Running it in the entrypoint
# instead would race the servers it is about to check.
#
# No test reaches the network: the e2e suite drives the bundled app, and the
# MERIDIAN cases assert on policy and URL resolution, not on the hosted target.
RUN npm run typecheck && npm test

# Panels (4200 CoreBank, 4300 MERIDIAN), operator consoles (4100 / 4101),
# and the three CoreBank tenant instances (4000-4002).
EXPOSE 4000 4001 4002 4100 4101 4200 4300

# Compose passes the concrete command per service; default to the CoreBank
# stack (target instances + control panel + operator console) so a bare
# `docker run` of this image is still useful.
CMD ["bash", "docker/start.sh", "corebank"]
