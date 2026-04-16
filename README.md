# Henry

> Pull every public-record document for a Buncombe County property in ~2.5 minutes. Delivered to your Slack thread.

---

## The Problem

Every real estate transaction at a Keller Williams market center requires uploading a specific set of public-record documents to KWCommand before the file is compliant — and an agent cannot get paid until the file is compliant.

Those documents are things like the tax bill, the deed, the flood map, the sewer overlay, the permit history. Every one of them is public information. Every one of them lives on a different county or city website. Getting them all means opening 8–14 browser tabs, navigating each portal's own quirks, downloading each file, naming it, and uploading it to KWCommand. An experienced agent or transaction coordinator can do this in 30–60 minutes. An agent without a TC does it themselves.

That's the compliance problem: the documents are the gate between finishing a deal and getting paid.

But the compliance problem is the smaller half of it. Those same documents — the tax bill, the deed, the flood map — contain information that a good agent should be reviewing on every deal regardless of compliance. A flood-zone classification affects insurability. A permit history reveals unpermitted work. A tax value tells you something about the seller's equity position. An agent who actually reads these documents is a better agent. Most agents don't read them because assembling them takes an hour and by that point you just want to upload them and move on.

Henry removes the assembly cost entirely. You type a PIN or address. Henry navigates every portal, downloads every document, and posts each one directly to your Slack thread — along with a plain-English summary of what's in it. Deed arrives in ~40 seconds. Flood map in ~60 seconds. Full package in about 2.5 minutes.

The compliance requirement gets satisfied automatically. And because the documents show up one at a time with a summary, agents actually read them.

---

## The Compliance Workflow

### Before Henry

```mermaid
flowchart TD
    A[Deal goes under contract] --> B[Agent / TC opens 8–14 browser tabs]
    B --> C1[Buncombe Tax Portal]
    B --> C2[Register of Deeds]
    B --> C3[FEMA Flood Map Service]
    B --> C4[Buncombe GIS]
    B --> C5[Accela Permits]
    B --> C6[SimpliCity]
    C1 & C2 & C3 & C4 & C5 & C6 --> D[Download each file manually\n~30–60 min]
    D --> E[Rename & organize files]
    E --> F[Upload to KWCommand one by one]
    F --> G{File compliant?}
    G -- Yes --> H[Agent gets paid]
    G -- No, missing doc --> D
```

### After Henry

```mermaid
flowchart TD
    A[Deal goes under contract] --> B["/henry 546 Old Haw Creek Rd"]
    B --> C[Henry fetches all 12 docs in parallel\n~2.5 min]
    C --> D[PDFs delivered to Slack thread\none file at a time as they finish]
    D --> E[Agent downloads from Slack\ndrag-and-drop into KWCommand]
    E --> F[File compliant → Agent gets paid]
```

---

## What Henry Does

```
/henry 546 Old Haw Creek Rd

→ Slack thread fills up over ~2.5 minutes:

  :pushpin: 9648-65-1234-00000
    Owner: JOHN SMITH
    Address: 546 OLD HAW CREEK RD, ASHEVILLE NC 28806
    Deed: Book 6541 / Page 364
    Plat: Book 1234 / Page 56

  :file_folder: Parcel record
    Land value: $87,000
    Total assessed: $312,000
    Acreage: 0.43
    Year built: 1978

  :ocean: FEMA flood zone — X (minimal flood hazard)

  :toilet: Septic / sewer — On septic (1 record)

  [PDF] Property Record Card
  [PDF] Tax Bill
  [PDF] Deed — Book 6541 / Page 364
  [PDF] Plat — Book 1234 / Page 56
  [PDF] GIS Parcel Map
  [PDF] FEMA FIRMette
  [PDF] Buncombe Building Permits
  [PDF] Asheville Permits

  :checkered_flag: Done — 12/12 fetchers, 141s
```

Every PDF is a separate file upload. Each one is ready to download and drag into KWCommand.

---

## The Three Layers of Value

**1. Compliance — the payment gate**
KWCommand requires specific documents per file. Henry generates all of them. Agent or TC uploads them. File closes. Agent gets paid. This is the minimum value proposition and it alone justifies the tool.

**2. Due diligence**
The documents contain information that should inform every deal. Henry surfaces the key findings inline — flood zone, assessed value, septic vs. sewer, permit history — so agents see them without having to read a PDF. An agent who knows their property's flood zone before showing it to a buyer is doing their job better.

**3. Agent protection**
A missed flood-zone flag, an unknown lien, an unpermitted addition — these are the conversations agents do not want to have after an offer goes in. Henry makes it easy to know these things before they matter, not after.

---

## System Architecture

