# tossiebuyshouses.com — 680-page SEO/AEO build

Static site generated from `data/*.json`. **Nothing is deployed and no accounts are
connected** — see [Deploy](#deploy) for the steps you run when you're ready.

```bash
node gen/build.mjs      # generate site/
node scripts/verify.mjs # audit: duplicates, broken links, schema, AI-copy tells
npx serve site          # or: python3 -m http.server 8787 --directory site
```

## What's here

| Page type | Count | URL pattern |
|---|---:|---|
| Home | 1 | `/` |
| State hubs | 6 | `/sell-my-house-fast/{state}/` |
| City pages | 167 | `/sell-my-house-fast/{state}/{city}/` |
| County hubs | 127 | `/counties/{state}/{county}/` |
| Situation hubs | 17 | `/situations/{situation}/` |
| **Situation × state** | **101** | `/situations/{situation}/{state}/` |
| Situation × city | 231 | `/sell-my-house-fast/{state}/{city}/{situation}/` |
| Guides | 20 | `/guides/{slug}/` |
| Core | 10 | `/how-it-works/`, `/cash-offer-vs-listing/`, `/about/`, `/faq/`, … |
| **Total** | **680** | ~777k words |

States: GA, SC, FL, AL, NC, TN. Tier-1 cities get situation pages; tier-3 towns
get a deliberately compact template (they can't carry 1,200 unique words honestly).

## The two rails

1. **No AI-written prose.** Pages are assembled from facts in `data/`. `scripts/verify.mjs`
   enforces a 37-phrase ban list and a concrete-number density floor.
2. **Nothing invented about the business.** Every claim traces to tossiebuyshouses.com
   (live, Aug 2026), the GA/SC license registry, or a cited statute in `data/states.json`.
   No fake reviews, no invented stats, no fabricated project photos.

## Editing content

Never hand-edit `site/` — it's regenerated and overwritten.

| Change | File |
|---|---|
| Phone, email, licenses, brand colors, claims | `data/business.json` |
| Add/remove a city (name, county, tier, anchor) | `data/cities.json` |
| State foreclosure / tax-sale / closing law | `data/states.json` |
| Situations and their FAQs | `data/situations.json` |
| Long-form guides | `data/guides.json` |
| Layout, schema, internal linking | `gen/build.mjs` |
| Design tokens and responsive rules | `gen/css.js` |

`tier` in `cities.json`: `1` = full template + 7 situation pages, `2` = full template,
`3` = compact template. Adding a tier-1 city adds 8 pages.

## AEO (answer-engine optimization)

Every page carries: a direct-answer block in the first 120 words (the block AI
engines quote), `RealEstateAgent`+`LocalBusiness` JSON-LD with the GA/SC license
numbers as `identifier`, `BreadcrumbList`, `Service`, and `FAQPage`. Plus
`/llms.txt` and a `robots.txt` that explicitly allows GPTBot, ClaudeBot,
PerplexityBot, OAI-SearchBot, Google-Extended and Applebot-Extended.

## Near-duplicate profile

Multi-state programmatic sites get filtered when pages are near-identical.
Measured overlap of unique 5-word phrases, main content only:

| Comparison | Overlap |
|---|---:|
| Guide vs guide | 11% |
| State hub vs state hub | 29% |
| Situation×state, different states | 30% |
| Same situation, same state, different city | 47% |
| City vs city, same state | 55% |
| County hub vs county hub | 59% |
| City vs city, same county | 60% |

Re-run with `node /tmp/sim2.mjs` after content changes. Anything above ~70% on
main content needs more real local data or a more compact template.

## Deploy

**Nothing below has been run.** Connect your own accounts first.

1. **Supabase** — create a dedicated project, then create the leads table:
   ```sql
   create table public.tossie_leads (
     id uuid primary key default gen_random_uuid(),
     created_at timestamptz not null default now(),
     address text not null, name text not null, phone text not null, email text not null,
     situation text, market text, page_path text, referrer text, user_agent text,
     status text not null default 'new', notes text
   );
   create index on public.tossie_leads (created_at desc);
   alter table public.tossie_leads enable row level security;
   revoke all on public.tossie_leads from anon, authenticated;
   ```
   RLS on with no policies + the service-role key server-side means the browser can
   never read leads.

2. **Vercel** — import the repo. `vercel.json` already sets the build command
   (`node gen/build.mjs`), output dir (`site`), clean URLs and security headers.
   Set env vars:
   | Var | Notes |
   |---|---|
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | service_role key — **server only** |
   | `SUPABASE_TABLE` | defaults to `tossie_leads` |
   | `RESEND_API_KEY` | optional; no key = no email attempted |
   | `ALERT_EMAIL_TO` / `ALERT_EMAIL_FROM` | new-lead alerts |
   | `SITE_ORIGIN` | `https://tossiebuyshouses.com` |
   | `NOINDEX` | set to `1` on preview deploys |

   With no env vars set the form still returns 200 and logs the lead, so the site
   works before the accounts exist.

3. **Before pointing DNS** — the current site is on a hosted builder. 301 these so
   the existing blog equity carries over:
   ```
   /sell-your-house-fast-in-brunswick-ga  → /sell-my-house-fast/georgia/brunswick/
   /sell-your-house-fast-in-kingsland-ga  → /sell-my-house-fast/georgia/kingsland/
   /sell-your-house-fast-in-statesboro-ga → /sell-my-house-fast/georgia/statesboro/
   /sell-your-house-fast-in-hinesville-ga → /sell-my-house-fast/georgia/hinesville/
   /frequently-asked-questions            → /faq/
   /about-us → /about/   /contact-us → /contact/
   /terms-of-service → /terms/   /privacy-policy → /privacy/
   ```
   The ~20 existing `/blog/*` posts have no equivalent here yet. Either keep them
   or map each to the closest city/situation page — don't let them 404.

4. **After DNS** — submit `sitemap.xml` in Search Console, and make the Google
   Business Profile NAP byte-identical to the footer (`Coastal GA Property
   Solutions, LLC` dba `Tossie Buys Houses`, `(912) 380-3039`).

## Images

`assets/img/tossie-logo.png` is the real logo pulled from the live site.
The seven `hero-*.jpg` files are generated regional scenery (Higgsfield,
`gpt_image_2`) — streetscapes and landscape only. **No generated image depicts
a crew, a branded truck, a customer, or a completed project**, because a visitor
would reasonably read those as "our work." Swap in real project photos when
Tossie sends them.

## Known gaps

- No testimonials or reviews anywhere. The live site has two; they're unattributed
  and unverified, so they were left out. Get real, attributed reviews — this is the
  single biggest conversion item missing.
- No video. Carrot's own analysis of top-ranking sites puts video on every one of them.
- Legal summaries in `data/states.json` were verified Aug 2026 against the sources
  cited on each page. Re-check annually; statutes change.
