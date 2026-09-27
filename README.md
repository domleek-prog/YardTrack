# YardTrack

Live NFL yardage vs your betting lines. Static `index.html` + one Netlify function that proxies ESPN's public API.

## Deploy

**Git (recommended)**
1. Push this folder to a GitHub/GitLab repo.
2. Netlify → Add new site → Import from Git → pick the repo. Leave build command empty; publish dir and functions dir come from `netlify.toml`.
3. Deploy. No environment variables needed.

**CLI**
```
npm i -g netlify-cli
netlify deploy --prod
```

**Drag and drop:** Netlify Drop is built for static files and may not deploy `netlify/functions`. If `/.netlify/functions/espn?route=scoreboard` returns 404 after a drop deploy, use Git or the CLI instead.

**Add to home screen:** open the site in Safari, tap Share, then Add to Home Screen.

## Check it's working
- `/.netlify/functions/espn?route=scoreboard` should return JSON.
- `/?debug=1&event=401872948` points the app at a finished game (ATL @ GB, Week 3 2026). Use the date picker to list other past games, and the `state` dropdown to force pre/live/final.

## Local dev
`netlify dev` serves the page and the function together.
