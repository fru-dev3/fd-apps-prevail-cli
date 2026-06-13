---
id: sync-inbox-cli
runner: cli
trigger: refresh
command: gam
args:
  - "user"
  - "me"
  - "print"
  - "messages"
  - "query"
  - "is:important newer_than:7d"
  - "max_to_show"
  - "20"
  - "show_labels"
save: inbox-${date}.json
---
Pull recent important Gmail messages via GAM (Google Apps Manager CLI).
Requires GAM installed and authenticated: https://github.com/GAM-team/GAM
Auth setup: gam oauth create (select gmail.readonly scope).
GAM manages its own OAuth credentials (~/.gam/oauth2.txt). The engine
runs the command, captures stdout (CSV), and saves it to data/.
