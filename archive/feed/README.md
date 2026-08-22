# Archived: Social Feed + X API

Removed from the live site (Aug 2026) so Home / Ownership / Markets refresh stays lean. Restore pieces from here if you want Feed again.

## What’s here

| File | Role |
|------|------|
| `fetch_social.py` | X API v2 pull → `social_data.js` (`X_BEARER_TOKEN`) |
| `annotate_social.py` | Player-mention labels (Claude / OpenAI / heuristics) |
| `social_accounts.json` | Curated X account list |
| `social_data.js` | Last cached Feed bundle (large; regenerable) |
| `app_feed_excerpt.js` | Client Feed UI logic cut from `site/app.js` |

Live site still keeps shared helpers used by Home / Ownership / Markets:

- `feedPlayerPhotoUrl`
- `feedStatDisplay` / `feedRowStatValue`
- `localeTimeOptions` (Markets kickoff times)

Feed CSS remains in `site/styles.css` (unused) for an easier visual restore.

## Restore checklist

1. Copy scripts + accounts back under `site/`:

   ```bash
   cp archive/feed/fetch_social.py archive/feed/annotate_social.py archive/feed/social_accounts.json site/
   ```

2. Re-add Feed tab / toolbar / filters / `#feed-page` and `social_data.js` script tag in `site/index.html` (git history or this archive’s last live tree).

3. Merge `app_feed_excerpt.js` back into `site/app.js` and restore routing (`PAGES`, `setPage`, listeners). Diff against git history for the wiring around `page === "feed"`.

4. Put `X_BEARER_TOKEN` (and optional LLM keys) back in `.env` — see project-root `.env.example` history / comments below.

5. Refresh pipeline:

   ```bash
   python3 site/fetch_social.py && python3 site/annotate_social.py
   ```

   Then bump `social_data.js?v=` in `index.html`.

6. Re-add to `.cursor/rules/refresh-data.mdc` default **refresh data** (and the “refresh feed” subset phrase).

## Env keys (historical)

```
X_BEARER_TOKEN=
ANTHROPIC_API_KEY=   # optional annotate
OPENAI_API_KEY=      # optional annotate
# POSTS_PER_ACCOUNT=10
```