```mermaid
flowchart LR
    subgraph Slack["Slack Workspace"]
        U[Agent types\n/henry address]
        T[Slack Thread\nfindings + PDFs]
    end

    subgraph Vercel["Vercel — Serverless Functions"]
        CMD["POST /api/slack/command\nHMAC verify → ACK → async"]
        RES["Resolver\nBuncombe GIS → CanonicalProperty"]
        F1["Fetcher: parcel-json"]
        F2["Fetcher: fema-flood"]
        F3["Fetcher: septic"]
        F4["Fetcher: property-card"]
        F5["Fetcher: tax-bill"]
        F6["Fetcher: deed"]
        F7["Fetcher: plat"]
        F8["Fetcher: gis-map"]
        F9["Fetcher: firmette"]
        F10["Fetcher: buncombe-permits"]
        F11["Fetcher: simplicity-details"]
        F12["Fetcher: simplicity-permits"]
        ART["GET /api/artifact/:id\nbyte proxy"]
    end

    subgraph Storage["Persistent Storage"]
        NEO[(Neon Postgres\nprovenance chain)]
        BLOB[(Vercel Blob\nPDF artifacts)]
    end

    subgraph External["External Sources"]
        GIS["Buncombe GIS\nFeatureServer"]
        FEMA["FEMA NFHL API"]
        ROD["Register of Deeds\nbrowser portal"]
        TAX["Buncombe Tax\nbrowser portal"]
        ACC["Accela Permits\nbrowser portal"]
        SIM["SimpliCity\nbrowser portal"]
    end

    U --> CMD
    CMD --> RES
    RES --> GIS
    RES --> F1 & F2 & F3 & F4 & F5 & F6 & F7 & F8 & F9 & F10 & F11 & F12
    F1 & F2 & F3 --> External
    F4 & F5 & F6 & F7 & F8 & F9 & F10 & F11 & F12 --> External
    F4 --> TAX
    F5 --> TAX
    F6 & F7 --> ROD
    F10 --> ACC
    F11 & F12 --> SIM
    F1 & F2 & F3 & F4 & F5 & F6 & F7 & F8 & F9 & F10 & F11 & F12 --> NEO
    F4 & F5 & F6 & F7 & F8 & F9 & F10 & F11 & F12 --> BLOB
    F1 & F2 & F3 & F4 & F5 & F6 & F7 & F8 & F9 & F10 & F11 & F12 --> T
    ART --> BLOB
```

---

## Request Flow (Sequence)

```mermaid
sequenceDiagram
    actor Agent
    participant Slack
    participant CMD as /api/slack/command
    participant Resolver
    participant Fanout as Fan-out Coordinator
    participant F as Fetcher Functions ×12
    participant Neon
    participant Blob

    Agent->>Slack: /henry 546 Old Haw Creek Rd
    Slack->>CMD: POST (signed)
    CMD-->>Slack: HTTP 200 ACK (within 3s)
    CMD->>Slack: "Looking up 546 Old Haw Creek Rd..."

    CMD->>Resolver: resolve(address)
    Resolver->>Neon: ArcGIS parcel + address layers
    Resolver-->>CMD: CanonicalProperty {PIN, deed refs, owner...}

    CMD->>Slack: post property summary to thread
    CMD->>Fanout: runFetchersFanOut(property, delivery)

    par 12 concurrent invocations
        Fanout->>F: POST /api/fetchers/parcel-json
        Fanout->>F: POST /api/fetchers/fema-flood
        Fanout->>F: POST /api/fetchers/tax-bill
        Fanout->>F: POST /api/fetchers/deed
        Note over F: ... 8 more in parallel
    end

    loop As each fetcher resolves
        F-->>Fanout: { result, artifacts[] }
        F->>Neon: write FetcherCall + HttpHits + Artifacts
        F->>Blob: store PDF bytes
        Fanout->>Slack: post inline findings (data fetchers)
        Fanout->>Slack: upload PDF to thread (document fetchers)
    end

    Fanout->>Neon: finishRun(status, totals)
    CMD->>Slack: ":checkered_flag: Done — 12/12 fetchers, 141s"
```

---

## Fan-Out Execution Model

```mermaid
gantt
    title Fetcher execution timeline (approximate)
    dateFormat  s
    axisFormat %Ss

    section Data (REST)
    parcel-json         :done, 0, 5s
    fema-flood          :done, 0, 8s
    septic              :done, 0, 6s

    section Documents (Browser → PDF)
    property-card       :done, 0, 45s
    tax-bill            :done, 0, 40s
    deed                :done, 0, 55s
    plat                :done, 0, 50s
    gis-map             :done, 0, 35s
    firmette            :done, 0, 65s
    buncombe-permits    :done, 0, 90s
    simplicity-details  :done, 0, 80s
    simplicity-permits  :done, 0, 120s
```

Each fetcher runs in an independent Vercel Function with a **300-second budget and isolated Chromium instance**. Wall time equals the slowest fetcher — not the sum. Without parallelism this would take 8–15 minutes sequentially.

---

## Sources (12 Fetchers, Buncombe County)

