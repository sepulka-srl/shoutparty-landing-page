# Shout Party — Landing Page

Marketing site for [Shout Party](https://play.google.com/store/apps/details?id=com.sepulka.shoutparty), hosted at [shoutparty.com](https://shoutparty.com) via GitHub Pages.

## Layout

- `shout-party-landing.bundle.html` — original bundle exported from Claude Design.
- `extract.mjs` — unpacks the bundle into `docs/` (static HTML + `assets/` + Play Store link rewrites + GitHub Pages config files).
- `docs/` — what GitHub Pages serves.

## Rebuild

```bash
node extract.mjs
```

Re-extracts assets, rewrites the three Google Play CTAs to the live listing, and refreshes `docs/CNAME` + `docs/.nojekyll`.

## Hosting

GitHub Pages is configured to serve from `main` → `/docs`. The `CNAME` file inside `docs/` points the site at `shoutparty.com`.
