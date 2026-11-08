# Quran Reader — Cross-Device Cloudflare Sync Worker

A Cloudflare Worker paired with a SQLite-backed Durable Object providing strongly consistent, real-time synchronization of Quran reading progress and bookmarks across devices (such as desktop Opera on macOS and Opera on Android).

---

## Architecture Overview

```
 [Mac Mini Opera]                       [Android Opera]
         │                                      │
         │ (GET/PUT /api/sync)                  │ (GET/PUT /api/sync)
         │ Bearer: <sync-password>              │ Bearer: <sync-password>
         ▼                                      ▼
    ┌─────────────────────────────────────────────────┐
    │          Cloudflare Worker (Edge API)           │
    │  - CORS preflight & header validation           │
    │  - Authentication check                         │
    │  - Hash sync password -> Durable Object ID      │
    └───────────────────────┬─────────────────────────┘
                            │
                            ▼
    ┌─────────────────────────────────────────────────┐
    │     Durable Object (Strongly Consistent)        │
    │  - Global single-point coordination per DO ID   │
    │  - Transactional SQLite database storage:       │
    │      sync_state (chapter, verse, bookmarks,     │
    │                  translation, updated_at)       │
    │  - Atomic conflict resolution (Last-Write-Wins) │
    └─────────────────────────────────────────────────┘
```

### Why SQLite-backed Durable Objects over Workers KV?
Workers KV is **eventually consistent**. Writes made from one location (e.g. mobile cellular network) can take up to 60 seconds to propagate to other data centers. If you switch devices quickly, you may read stale progress.

**Durable Objects with SQLite storage** provide:
- **Strong consistency**: Reads and writes go to the same globally unique SQLite instance.
- **Transactional safety**: Uses `ON CONFLICT DO UPDATE WHERE excluded.updated_at >= sync_state.updated_at` to atomically reject out-of-order writes.
- **Zero user accounts**: A shared sync password hashes directly to the DO ID, providing isolated storage per user without requiring traditional passwords, emails, or sessions.
- **Included on the free tier**: 100,000 requests/day and 5 GB SQLite storage.

---

## Deployment Steps

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

### 3. (Optional) Set a Master Secret
If you wish to restrict your Worker so that only requests with a specific pre-shared secret can access it, set the secret:

```bash
npx wrangler secret put SYNC_SECRET
```
*When prompted, enter your secret password.*

> If `SYNC_SECRET` is not set, each distinct sync key entered by users derives its own isolated SQLite Durable Object instance via SHA-256 hash.

### 4. Deploy to Cloudflare
Deploy the Worker and create the SQLite Durable Object migration:

```bash
npx wrangler deploy
```

Wrangler will output your public Worker URL, for example:
```
https://quran-reader-sync.<your-subdomain>.workers.dev
```

### 5. Local Development (Optional)
To run and test the Worker locally:

```bash
npx wrangler dev
```
Local URL will typically be `http://localhost:8787`.

---

## Connecting Devices in the Quran Reader App

1. Open your Quran Reader in the browser (e.g., Mac Mini Opera).
2. Tap **Controls** in the header.
3. In the **Cross-device sync** panel:
   - **Worker URL**: Enter your deployed Worker URL (e.g. `https://quran-reader-sync.<subdomain>.workers.dev`).
   - **Sync password**: Click **Generate key** (or enter a private secret password of your choice).
   - Click **Save & connect**.
4. The status badge will show **Synced** with the current reading position.
5. On your second device (e.g., Android Opera):
   - Open Quran Reader -> **Controls** -> **Cross-device sync**.
   - Enter the exact same **Worker URL** and **Sync password**.
   - Click **Save & connect**.
   - Your reading position and bookmarks will immediately pull into the device.

---

## API Specification

### `GET /api/sync`
Fetches current reading progress and bookmarks.

- **Headers:**
  - `Authorization: Bearer <sync-password>` (or `X-Sync-Key: <sync-password>`)
- **Response (200 OK):**
  ```json
  {
    "empty": false,
    "chapter": 2,
    "verse": 255,
    "bookmarks": [
      { "chapter": 1, "verse": 1 }
    ],
    "translation": "en.sahih",
    "updatedAt": 1794123456789
  }
  ```

### `PUT /api/sync`
Updates reading progress and bookmarks.

- **Headers:**
  - `Authorization: Bearer <sync-password>` (or `X-Sync-Key: <sync-password>`)
  - `Content-Type: application/json`
- **Body:**
  ```json
  {
    "chapter": 2,
    "verse": 255,
    "bookmarks": [
      { "chapter": 1, "verse": 1 }
    ],
    "translation": "en.sahih",
    "updatedAt": 1794123456789
  }
  ```
- **Response (200 OK):**
  Returns the authoritative current state stored in SQLite.

### `GET /health`
Health check endpoint returning `{ "status": "ok", "service": "quran-reader-sync" }`.