| Fetcher ID | Document | Source | Method |
|---|---|---|---|
| `parcel-json` | Parcel record + owner | Buncombe ArcGIS FeatureServer | REST |
| `fema-flood` | Flood zone + panel data | FEMA NFHL API | REST |
| `septic` | Septic / sewer status | Buncombe GIS | REST |
| `property-card` | Property Record Card | Spatialest | Browser → PDF |
| `tax-bill` | Tax Bill | Buncombe Tax Portal | Browser → PDF |
| `deed` | Deed | Buncombe Register of Deeds | Browser → PDF |
| `plat` | Plat | Buncombe Register of Deeds | Browser → PDF |
| `gis-map` | GIS Parcel Map | Buncombe GIS | Browser → PDF |
| `firmette` | FEMA FIRMette flood map | FEMA Flood Map Service Center | Browser → PDF |
| `buncombe-permits` | Building Permits | Buncombe Accela | Browser → PDF |
| `simplicity-details` | Asheville Property Details | SimpliCity | Browser → PDF |
| `simplicity-permits` | Asheville Permit History | SimpliCity | Browser → PDF |

Asheville-specific fetchers skip gracefully for properties outside city limits. Deed and Plat skip if no book/page reference is found in the parcel record.

---

## Provenance Chain

Every fact Henry produces is fully traceable. Given any artifact, you can answer: what URL was fetched, at what time, with what response code, by what version of the fetcher, triggered by which Slack user in which channel.

```mermaid
erDiagram
    Invocation {
        uuid id
        string slack_user_id
        string channel_id
        string raw_text
        timestamp created_at
    }
    Run {
        uuid id
        uuid invocation_id
        string pin
        string address
        string owner
        string status
        int fetchers_completed
        int fetchers_failed
        int duration_ms
        timestamp created_at
    }
    FetcherCall {
        uuid id
        uuid run_id
        string fetcher_id
        string status
        jsonb result
        string error
        int duration_ms
        timestamp created_at
    }
    HttpHit {
        uuid id
        uuid fetcher_call_id
        string method
        string url
        int status_code
        string response_hash
        int duration_ms
        timestamp created_at
    }
    Artifact {
        uuid id
        uuid fetcher_call_id
        string label
        string content_type
        string storage_uri
        string sha256
        int bytes
        timestamp created_at
    }

    Invocation ||--o{ Run : triggers
    Run ||--o{ FetcherCall : contains
    FetcherCall ||--o{ HttpHit : records
    FetcherCall ||--o{ Artifact : produces
```

This matters for compliance: you can prove what Henry retrieved, from where, and when. Every run is queryable at `GET /api/runs/:id`.

---

## API Endpoints

| Route | Purpose |
|---|---|
| `POST /api/slack/command` | `/henry` slash command handler |
| `POST /api/slack/events` | `@henry` mention handler |
| `POST /api/fetchers/:id` | Fan-out executor — one per fetcher, internal |
| `GET /api/runs` | List recent runs (auth: HENRY_API_TOKEN) |
| `GET /api/runs/:id` | Full audit trace for a run |
| `GET /api/artifact/:id` | Proxy artifact bytes from Blob store |

---

## Deployment

Henry runs on Vercel. Required environment variables:

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Database (Neon Postgres)
DATABASE_URL=postgres://...
PROVENANCE_BACKEND=postgres

# Artifact storage (Vercel Blob)
BLOB_READ_WRITE_TOKEN=...
ARTIFACT_BACKEND=vercel-blob

# Routing (enables fan-out + trace links)
PUBLIC_BASE_URL=https://henry-slack.vercel.app

# Optional auth
HENRY_API_TOKEN=...        # Bearer token for /api/runs/*
HENRY_INTERNAL_TOKEN=...   # Header auth on /api/fetchers/*
```

Database schema: `src/provenance/migrations/001_init.sql`

---

## Development History

Henry started as a local CLI tool (`apps/fops/henry`) — TypeScript, Playwright, better-sqlite3, sequential execution, output to a local folder. That version proved the fetchers worked against real Buncombe portals and established the document set needed for KWCommand compliance.

Henry 2 (`henry-slack`, this repo) is the production rewrite:

| | henry (v1) | henry-slack (v2) |
|---|---|---|
| Interface | CLI prompt | Slack slash command |
| Execution | Sequential, one browser at a time | 12 parallel Vercel Functions |
| Storage | SQLite + local files | Neon Postgres + Vercel Blob |
| Delivery | `results/` folder on disk | Slack thread, one file at a time |
| Audit trail | Local SQLite rows | Full provenance chain in Neon |
| Runtime | Local machine | Vercel (serverless, always-on) |
| Wall time | ~3 minutes | ~2.5 minutes |
| Tests | 239 (unit + integration) | 58 (unit + live integration) |

The fetcher logic — the actual browser automation for each portal — carried over directly. The architecture around it was rebuilt from scratch for cloud-native parallel execution and always-on availability.

---

## Local Development

```bash
npm install
npx playwright install chromium

# Resolve an address (no Slack needed)
tsx scripts/resolve.ts "546 Old Haw Creek Rd"

# Run all fetchers locally (no Slack needed)
tsx scripts/fetch.ts "546 Old Haw Creek Rd"
# → writes to ./tmp/runs/<runId>/

# Type check
npx tsc --noEmit

# Tests
npm test
```

Local scripts use in-memory provenance and filesystem artifact storage — no Neon or Blob credentials required.
