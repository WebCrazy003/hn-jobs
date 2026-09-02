# HN Job Fetcher

A local, single-user reader for Hacker News monthly “Who is hiring?” threads. The app imports new top-level job comments every five minutes while it is running, preserves seen state in SQLite, and shows jobs from every imported month in one paginated list.

## Requirements

- Node.js 24 or newer
- npm

## Run locally

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:3000>, visit Settings, and paste the current HN thread URL.

The SQLite database is stored at `data/hn-jobs.sqlite`. Fetching stops when the Node process stops.

## Checks

```bash
npm run check
```

See [SPEC.md](./SPEC.md) for the complete product and technical specification.
