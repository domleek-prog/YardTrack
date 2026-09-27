// ESPN proxy for YardTrack. Whitelisted routes only — never an open proxy.
//   ?route=teams
//   ?route=roster&team={id}
//   ?route=scoreboard[&dates=YYYYMMDD]
//   ?route=summary&event={id}
//   ?route=players   (all 32 rosters -> slim skill-position index)

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
const TIMEOUT_MS = 8000;

// Seconds for browser (max-age) and Netlify CDN (s-maxage).
const TTL = {
  players: 12 * 60 * 60,
  teams: 12 * 60 * 60,
  roster: 60 * 60,
  scoreboard: 30,
  summary: 15,
};

// Warm-instance memo for the expensive players index.
let playersMemo = null; // { t, body }

function respond(status, body, ttl) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };
  if (status === 200 && ttl) {
    headers['Cache-Control'] = `public, max-age=${ttl}`;
    headers['Netlify-CDN-Cache-Control'] = `public, s-maxage=${ttl}, stale-while-revalidate=${Math.min(ttl, 60)}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return { statusCode: status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function fail(status, message) {
  return respond(status, { error: message, status });
}

// ESPN's edge 403s Node's default "node" user agent and has been seen refusing Netlify's
// servers, so look like a browser and fall back to ESPN's second API host on a 403.
const HOSTS = ['https://site.api.espn.com', 'https://site.web.api.espn.com'];
const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Referer: 'https://www.espn.com/',
  Origin: 'https://www.espn.com',
};

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
    if (!res.ok) {
      const err = new Error(`ESPN responded ${res.status}`);
      err.upstream = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON(url) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      return await fetchOnce(url.replace('https://site.api.espn.com', host));
    } catch (err) {
      lastErr = err;
      if (err.upstream !== 403) throw err;
    }
  }
  throw lastErr;
}

async function buildPlayers() {
  const teamsData = await getJSON(`${BASE}/teams`);
  const teams = (teamsData?.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team).filter(Boolean);
  if (!teams.length) throw new Error('No teams returned');

  const results = await Promise.allSettled(teams.map((t) => getJSON(`${BASE}/teams/${t.id}/roster`)));
  const players = [];
  const seen = new Set();
  let failed = 0;

  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') { failed++; return; }
    const team = teams[i];
    const abbr = r.value?.team?.abbreviation || team.abbreviation;
    for (const group of r.value?.athletes || []) {
      for (const a of group.items || []) {
        const pos = a?.position?.abbreviation;
        if (!SKILL.has(pos) || seen.has(a.id)) continue;
        seen.add(a.id);
        players.push({
          id: String(a.id),
          name: a.displayName || a.fullName,
          position: pos,
          teamId: String(team.id),
          teamAbbr: abbr,
          headshot: a?.headshot?.href || null,
        });
      }
    }
  });

  players.sort((a, b) => a.name.localeCompare(b.name));
  return { players, failed };
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return fail(405, 'Method not allowed');

  const q = event.queryStringParameters || {};
  const route = q.route;

  try {
    switch (route) {
      case 'teams':
        return respond(200, await getJSON(`${BASE}/teams`), TTL.teams);

      case 'roster': {
        if (!/^\d{1,3}$/.test(q.team || '')) return fail(400, 'Missing or invalid "team"');
        return respond(200, await getJSON(`${BASE}/teams/${q.team}/roster`), TTL.roster);
      }

      case 'scoreboard': {
        let url = `${BASE}/scoreboard`;
        if (q.dates !== undefined) {
          if (!/^\d{8}$/.test(q.dates)) return fail(400, 'Invalid "dates" (YYYYMMDD)');
          url += `?dates=${q.dates}`;
        }
        return respond(200, await getJSON(url), TTL.scoreboard);
      }

      case 'summary': {
        if (!/^\d{6,12}$/.test(q.event || '')) return fail(400, 'Missing or invalid "event"');
        return respond(200, await getJSON(`${BASE}/summary?event=${q.event}`), TTL.summary);
      }

      case 'players': {
        if (playersMemo && Date.now() - playersMemo.t < TTL.players * 1000) {
          return respond(200, playersMemo.body, TTL.players);
        }
        const { players, failed } = await buildPlayers();
        if (!players.length) return fail(502, 'Could not build player index');
        const body = JSON.stringify(players);
        // A partial index (some rosters failed) is served but only cached briefly.
        if (failed) return respond(200, body, 300);
        playersMemo = { t: Date.now(), body };
        return respond(200, body, TTL.players);
      }

      default:
        return fail(400, 'Unknown route. Allowed: teams, roster, scoreboard, summary, players');
    }
  } catch (err) {
    if (err.name === 'AbortError') return fail(504, 'ESPN timed out');
    if (err.upstream === 404) return fail(404, 'Not found upstream');
    return fail(502, err.message || 'Upstream error');
  }
};
