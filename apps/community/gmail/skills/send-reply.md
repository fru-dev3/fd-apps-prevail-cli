---
id: send-reply
runner: api
trigger: on-demand
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
url: https://gmail.googleapis.com/gmail/v1/users/me/drafts
method: POST
headers:
  - "Authorization: Bearer ${auth.token}"
  - "Content-Type: application/json"
body: '{"message":{"raw":"${input.raw}"}}'
save: sent-${date}.json
---
Create a Gmail DRAFT from a base64url-encoded RFC822 message (${input.raw}).
Read-and-draft only by default; sending a draft is a separate, explicit action.
Requires the gmail.compose scope (add it to the connector's oauth block + re-auth).
