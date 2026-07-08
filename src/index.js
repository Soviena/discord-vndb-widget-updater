const VNDB_API = 'https://api.vndb.org/kana';

const LABEL_PLAYING = 1;
const LABEL_FINISHED = 2;
const LABEL_WISHLIST = 5;

// The "current" entry is always sourced from the Playing label (see fetchVndbData).
const CURRENT_STATUS_TEXT = 'Playing';

// Rough hour estimate per vn.length category (1=very short .. 5=very long),
// used only when a VN has no community length_minutes data yet.
const LENGTH_CATEGORY_HOURS = { 1: 1, 2: 6, 3: 20, 4: 40, 5: 60 };

const MAX_PAGES = 50; // safety cap: 50 * 100 results = 5000 entries

// VNDB flags each cover image 0 (safe) - 2 (explicit) for sexual/violence content.
// Anything at or above this is withheld from the public Discord widget.
const SFW_THRESHOLD = 0.3;

async function assertVndbOk(response, label) {
  if (response.ok) return;
  const body = await response.text();
  console.error(`[vndb] ${label} error body: ${body.slice(0, 500)}`);
  throw new Error(`VNDB ${label} responded with ${response.status}`);
}

async function vndbGetUser(username) {
  const url = `${VNDB_API}/user?q=${encodeURIComponent(username)}&fields=lengthvotes_sum`;
  console.log(`[vndb] fetching user: ${username}`);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  console.log(`[vndb] user response status: ${response.status}`);
  await assertVndbOk(response, '/user');

  const json = await response.json();
  const entry = json[username];
  if (!entry) throw new Error(`VNDB user not found: ${username}`);
  return entry;
}

