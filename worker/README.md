# Quran Reader — Cross-Device Cloudflare Sync Worker

A Cloudflare Worker paired with a SQLite-backed Durable Object providing strongly consistent, real-time synchronization of Quran reading progress and bookmarks across devices (such as desktop Opera on macOS and Opera on Android).

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
    │      sync_state (chapter, verse, bookmarks,     │
    │                  translation, updated_at)       │
    │  - Position/translation Last-Write-Wins          │
    │  - Per-verse bookmark additions/removals        │
    └─────────────────────────────────────────────────┘
```

### Why SQLite-backed Durable Objects over Workers KV?
Workers KV is **eventually consistent**. Writes made from one location (e.g. mobile cellular network) can take up to 60 seconds to propagate to other data centers. If you switch devices quickly, you may read stale progress.

**Durable Objects with SQLite storage** provide:
- **Strong consistency**: Reads and writes go to the same globally unique SQLite instance.
- **Transactional safety**: SQLite updates position and translation only when the incoming timestamp is current; bookmark changes merge independently per verse.
- **No shared public credential**: Each user generates a private random pairing key. Its hash maps to an isolated Durable Object without traditional passwords, email addresses, or sessions.
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
3. On the first device, in the **Cross-device sync** panel:
   - **Worker URL**: Enter your deployed Worker URL (e.g. `https://quran-reader-sync.<subdomain>.workers.dev`).
   - **Pairing key**: Click **Generate key**, then **Copy key**. The key is generated with the browser's cryptographic random-number generator; keep it private.
   - Click **Save & connect**.
4. Nothing is sent to Cloudflare before **Save & connect**. After connecting, the reader sends reading position, bookmark changes, and the selected translation identifier to this Worker; translation text stays local. Sync then runs automatically.
5. On each additional device (e.g., Android Opera):
   - Open Quran Reader -> **Controls** -> **Cross-device sync**.
   - Enter the exact same **Worker URL** and paste the copied **Pairing key**.
   - Click **Save & connect**.
   - The device pulls the current state and joins automatic sync.

Anyone with the pairing key can read or change the corresponding sync space.
Different random keys map to separate Durable Objects.

---

## API Specification

Authenticate each request with the private pairing key using `Authorization:
Bearer <pairing-key>` or `X-Sync-Key: <pairing-key>`.

### `GET /api/sync`
Fetches current reading progress and bookmarks.

- **Headers:**
  - `Authorization: Bearer <pairing-key>` or `X-Sync-Key: <pairing-key>`.
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
  - `Authorization: Bearer <pairing-key>` or `X-Sync-Key: <pairing-key>`.
  - `Content-Type: application/json`
- **Body:**
  ```json
  {
    "chapter": 2,
    "verse": 255,
    "bookmarks": [
      { "chapter": 1, "verse": 1 }
    ],
    "bookmarkChanges": [
      { "chapter": 1, "verse": 1, "bookmarked": true, "updatedAt": 1794123456789 }
    ],
    "translation": "en.sahih",
    "updatedAt": 1794123456789
  }
  ```
- **Response (200 OK):**
  Returns the authoritative current state stored in SQLite. When
  `bookmarkChanges` is present, each per-verse add/remove is reconciled
  independently; removal tombstones prevent older snapshots from restoring a
  deleted bookmark. Clients that omit `bookmarkChanges` are treated as legacy
  clients and can add bookmarks but cannot delete existing ones.
- `updatedAt` and each bookmark-change timestamp must be positive safe integers
  no more than five minutes ahead of Worker time. Unsafe or unreasonable future
  values are rejected. Existing out-of-range stored timestamps are repaired on
  read so they cannot permanently block updates.

### `GET /health`
Health check endpoint returning `{ "status": "ok", "service": "quran-reader-sync" }`.
