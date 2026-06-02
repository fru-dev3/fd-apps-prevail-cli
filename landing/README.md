# landing/ — prevail.ai static site

This folder is the source of the `prevail.ai` landing page. It is fully static — one HTML file, one stylesheet (inline), one icon, one shim for the install endpoint. No build step.

## Files

- `index.html` — the page itself. References `/icon.svg` (relative) so it works whether served from the root domain or a subpath. All CSS is inlined for fast first paint and zero round-trips.
- `install` — when `prevail.ai/install` is fetched and piped to bash, this file is what runs. It just `curl`s the maintained installer in `scripts/install.sh` from the repo and execs it.

## Deploy targets

Pick one — they're all free for this size of site.

### Vercel (recommended)

```
cd landing
vercel --prod
```

Set the custom domain `prevail.ai` in the Vercel dashboard. DNS:
- `prevail.ai` → A record to Vercel's IP (Vercel surfaces this when you add the domain)
- `www.prevail.ai` → CNAME to `cname.vercel-dns.com`

### Netlify

```
cd landing
netlify deploy --prod --dir=.
```

Same domain setup as Vercel; Netlify gives you the exact records.

### Cloudflare Pages

```
cd landing
wrangler pages deploy . --project-name prevail
```

Cloudflare DNS makes apex+www config easiest if you're already on Cloudflare.

## After deploy: verify

```
curl -I https://prevail.ai/
curl -fsSL https://prevail.ai/install | head -5    # should be the install.sh bash header
```

## Updating

Edit `index.html` and redeploy. The repo's GitHub Actions don't touch this folder — landing changes ship independently of the binary release cycle.
