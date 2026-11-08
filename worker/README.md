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

- Changes to `worker/` merged into `main` deploy to production.
- The first production deploy renames the existing Worker from `quran-reader-sync`
  to `quran` in place, preserving the Worker identity and its Durable Object data.
- Same-repository pull requests get an isolated Worker preview. The preview is
  removed when the pull request closes, including its temporary Durable Object
  storage. Fork pull requests do not get a Cloudflare preview.

Add this value in the repository's **Settings → Secrets and variables → Actions**:

- **Secret** `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with **Edit Cloudflare
  Workers** access, scoped to the `quran` Worker in the account set in
  `wrangler.jsonc`.

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
npx wrangler deploy
```

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
the setup code. Anyone with the code can read or change that sync space. Different
random keys map to separate Durable Objects.

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
