---
id: sync-inbox
runner: api
trigger: refresh
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
url: https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=is%3Aimportant%20newer_than%3A7d
method: GET
headers:
  - "Authorization: Bearer ${auth.token}"
  - "Accept: application/json"
save: data/inbox-${date}.json
summary_path: resultSizeEstimate
---
Pull recent important Gmail message references into the email domain. The raw
Gmail API response is saved to data/; the summary is the result-size estimate.
Requires a one-time `prevail connectors oauth gmail`; the http runner refreshes
the access token from the saved refresh token via ${auth.token}.
