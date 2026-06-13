---
id: recent-transactions-cli
runner: cli
trigger: refresh
command: "${env.PLAID_CLI_COMMAND}"
save: transactions-${date}.json
---
Pull recent transactions via a custom CLI wrapper. Set PLAID_CLI_COMMAND to a
binary that outputs transaction JSONL to stdout. Each line should be:
{"date":"YYYY-MM-DD","amount":42.18,"name":"Merchant","category":["Food"]}.
The engine saves stdout to data/ and routes a summary intent to the wealth domain.
