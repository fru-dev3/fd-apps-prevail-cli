---
name: plaid
type: app
description: |
  Pull recent transactions, balances, and recurring-transaction metadata from
  any institution linked to a Plaid Item. Used by wealth, tax, and business
  domains. Read-only by default — write operations require explicit
  PLAID_WRITE_OK=1 in the environment.
---

# Plaid

**Auth:** API key (Plaid Sandbox or Production)
**Environment:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ACCESS_TOKEN` — store these in your shell rc or a `.envrc` file. The cockpit's chat will read them from the spawned subprocess env.
**URL:** https://plaid.com
**Domains using this app:** wealth, tax, business

## Data Available

| Data Type | Endpoint | Notes |
|-----------|----------|-------|
| Account list | `/accounts/get` | Bank accounts, credit cards, brokerage |
| Balance snapshot | `/accounts/balance/get` | Real-time available + current balances |
| Transactions | `/transactions/get` | 24+ months of history depending on institution |
| Recurring transactions | `/transactions/recurring/get` | Auto-detected subscriptions, salary, recurring bills |
| Investment holdings | `/investments/holdings/get` | Per-account positions with cost basis where available |
| Investment transactions | `/investments/transactions/get` | Buys, sells, dividends, transfers |
| Item status | `/item/get` | Last refresh, error state, products granted |

## When to invoke

- A domain's `state.md` is stale and the user asks for the current bank/brokerage balance
- Building a monthly wealth synthesis (cross-reference with manual state)
- Tax-time transaction export (filter by date + category)
- Reconciling QuickBooks with bank truth (business domain)

## Inputs

- None at chat time — env vars must be present at cockpit launch
- For transaction pulls: optional date range (defaults to last 30 days)
- For holdings: optional account filter

## Output

- A markdown table summarizing what was pulled (account, balance, last refresh)
- Raw JSON appended to `<domain>/00_current/plaid-<timestamp>.json` for reference
- Recommended state.md edits surfaced to the user for confirmation (never written without approval)

## Note

This is a **reference plugin** shipped with aireadyu to demonstrate the LifeApp
plugin contract. It is intentionally synthetic — the SKILL.md describes the
shape of a Plaid integration, but the cockpit ships no live HTTP code for it.
A real implementation would call the Plaid API from a script under
`<vault>/wealth/scripts/plaid-sync.ts` and update state.md from there.