async function vndbUlistPage(username, filters, fields, sort, reverse, page, results) {
  const response = await fetch(`${VNDB_API}/ulist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      user: username,
      filters,
      fields,
      sort,
      reverse,
      page,
      results,
    }),
  });

  await assertVndbOk(response, '/ulist');
  return response.json();
}

async function vndbFetchAllUlist(username, filters, fields) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const { results, more } = await vndbUlistPage(username, filters, fields, null, false, page, 100);
    all.push(...results);
    if (!more) break;
    page += 1;
  }
  return all;
}

async function fetchVndbData(username) {
  console.log(`[vndb] fetching data for user: ${username}`);

  const [user, playingPage, finishedEntries, wishlistEntries] = await Promise.all([
    vndbGetUser(username),
    vndbUlistPage(
      username,
      ['label', '=', LABEL_PLAYING],
      'id,vote,added,releases.vns.rtype,vn.title,vn.alttitle,vn.image.url,vn.image.sexual,vn.image.violence,vn.length,vn.length_minutes',
      'added',
      true,
      1,
      1
    ),
    vndbFetchAllUlist(username, ['label', '=', LABEL_FINISHED], 'vote,voted,lastmod'),
    vndbFetchAllUlist(username, ['label', '=', LABEL_WISHLIST], 'id'),
  ]);

  console.log(
    `[vndb] data fetched: playing=${playingPage.results.length} finished=${finishedEntries.length} wishlist=${wishlistEntries.length}`
  );

  return {
    user,
    currentEntry: playingPage.results[0] ?? null,
    finishedEntries,
    wishlistCount: wishlistEntries.length,
  };
}

function hoursForVn(vn) {
  if (!vn) return 0;
  if (vn.length_minutes != null) return Math.round(vn.length_minutes / 60);
  if (vn.length != null) return LENGTH_CATEGORY_HOURS[vn.length] ?? 0;
  return 0;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function isSfwImage(image) {
  if (!image) return false;
  return (image.sexual ?? 0) < SFW_THRESHOLD && (image.violence ?? 0) < SFW_THRESHOLD;
}

function buildInfoText(entry) {
  // rtype ("trial"/"partial"/"complete") describes how a release covers this
  // specific VN — releases can bundle multiple VNs, so match by entry.id.
  const rtype = entry.releases
    ?.flatMap(r => r.vns ?? [])
    .find(v => v.id === entry.id)?.rtype;

  return rtype ? `${CURRENT_STATUS_TEXT}, ${capitalize(rtype)}` : CURRENT_STATUS_TEXT;
}

function processData(data) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const lastYear = currentYear - 1;

  const { user, currentEntry, finishedEntries, wishlistCount } = data;

  const totalPerfectScore = finishedEntries.filter(e => e.vote === 100).length;

  const yearOf = e => {
    const ts = e.voted ?? e.lastmod;
    return ts ? new Date(ts * 1000).getFullYear() : null;
  };
  const thisYearTotal = finishedEntries.filter(e => yearOf(e) === currentYear).length;
  const lastYearTotal = finishedEntries.filter(e => yearOf(e) === lastYear).length;

  const totalPlaytime = Math.floor((user.lengthvotes_sum ?? 0) / 60);

  console.log(
    `[process] finished=${finishedEntries.length} perfect=${totalPerfectScore} wishlist=${wishlistCount} this_year=${thisYearTotal} last_year=${lastYearTotal} total_playtime=${totalPlaytime}h`
  );

  const image = currentEntry?.vn?.image;
  const sfw = isSfwImage(image);

  if (currentEntry) {
    console.log(
      `[process] current vn: "${currentEntry.vn?.title}" vote=${currentEntry.vote} image_sfw=${sfw} sexual=${image?.sexual} violence=${image?.violence}`
    );
  } else {
    console.log('[process] no currently-playing entry found');
  }

  return {
    currentVnName: currentEntry?.vn?.title || currentEntry?.vn?.alttitle || 'N/A',
    currentInfoText: currentEntry ? buildInfoText(currentEntry) : 'N/A',
    currentPlaytimeHours: hoursForVn(currentEntry?.vn),
    currentScore: currentEntry?.vote ?? 0,
    thumbnail: sfw ? image?.url ?? '' : '',
    totalCompletedVn: finishedEntries.length,
    totalPlaytime,
    totalWishlist: wishlistCount,
    totalPerfectScore,
    thisYearTotal,
    lastYearTotal,
  };
}

function buildPayload(stats) {
  const dynamic = [];

  // Withheld entirely (not just blanked) when the cover image fails the SFW check
  if (stats.thumbnail) {
    dynamic.push({ type: 3, name: 'last_anime_pic', value: { url: stats.thumbnail } });
  }

  dynamic.push(
    { type: 1, name: 'current_vn_name', value: stats.currentVnName },
    { type: 1, name: 'current_info_text', value: stats.currentInfoText },
    { type: 1, name: 'playtime', value: `${stats.currentPlaytimeHours} Hour` },
    { type: 2, name: 'score', value: stats.currentScore },
    { type: 2, name: 'total_completed_vn', value: stats.totalCompletedVn },
    { type: 2, name: 'total_playtime', value: stats.totalPlaytime },
    { type: 2, name: 'total_wishlist', value: stats.totalWishlist },
    { type: 2, name: 'total_perfect_score', value: stats.totalPerfectScore },
    { type: 2, name: 'this_year_total', value: stats.thisYearTotal },
    { type: 2, name: 'last_year_total', value: stats.lastYearTotal }
  );

  return { data: { dynamic } };
}

async function postToDiscord(payload, endpoint, token) {
  console.log('[discord] sending PATCH:', JSON.stringify(payload));
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'Accept': '*/*',
      'Accept-Encoding': 'deflate, gzip',
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)',
    },
    body: JSON.stringify(payload),
  });

  console.log(`[discord] response status: ${response.status}`);

  if (!response.ok) {
    const body = await response.text();
    console.error(`[discord] error body: ${body}`);
    throw new Error(`Discord API ${response.status}: ${body}`);
  }

  // 204 No Content is a valid success response — no body to parse
  if (response.status === 204) {
    console.log('[discord] widget updated successfully (204 No Content)');
    return null;
  }

  const result = await response.json();
  console.log('[discord] response body:', JSON.stringify(result));
  return result;
}

async function run(env) {
  console.log('[run] starting update');
  const data = await fetchVndbData(env.VNDB_USERNAME);
  const stats = processData(data);
  const payload = buildPayload(stats);
  const result = await postToDiscord(payload, env.DISCORD_ENDPOINT, env.BOT_TOKEN);
  console.log('[run] update complete');
  return { stats, result };
}

export default {
  async scheduled(event, env, ctx) {
    console.log(`[scheduled] cron fired: ${event.cron}`);
    try {
      await run(env);
      console.log('[scheduled] done');
    } catch (err) {
      console.error(`[scheduled] failed: ${err.message}`);
    }
  },

  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const secret = request.headers.get('X-Trigger-Secret');
    if (!secret || secret !== env.TRIGGER_SECRET) {
      console.warn('[fetch] unauthorized trigger attempt');
      return new Response('Unauthorized', { status: 401 });
    }
    console.log('[fetch] manual trigger authorized');
    try {
      const { stats } = await run(env);
      return new Response(JSON.stringify({ success: true, stats }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error(`[fetch] failed: ${err.message}`);
      return new Response(JSON.stringify({ success: false, error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
