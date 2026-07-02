---
id: sync-inbox-browser
runner: browser-agent
trigger: refresh
favorite: true
method: browser
capability: sync-inbox
session: profile
start_url: https://mail.google.com/mail/u/0/#search/is%3Aimportant+newer_than%3A7d
domain_allow: [mail.google.com, accounts.google.com]
success_url_contains: mail.google.com/mail
goal: Open Gmail in the logged-in session, show important mail from the last 7 days, and capture sender, subject, date, and a one-line gist for each. Read-only: never send, archive, delete, or label anything.
outputs:
  - { path: data/inbox-${date}.md, kind: markdown }
---
# Sync inbox (browser, favorite)

Pull recent important Gmail using the user's already-logged-in browser session.
This is the favorite because it needs zero credential setup: it rides the
existing Google sign-in. If the browser is unavailable or hits a login wall, the
pack falls through to the API method (sync-inbox) and then the MCP/CLI variants.

Read-only by contract. Steps:

1. **Open important mail.** Land on the search for important, recent mail.
2. **Read the list.** For each thread capture sender, subject, date, and a
   one-line gist from the snippet.
3. **Write the digest.** Save a dated markdown digest to data/. Never send,
   reply, archive, delete, star, or relabel.
