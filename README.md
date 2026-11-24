# Elvebredd values scraper (GitHub Action)

Every 12 hours (00:00 and 12:00 UTC) this scrapes the current pet values from
https://elvebredd.com/calculator and writes them to `data/elve-values.json`.
Each run replaces the whole file, so it only ever holds the latest values.

## Setup

1. Copy `.github/workflows/scrape-elve.yml` and `scripts/scrape-elve.js` into the
   repo, keeping the same paths.
2. In the repo go to **Settings → Actions → General → Workflow permissions** and
   pick **Read and write permissions**. The workflow needs this to push the file.
3. Run it once by hand: **Actions → Scrape Elvebredd values → Run workflow**.

No npm install is needed. The script only uses Node's built-in modules.

## How it works

- The page is behind Cloudflare, so the job runs FlareSolverr as a service
  container and fetches the page through it.
- The values are inside the Next.js page data (`self.__next_f.push(...)`). The
  script decodes that and finds the pet list wherever it is, so a renamed key
  (it has changed before) doesn't break it.
- If fewer than 10 pets are found, the run fails and the existing file is left as
  it was. Nothing bad gets committed.
- A commit is only made when the file actually changed.

## Output

```json
{
  "source": "https://elvebredd.com/calculator",
  "scrapedAt": "2026-11-23T12:00:00.000Z",
  "count": 1234,
  "pets": [
    {
      "id": 1,
      "name": "...",
      "image": "...",
      "rarity": "legendary",
      "category": "pets",
      "flyRide": true,
      "rvalue": 1.5, "nvalue": 3, "mvalue": 9,
      "rvalueNopotion": null, "rvalueRide": null, "rvalueFly": null, "rvalueFlyRide": 2,
      "nvalueNopotion": null, "nvalueRide": null, "nvalueFly": null, "nvalueFlyRide": null,
      "mvalueNopotion": null, "mvalueRide": null, "mvalueFly": null, "mvalueFlyRide": null
    }
  ]
}
```

`r` = regular, `n` = neon, `m` = mega. The suffixes are the potion variants.

## Options (env vars on the "Scrape values" step)

| Var | Default | |
|---|---|---|
| `OUTPUT_FILE` | `data/elve-values.json` | Where the file is written. If you change it, change the `git add` line too |
| `MIN_PETS` | `10` | Fewer pets than this counts as a failed scrape |

GitHub may run scheduled jobs a few minutes late. In public repos it also turns
schedules off after 60 days with no repo activity. If that happens, re-enable the
workflow in the Actions tab.
