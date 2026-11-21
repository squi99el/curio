# Curio

A browser homepage that pulls headlines for your interests from RSS feeds and Google News searches.
No framework, no server: a Node script collects the feeds into `site/data/news.json`, and `site/index.html` displays it.

## Put it online (one-off, about 5 minutes)

1. Create a new GitHub repository and push this folder to it (branch `main`).
2. In the repo go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Go to the **Actions** tab, open **Update homepage**, and click **Run workflow**.
4. When it finishes, your page is at `https://<your-username>.github.io/<repo-name>/`.
5. Set that URL as your browser homepage (Chrome/Edge: Settings → On startup / Home button; Safari: Settings → General → Homepage).

It then rebuilds itself every 3 hours. Note that a GitHub Pages site is public, so anyone with the link can see it.

## Host it on Netlify instead

1. Push the folder to a GitHub repo, then in Netlify choose **Add new site → Import an existing project** and pick the repo. `netlify.toml` already holds the settings (build `npm ci && npm run build`, publish `site`).
2. To keep it fresh, create a **Build hook** (Site configuration → Build & deploy → Build hooks) and call its URL every few hours, for example with a scheduled GitHub Action: `curl -X POST <hook-url>`. Netlify then re-fetches the feeds and rebuilds.
3. You can delete `.github/workflows/update.yml` if you only use Netlify.

## Run it locally

```
npm install
npm run build     # downloads the latest headlines and saves small copies of the images
npm run serve     # then open http://localhost:8080
npm test
```

## Change what it shows

Everything is in `feeds.json`. Each topic has:

- `title`, `blurb`: what appears on the page
- `maxAgeDays`: how old a story can be before it's dropped
- `feeds`: a list of `{ name, url }`. Optional `include` / `exclude` are regular expressions matched against the headline and summary, which is how a broad feed (like Atlas Obscura) is narrowed to one topic.

Topics appear in the order listed. To add a Google News search, use
`https://news.google.com/rss/search?q=YOUR+QUERY&hl=en-GB&gl=GB&ceid=GB:en`.

## The page

- **Photo of the day** (top): the most recent landscape or travel picture from Wikimedia Commons' Picture of the Day feed, with the photographer's credit and licence. If none suits, it uses the best image from your Travel photography stories.
- **All** tab: a mixed grid with one story from each topic in turn, so subjects don't clump. Pick a topic tab to filter. Press `/` to search.
- **Cards**: stories with an image show the headline over the photo; stories without one become typographic cards in the topic's colour (set `color` per topic in `feeds.json`).

## Restyling

All colours, fonts, spacing and radii are CSS variables at the top of `site/index.html`. Fonts (Playfair Display, Newsreader, Inter) are bundled in `site/fonts` under their open licences, so nothing is loaded from third parties.

## When a feed breaks

Some sites block automated requests or change their feed address. The run log in the Actions tab shows a warning for each feed that failed (and a topic with no stories). The build only fails if *nothing* could be fetched, in which case the previous version of the page stays up.
