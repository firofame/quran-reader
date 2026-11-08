# Quran Reader — Cross-Device Sync Worker

A Cloudflare Worker paired with a SQLite-backed Durable Object provides strongly consistent, real-time synchronization of Quran reading progress across devices. The reader app is configured to use `https://quran.firofame.workers.dev`; readers do not need to deploy the Worker or enter its URL.

---

## Architecture Overview

```
 [Mac Mini Opera]                       [Android Opera]
         │                                      │
         │ (GET/PUT /api/sync)                  │ (GET/PUT /api/sync)
         │ Bearer: <private pairing key>        │ Bearer: <same private key>
         ▼                                      ▼
    ┌─────────────────────────────────────────────────┐
    │          Cloudflare Worker (Edge API)           │
    │  - CORS preflight & header validation           │
    │  - Authentication check                         │
    │  - Hash pairing key -> Durable Object ID        │
    └───────────────────────┬─────────────────────────┘
                            │
                            ▼
    ┌─────────────────────────────────────────────────┐
    │     Durable Object (Strongly Consistent)        │
    │  - Global single-point coordination per DO ID   │
    │  - Transactional SQLite database storage:       │
    │      sync_state (chapter, verse,                │
    │                  translation, updated_at)       │
    │  - Position/translation Last-Write-Wins         │
    └─────────────────────────────────────────────────┘
```

### Why SQLite-backed Durable Objects over Workers KV?
Workers KV is **eventually consistent**. Writes made from one location (e.g. mobile cellular network) can take up to 60 seconds to propagate to other data centers. If you switch devices quickly, you may read stale progress.

**Durable Objects with SQLite storage** provide:
- **Strong consistency**: Reads and writes go to the same globally unique SQLite instance.
- **Transactional safety**: SQLite updates position and translation only when the incoming timestamp is current.
- **No shared public credential**: Each user generates a private random pairing key. Its hash maps to an isolated Durable Object without traditional passwords, email addresses, or sessions.
- **Included on the free tier**: 100,000 requests/day and 5 GB SQLite storage.

---

## Maintainer Deployment (One Time)

These steps are for the project maintainer. The reader app already points to the
project's deployed Worker.

The reader site's default address is `DEFAULT_SYNC_ENDPOINT` in
[`../sync-client.js`](../sync-client.js). If the Worker is moved to a different
Cloudflare account or hostname, update that constant before publishing the reader.

### GitHub Actions

The repository's `.github/workflows/deploy-worker.yml` deploys this Worker with
Wrangler:

- Changes to `worker/` merged into `main` deploy to production after syntax checks
  and the full test suite. Manual production dispatch is restricted to `main`
  once this workflow exists on the default branch.
- Production reuses the existing `quran` Worker. If only `quran-reader-sync`
  exists, it is renamed in place. The workflow never creates a replacement
  Worker and verifies the immutable Worker ID and active Durable Object namespace
  bindings before and after deployment.
- A same-repository PR targeting `main` can deploy to production without merging
  through the explicit maintainer opt-in below. Ordinary PR pushes deploy only
  an isolated preview, even if the production label is still present.
- Same-repository pull requests get an isolated Worker preview. The preview is
  removed when the pull request closes, including its temporary Durable Object
  storage. Fork pull requests do not get a Cloudflare preview.

Add this value in the repository's **Settings → Secrets and variables → Actions**:

