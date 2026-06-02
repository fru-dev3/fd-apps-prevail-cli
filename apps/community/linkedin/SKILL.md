# LinkedIn connector

Scrapes LinkedIn activity (profile views, post performance, inbox) via a
logged-in Chrome session. No public API — Playwright reads the same pages
you'd see in a browser, then writes structured rows under `data/`.

## Auth

LinkedIn enforces a ~30-day session cookie on Chrome. Stay logged in, and
this connector works. Get logged out and you'll see the auth probe go red
until you visit linkedin.com in your browser again.

## Skills

- `scrape-profile-views` — daily count of who viewed your profile
- `scrape-post-engagement` — impressions / reactions / comments per post
- `scrape-inbox-unread` — unread message count