- **Secret** `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with Workers edit
  access in the account set in `wrangler.jsonc`. During a legacy rename, use
  temporary account-scoped **Workers Scripts: Edit** access, or verified
  individual-Worker edit access to the existing Worker's identity. A token
  limited only to a future `quran` resource does not authorize editing an
  existing `quran-reader-sync` resource.

After migration and production verification succeed, reduce the token to the
existing `quran` Worker's permissions where supported. When `quran` already
exists, the workflow does not probe the legacy resource, so it does not require
access to a different, retired Worker. The selected Worker is updated by its
immutable ID, not deleted and recreated.

The production workflow tests the actual Actions secret with an in-place name
update (a same-name update when already migrated) and Wrangler deployment.
Secret existence, a local login, and successful preview deployment do **not**
prove these production permissions. HTTP authorization failures, name conflicts,
unexpected API responses, or changed namespace identities stop the job explicitly.
Do not paste deployment tokens into setup codes, source files, or workflow logs.

### Explicit pre-merge production deployment

1. Push the approved changes to the same-repository PR branch and wait for green
   reader validation and the isolated preview on that exact head commit.
2. A maintainer with repository **write**, **maintain**, or **admin** access creates
   and applies the label `deploy-sync-production`. Applying the label is the
   production authorization; users with only read or triage access cannot deploy.
3. The production job checks out the exact PR head, checks both the label sender
   and rerun actor's permissions, and runs all tests before production changes.
   It rechecks that the PR is open, still targets `main`, retains the label, and
   has the same head before the in-place update. Production jobs are serialized.
4. The job verifies edit permissions and preserves the existing Worker, deploys,
   and checks `/health` for `status: "ok"` and `service: "quran"`. It compares
   Worker/namespace identity, reads a synthetic private sync canary written before
   deployment, checks the new API's read/write payload, and confirms a different
   fresh key has no state. The pre-deployment canary includes an empty legacy
   bookmarks field for older Workers; normal reader requests do not include it.
   Canary keys are
   masked in logs and the runner's private state file is removed on completion.
   These checks never use an existing reader's pairing key; the synthetic canary
   leaves only its isolated sample state in the service.
5. Confirm the deployed revision and verification results in the Actions job
   summary, then remove the opt-in label. If the PR head changes, wait for green
   checks and remove/reapply the label to authorize that new revision.

This deploys the **Worker only**. It neither merges the PR nor publishes the reader
site; GitHub Pages continues to publish through the normal `main` workflow.

The Worker's optional `SYNC_SECRET` is for API authentication and is unrelated
to deployment; leave it unset for normal per-device pairing. Wrangler's local
`wrangler login` session also cannot authenticate a GitHub Actions runner.

### 1. Prerequisites
- [Node.js](https://nodejs.org/) v20 or later.
- A free [Cloudflare account](https://dash.cloudflare.com/).

### 2. Login to Cloudflare Wrangler
From your terminal, navigate to the `worker/` directory and authenticate with Cloudflare:

```bash
cd worker
npx wrangler login
```

A browser window will open asking you to authorize Wrangler.

### 3. Keep per-key isolation enabled

For normal use, do not set `SYNC_SECRET`. The Worker hashes each supplied
pairing key to a different Durable Object ID. If `SYNC_SECRET` is configured,
the Worker accepts only that exact value, so every accepted client would use
the same sync space and generated per-device keys would not work.

### 4. Deploy to Cloudflare
Deploy the Worker and create the SQLite Durable Object migration:

```bash
cd ..
npm run check
npm test
cd worker
npm run check
npx wrangler deploy
```

If the legacy Worker still exists, migrate it in place with verified edit
permissions before running a manual deploy; do not create a fresh `quran`
Worker and assume its Durable Object data will be shared.

Wrangler will output your public Worker URL, for example:
```
https://quran.firofame.workers.dev
```

### 5. Local Development (Optional)
To run and test the Worker locally:

```bash
npx wrangler dev
```
Local URL will typically be `http://localhost:8787`.

---

## Connecting Devices in the Quran Reader App

1. On the first device, open **Controls** → **Cross-device sync** and choose
   **Start syncing**.
2. Choose **Copy setup code** and keep it private.
3. On each additional device, paste the code under **Another device** and choose
   **Join sync**.

The app creates a random private key and includes it with the service address in
the setup code. Codes are Base64url-encoded, not encrypted, and are accepted only
for `https://quran.firofame.workers.dev`. Anyone with the code can read or change
that sync space. Different random keys map to separate Durable Objects.

Saved sync configurations for other services are cleared before startup sync;
local reading progress and preferences are preserved. Those devices must choose
**Start syncing** or rejoin with a valid project-service setup code.

---

## API Specification

Authenticate each request with the private pairing key using `Authorization:
Bearer <pairing-key>` or `X-Sync-Key: <pairing-key>`.

### `GET /api/sync`
Fetches current reading progress.

- **Headers:**
  - `Authorization: Bearer <pairing-key>` or `X-Sync-Key: <pairing-key>`.
- **Response (200 OK):**
  ```json
  {
    "empty": false,
    "chapter": 2,
    "verse": 255,
    "translation": "en.sahih",
    "updatedAt": 1794123456789
  }
  ```

### `PUT /api/sync`
Updates reading progress.

- **Headers:**
  - `Authorization: Bearer <pairing-key>` or `X-Sync-Key: <pairing-key>`.
  - `Content-Type: application/json`
- **Body:**
  ```json
  {
    "chapter": 2,
    "verse": 255,
    "translation": "en.sahih",
    "updatedAt": 1794123456789
  }
  ```
- **Response (200 OK):**
  Returns the authoritative current state stored in SQLite.
- `updatedAt` must be a positive safe integer no more than five minutes ahead of
  Worker time. Unsafe or unreasonable future values are rejected. Existing
  out-of-range stored timestamps are repaired on read so they cannot permanently
  block updates.

### `GET /health`
Health check endpoint returning `{ "status": "ok", "service": "quran" }`.
