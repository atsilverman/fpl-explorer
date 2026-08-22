/* Archived Feed page client logic (removed from site/app.js).
   Kept live (shared with Home/Markets):
   - feedPlayerPhotoUrl
   - detectLocaleClockFormat / clockFormat / localeTimeOptions
   - feedStatDisplay
   - feedRowStatValue
*/

  // Feed page — player-mention cards from annotated social_data.js
  // ---------------------------------------------------------------------
  const FEED_HISTORY_DAYS = 7;

  const INDEXABLE_FEED_BASES = new Set([
    "unique_full_alias",
    "unique_lastname",
    "team_context",
    "team_position_context",
    "team_alias",
    "popularity_default",
  ]);

  let feedPlayerByCodeCache = null;

  function feedPlayerCatalog() {
    if (feedPlayerByCodeCache) return feedPlayerByCodeCache;
    const map = new Map();
    const combined = (DATA.players && DATA.players.combined) || [];
    for (const row of combined) {
      if (row && row.code != null) map.set(Number(row.code), { ...row });
    }
    for (const row of nextSeasonSplitLists(DATA.nextSeasonPlayers).combined) {
      if (!row || row.code == null) continue;
      const key = Number(row.code);
      const prev = map.get(key);
      if (prev) {
        // Prefer 2025/26 stats; overlay current squad identity when present.
        if (row.team) prev.team = row.team;
        if (row.position) prev.position = row.position;
        if (row.price != null) prev.price = row.price;
        if (row.name) prev.name = row.name;
      } else {
        map.set(key, { ...row });
      }
    }
    feedPlayerByCodeCache = map;
    return map;
  }

  function feedLookupPlayer(code) {
    if (code == null) return null;
    return feedPlayerCatalog().get(Number(code)) || null;
  }

  function localDayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const FEED_POST_TYPES = [
    { key: "original", label: "Original" },
    { key: "reply", label: "Reply" },
    { key: "quote", label: "Quote" },
    { key: "retweet", label: "Retweet" },
  ];

  const FEED_RANGE_LABELS = {
    today: "Today",
    "3d": "the last 3 days",
    "7d": "the past week",
  };

  function feedTypeFilterIsDefault() {
    return state.feedTypeFilter.size === 0;
  }

  function feedRangeDayCount(range = state.feedRange) {
    if (range === "3d") return 3;
    if (range === "7d") return FEED_HISTORY_DAYS;
    return 1;
  }

  function feedRangeDayKeys(range = state.feedRange, now = new Date()) {
    const n = feedRangeDayCount(range);
    const keys = [];
    for (let offset = 0; offset < n; offset++) {
      keys.push(
        localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset))
      );
    }
    return keys;
  }

  function feedPostKind(post) {
    const refs = post && post.referencedTweets;
    const types = new Set(
      (Array.isArray(refs) ? refs : [])
        .map((r) => (r && r.type) || "")
        .filter(Boolean)
    );
    if (types.has("retweeted")) return "retweet";
    if (types.has("quoted")) return "quote";
    if (types.has("replied_to") || (post && post.inReplyToUserId)) return "reply";
    return "original";
  }

  function feedFiltersActive() {
    return (
      state.feedRange !== "today" ||
      !feedTypeFilterIsDefault() ||
      state.feedTeamFilter.size > 0
    );
  }

  function syncFeedFiltersToggle() {
    if (!el.feedFiltersToggle) return;
    const active = feedFiltersActive();
    const panelOpen =
      el.feedControls &&
      !el.feedControls.classList.contains("collapsed") &&
      el.feedControls.style.display !== "none";
    const open = panelOpen || (mobileSheetOpen && mobileSheetKey === "feed-filters");
    el.feedFiltersToggle.classList.toggle("on", open || active);
    const label = open ? "Hide feed filters" : "Show feed filters";
    el.feedFiltersToggle.title = active && !open ? "Feed filters (active)" : label;
    el.feedFiltersToggle.setAttribute(
      "aria-label",
      active && !open ? "Show feed filters (filters active)" : label
    );
    el.feedFiltersToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function setFeedFiltersOpen(open) {
    if (!el.feedControls || !el.feedFiltersToggle) return;
    if (!hasFineHover()) {
      if (open) {
        openMobileSheetHost({
          title: "Feed filters",
          key: "feed-filters",
          hostEl: el.feedControls,
          prepare(host) {
            host.style.display = "";
            host.hidden = false;
            host.classList.remove("collapsed");
            buildFeedTypeChips();
            buildFeedTeamChips();
            syncFeedRangeSeg();
          },
          cleanup(host) {
            host.classList.add("collapsed");
            host.style.display = state.page === "feed" ? "" : "none";
          },
        });
        syncFeedFiltersToggle();
      } else if (mobileSheetKey === "feed-filters") {
        closeMobileSheet();
      } else {
        el.feedControls.classList.add("collapsed");
        syncFeedFiltersToggle();
      }
      return;
    }
    el.feedControls.style.display = "";
    el.feedControls.hidden = false;
    el.feedControls.classList.toggle("collapsed", !open);
    if (open) {
      buildFeedTypeChips();
      buildFeedTeamChips();
      syncFeedRangeSeg();
      requestAnimationFrame(() => syncSegThumb(el.feedRangeSeg, { animate: false }));
    }
    syncFeedFiltersToggle();
  }

  function syncFeedRangeSeg() {
    if (!el.feedRangeSeg) return;
    $$("#feed-range-seg button[data-feed-range]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.feedRange === state.feedRange);
    });
    syncSegThumb(el.feedRangeSeg, { animate: false });
  }

  function buildFeedTypeChips() {
    const root = el.feedTypeFilters;
    if (!root) return;
    root.innerHTML = "";
    for (const spec of FEED_POST_TYPES) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (state.feedTypeFilter.has(spec.key) ? " active" : "");
      chip.dataset.feedType = spec.key;
      chip.textContent = spec.label;
      chip.addEventListener("click", () => {
        toggleSetValue(state.feedTypeFilter, spec.key);
        chip.classList.toggle("active", state.feedTypeFilter.has(spec.key));
        syncFeedFiltersToggle();
        renderFeed();
      });
      root.appendChild(chip);
    }
  }

  function buildFeedTeamChips() {
    const root = el.feedTeamFilters;
    if (!root) return;
    root.innerHTML = "";
    teamCodesForSeason().forEach((code) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className =
        "chip team-chip" + (state.feedTeamFilter.has(code) ? " active" : "");
      chip.dataset.feedTeam = code;
      chip.innerHTML = `${badgeHTML(code)}${escapeHtml(code)}`;
      setTip(chip, teamNameForSeason(code));
      chip.addEventListener("click", () => {
        toggleSetValue(state.feedTeamFilter, code);
        chip.classList.toggle("active", state.feedTeamFilter.has(code));
        syncFeedFiltersToggle();
        renderFeed();
      });
      root.appendChild(chip);
    });
  }

  function formatFeedTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
    const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /** 0 = just now, 1 = FEED_HISTORY_DAYS (or older). Drives feed-time color mix. */
  function feedTimeAgeProgress(iso) {
    if (!iso) return 1;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 1;
    const ageMs = Math.max(0, Date.now() - d.getTime());
    const maxMs = FEED_HISTORY_DAYS * 86400 * 1000;
    return Math.min(1, ageMs / maxMs);
  }

  function formatFeedAbsolute(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      ...localeTimeOptions(),
    });
  }

  function feedPosStatSpecs(position, { detail = false } = {}) {
    const pos = String(position || "").toUpperCase();
    const fplSeason = isNextSeason();
    const compact = {
      GK: [
        { key: "saves", label: "Saves", decimals: 0 },
        { key: "cleanSheets", label: "CS", decimals: 0 },
        { key: "goalsConceded", label: "GC", decimals: 0 },
      ],
      DEF: [
        { key: "cleanSheets", label: "CS", decimals: 0 },
        { key: "goalsConceded", label: "GC", decimals: 0 },
        { key: "defCon", label: "DC", decimals: 0 },
        { key: "__gi", label: "G+A", decimals: 0 },
      ],
      MID: [
        { key: "goals", label: "G", decimals: 0 },
        { key: "assists", label: "A", decimals: 0 },
        { key: "xgi", label: "xGI", decimals: 1 },
        { key: "defCon", label: "DC", decimals: 0 },
      ],
      FWD: [
        { key: "goals", label: "G", decimals: 0 },
        { key: "assists", label: "A", decimals: 0 },
        { key: "xg", label: "xG", decimals: 1 },
        { key: "xa", label: "xA", decimals: 1 },
      ],
    };
    const expanded = {
      GK: [
        ...compact.GK,
        { key: "xgc", label: "xGC", decimals: 1 },
        { key: "mins", label: "Mins", decimals: 0 },
        { key: "pts", label: "Pts", decimals: 0 },
        { key: "xPts", label: "xPts", decimals: 1 },
        { key: "owned", label: "TSB%", decimals: 1 },
      ],
      DEF: [
        ...compact.DEF,
        { key: "xgc", label: "xGC", decimals: 1 },
        { key: "xgi", label: "xGI", decimals: 1 },
        { key: "mins", label: "Mins", decimals: 0 },
        { key: "pts", label: "Pts", decimals: 0 },
        { key: "xPts", label: "xPts", decimals: 1 },
        { key: "owned", label: "TSB%", decimals: 1 },
      ],
      MID: [
        { key: "goals", label: "G", decimals: 0 },
        { key: "assists", label: "A", decimals: 0 },
        { key: "xgi", label: "xGI", decimals: 1 },
        { key: "xg", label: "xG", decimals: 1 },
        { key: "xa", label: "xA", decimals: 1 },
        { key: "defCon", label: "DC", decimals: 0 },
        { key: "keyPasses", label: "KP", decimals: 0 },
        { key: "mins", label: "Mins", decimals: 0 },
        { key: "pts", label: "Pts", decimals: 0 },
        { key: "xPts", label: "xPts", decimals: 1 },
        { key: "owned", label: "TSB%", decimals: 1 },
      ],
      FWD: [
        ...compact.FWD,
        { key: "xgi", label: "xGI", decimals: 1 },
        { key: "shots", label: "S", decimals: 0 },
        { key: "mins", label: "Mins", decimals: 0 },
        { key: "pts", label: "Pts", decimals: 0 },
        { key: "xPts", label: "xPts", decimals: 1 },
        { key: "owned", label: "TSB%", decimals: 1 },
      ],
    };
    let list = detail ? expanded[pos] || expanded.FWD : compact[pos] || compact.FWD;
    if (fplSeason) {
      list = list.filter((s) => !PLAYER_OPTA_ONLY_COL_KEYS.has(s.key));
    }
    return detail ? list : list.slice(0, 4);
  }

  function feedPlayerStatsHTML(card, { detail = false } = {}) {
    const rankMaps = feedStatRankMaps(card.position, { detail });
    const posLabel = String(card.position || "").toUpperCase();
    return feedPosStatSpecs(card.position, { detail })
      .map((spec) => {
        const raw = feedRowStatValue(card.row, spec.key);
        const shown = feedStatDisplay(raw, spec.decimals);
        const rankInfo = rankMaps[spec.key];
        const rank =
          card.code != null && rankInfo ? rankInfo.ranks.get(String(card.code)) : null;
        const rankHtml =
          rank != null
            ? `<span class="feed-player-stat-rank" title="Rank among ${escapeHtml(posLabel)}s (${rank} of ${rankInfo.n})">#${rank}</span>`
            : "";
        return `<div class="feed-player-stat">
          <span class="feed-player-stat-label">${escapeHtml(spec.label)}</span>
          <span class="feed-player-stat-value">${escapeHtml(shown)}</span>
          ${rankHtml}
        </div>`;
      })
      .join("");
  }

  function feedStatRankMaps(position, { detail = false } = {}) {
    const pos = String(position || "").toUpperCase();
    if (!pos) return {};
    const cacheKey = `${pos}:${detail ? "detail" : "compact"}`;
    if (!feedStatRankCache) feedStatRankCache = new Map();
    if (feedStatRankCache.has(cacheKey)) return feedStatRankCache.get(cacheKey);

    const pool = ((DATA.players && DATA.players.combined) || []).filter(
      (r) => String(r.position || "").toUpperCase() === pos
    );
    const maps = {};
    for (const spec of feedPosStatSpecs(pos, { detail })) {
      const lowerBetter = LOWER_BETTER.has(spec.key);
      const entries = pool
        .map((r) => {
          if (r.code == null) return null;
          const val = feedRowStatValue(r, spec.key);
          if (val == null || Number.isNaN(Number(val))) return null;
          return { key: String(r.code), val: Number(val) };
        })
        .filter(Boolean)
        .sort((a, b) => (lowerBetter ? a.val - b.val : b.val - a.val));
      const ranks = new Map();
      let i = 0;
      while (i < entries.length) {
        let j = i + 1;
        while (j < entries.length && entries[j].val === entries[i].val) j += 1;
        for (let k = i; k < j; k += 1) ranks.set(entries[k].key, i + 1);
        i = j;
      }
      maps[spec.key] = { ranks, n: entries.length };
    }
    feedStatRankCache.set(cacheKey, maps);
    return maps;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function linkifyFeedText(text) {
    const raw = String(text || "");
    let html = escapeHtml(raw);
    html = html.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const href = escapeHtml(url);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
    });
    html = html.replace(
      /(^|[\s(])@([A-Za-z0-9_]{1,15})\b/g,
      (_, pre, handle) =>
        `${pre}<a href="https://x.com/${escapeHtml(handle)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(handle)}</a>`
    );
    return html;
  }

  function feedPlayerMentionAliases(card, post) {
    const aliases = new Set();
    const add = (value) => {
      const s = String(value || "").trim();
      if (s.length >= 2) aliases.add(s);
    };
    add(card && card.name);
    const code = card && card.code != null ? String(card.code) : "";
    const entities = (post && post.analysis && post.analysis.entities) || [];
    for (const e of entities) {
      if (!e || e.type !== "player" || !e.resolved) continue;
      if (code && String(e.code) !== code) continue;
      add(e.mention);
      add(e.name);
    }
    return [...aliases].sort((a, b) => b.length - a.length);
  }

  function highlightFeedPlayerMentions(escapedHtml, aliases) {
    if (!escapedHtml || !aliases || !aliases.length) return escapedHtml;
    const unique = [];
    const seen = new Set();
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(alias);
    }
    if (!unique.length) return escapedHtml;
    const pattern = unique.map(escapeRegExp).join("|");
    // Avoid matching inside words (Haaland in FooHaaland) while allowing hyphens.
    const re = new RegExp(`(?<![A-Za-z0-9_])(?:${pattern})(?![A-Za-z0-9_])`, "gi");
    return escapedHtml.replace(
      re,
      (match) => `<mark class="feed-player-mention">${match}</mark>`
    );
  }

  function formatFeedPostBody(text, card, post) {
    let html = escapeHtml(String(text || ""));
    html = highlightFeedPlayerMentions(html, feedPlayerMentionAliases(card, post));
    html = html.replace(/https?:\/\/[^\s<]+/g, (url) => {
      // Skip URLs that were already wrapped or sit inside a mark/tag.
      if (url.includes("<")) return url;
      const href = escapeHtml(url);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
    });
    // Don't rewrite @handles that landed inside a highlight mark.
    html = html.replace(
      /(^|[\s(])@([A-Za-z0-9_]{1,15})\b/g,
      (full, pre, handle, offset, str) => {
        const before = str.slice(Math.max(0, offset - 24), offset);
        if (/<mark\b[^>]*>[^<]*$/i.test(before)) return full;
        return `${pre}<a href="https://x.com/${escapeHtml(handle)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(handle)}</a>`;
      }
    );
    return html;
  }

  function feedPostsFiltered(posts, { range = state.feedRange } = {}) {
    const keys = new Set(feedRangeDayKeys(range));
    return (posts || []).filter((post) => {
      if (!post.createdAt) return false;
      const created = new Date(post.createdAt);
      if (Number.isNaN(created.getTime())) return false;
      if (!keys.has(localDayKey(created))) return false;
      if (state.feedTypeFilter.size && !state.feedTypeFilter.has(feedPostKind(post))) {
        return false;
      }
      return true;
    });
  }

  function computeFeedMentionCards(posts, { range = state.feedRange } = {}) {
    const scopedPosts = feedPostsFiltered(posts, { range });
    const byCode = new Map();

    for (const post of scopedPosts) {
      const analysis = post.analysis || {};
      // One credit per player per post — repeat name/entity hits must not inflate.
      const seenCodes = new Set();
      for (const e of analysis.entities || []) {
        if (!e || e.type !== "player" || !e.resolved || e.code == null) continue;
        const basis = e.matchBasis || "";
        if (basis && !INDEXABLE_FEED_BASES.has(basis)) continue;
        const key = String(e.code);
        if (seenCodes.has(key)) continue;
        seenCodes.add(key);

        let bucket = byCode.get(key);
        if (!bucket) {
          bucket = {
            code: e.code,
            name: e.name || e.mention,
            team: e.team,
            position: e.position,
            postIds: new Set(),
            latestAt: "",
          };
          byCode.set(key, bucket);
        }
        bucket.name = e.name || bucket.name;
        bucket.team = e.team || bucket.team;
        bucket.position = e.position || bucket.position;
        bucket.postIds.add(String(post.id));
        if (String(post.createdAt || "") > bucket.latestAt) {
          bucket.latestAt = post.createdAt || "";
        }
      }
    }

    const cards = [...byCode.values()]
      .map((bucket) => {
        const row = feedLookupPlayer(bucket.code);
        const name = (row && row.name) || bucket.name;
        const team = (row && (row.newTeam || row.team)) || bucket.team || "";
        const position =
          (row && (row.newPosition || row.position)) || bucket.position || "";
        const price =
          row && row.price2627 != null
            ? row.price2627
            : row && row.price != null
              ? row.price
              : null;
        const pts = row && row.pts != null ? row.pts : null;
        return {
          code: bucket.code,
          name,
          team,
          position,
          price,
          pts,
          row,
          posts: bucket.postIds.size,
          postIds: [...bucket.postIds],
          latestAt: bucket.latestAt,
        };
      })
      .sort((a, b) => sortFeedCards(a, b));

    return {
      range,
      scopedPostCount: scopedPosts.length,
      cards,
    };
  }

  function sortFeedCards(a, b) {
    const byRecent = () =>
      String(b.latestAt || "").localeCompare(String(a.latestAt || ""));
    const byVolume = () => b.posts - a.posts;
    const byName = () => String(a.name || "").localeCompare(String(b.name || ""));
    // Volume desc: most mentions, then most recent, then name.
    return byVolume() || byRecent() || byName();
  }

  function feedPostKindLabel(kind) {
    const hit = FEED_POST_TYPES.find((t) => t.key === kind);
    return (hit && hit.label) || "Original";
  }

  function feedQuoteRowsHTML(postIds, postsById, card) {
    const rows = (postIds || [])
      .map((id) => postsById.get(String(id)))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!rows.length) {
      return `<p class="feed-trend-empty">No linked posts in the current window.</p>`;
    }
    return rows
      .map((post, i) => {
        const handle = post.handle || "";
        const name = post.authorName || handle;
        const url = post.url || `https://x.com/${handle}/status/${post.id}`;
        const body = formatFeedPostBody(post.text || "", card, post);
        const kind = feedPostKind(post);
        const kindLabel = feedPostKindLabel(kind);
        const avatar = post.authorAvatarUrl
          ? `<img class="feed-source-avatar" src="${escapeHtml(post.authorAvatarUrl)}" alt="" width="32" height="32" loading="lazy" />`
          : `<span class="feed-source-avatar feed-source-avatar-fallback" aria-hidden="true">${escapeHtml((handle || "?").slice(0, 1).toUpperCase())}</span>`;
        return `<article class="feed-source-row" style="--enter-i:${i}">
          <header class="feed-source-head">
            ${avatar}
            <div class="feed-source-identity">
              <div class="feed-source-name-line">
                <span class="feed-source-author">${escapeHtml(name)}</span>
              </div>
              <div class="feed-source-meta-line">
                <a class="feed-handle" href="https://x.com/${escapeHtml(handle)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(handle)}</a>
                <span class="feed-meta-dot" aria-hidden="true">·</span>
                <time class="feed-time" style="--feed-age:${feedTimeAgeProgress(post.createdAt).toFixed(3)}" datetime="${escapeHtml(post.createdAt || "")}"${tipAttr(formatFeedAbsolute(post.createdAt))}>${formatFeedTime(post.createdAt)}</time>
              </div>
            </div>
            <a class="feed-source-open icon-only-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open post"${tipAttr("Open post")}>${iconHTML("arrow-up-right")}</a>
          </header>
          <div class="feed-source-text">${body || "<span class='feed-trend-empty'>No text</span>"}</div>
          <footer class="feed-source-foot">
            <span class="feed-post-kind feed-post-kind-${escapeHtml(kind)}">${escapeHtml(kindLabel)}</span>
          </footer>
        </article>`;
      })
      .join("");
  }

  function feedPlayerCardHTML(card, postsById, enterIndex, { detail = false } = {}) {
    const initials = String(card.name || "?")
      .split(/[\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?";
    const photo = feedPlayerPhotoUrl(card.code);
    const teamLabel = card.team ? teamNameForSeason(card.team) : "";
    const badge = card.team
      ? badgeHTML(card.team, "feed-player-team-badge").replace(
          "<img ",
          `<img${tipAttr(teamLabel)} `
        )
      : "";
    const metaBits = [];
    if (card.position) metaBits.push(posBadgeHTML(card.position));
    if (card.price != null) metaBits.push(`<span>£${Number(card.price).toFixed(1)}m</span>`);
    if (!detail && card.pts != null) metaBits.push(`<span>${Number(card.pts)} Pts</span>`);
    if (detail) {
      const postN = Number(card.posts) || (card.postIds && card.postIds.length) || 0;
      if (postN) metaBits.push(`<span>${postN} post${postN === 1 ? "" : "s"}</span>`);
    }
    const stats = feedPlayerStatsHTML(card, { detail });
    const photoSize = detail ? 80 : 72;
    const photoBlock = photo
      ? `<img class="feed-player-photo" src="${escapeHtml(photo)}" alt="" width="${photoSize}" height="${photoSize}" loading="lazy" data-initials="${escapeHtml(initials)}" />`
      : `<span class="feed-player-photo feed-player-photo-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
    const teamAccent = TEAM_SCATTER_ACCENT[card.team] || "";
    const accentStyle = teamAccent ? `--feed-team-accent:${teamAccent};` : "";
    const cardId = `feed-card-${escapeHtml(String(card.code))}`;
    const cardData = `id="${cardId}" data-feed-code="${escapeHtml(String(card.code))}" data-team="${escapeHtml(String(card.team || ""))}" style="--enter-i:${enterIndex};${accentStyle}"`;
    const identityHTML = `<div class="feed-player-identity">
          <div class="feed-player-photo-wrap">
            ${photoBlock}
            ${badge}
          </div>
          <div class="feed-player-title">
            <h3 class="feed-player-name"><span class="feed-player-name-text">${escapeHtml(card.name)}</span></h3>
            <p class="feed-player-meta">${metaBits.join("")}</p>
          </div>
        </div>`;
    const quotesHTML = feedQuoteRowsHTML(card.postIds, postsById, card);

    if (detail) {
      return `<section class="feed-player-detail" ${cardData}>
      <header class="feed-player-detail-header feed-player-card-top">
        ${identityHTML}
        <div class="feed-player-stats feed-player-detail-stats">${stats}</div>
      </header>
      <div class="feed-source-list feed-player-detail-posts">${quotesHTML}</div>
    </section>`;
    }

    return `<article class="rankings-card feed-player-card" ${cardData}>
      <div class="feed-player-card-top">
        ${identityHTML}
        <div class="feed-player-stats">${stats}</div>
      </div>
      <div class="feed-source-list feed-player-quotes">${quotesHTML}</div>
    </article>`;
  }

  function feedCardMatchesQuery(card, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    const teamName = card.team ? teamNameForSeason(card.team) : "";
    const hay = [card.name, card.team, teamName, card.position]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  }

  function feedCardMatchesTeamFilter(card) {
    if (!state.feedTeamFilter.size) return true;
    return card.team && state.feedTeamFilter.has(card.team);
  }

  function feedSearchWiderRangeHits(posts, query) {
    if (!(state.feedRange === "today" || state.feedRange === "3d")) return 0;
    const weekMention = computeFeedMentionCards(posts, { range: "7d" });
    return weekMention.cards.filter(
      (card) => feedCardMatchesTeamFilter(card) && feedCardMatchesQuery(card, query)
    ).length;
  }

  function feedWidenRangeHintHTML(count) {
    if (!count) return "";
    const label = count === 1 ? "1 match" : `${count} matches`;
    return `<p class="feed-empty-widen">
      <button type="button" class="feed-widen-range" data-feed-widen="7d">
        ${escapeHtml(label)} in the past week — show Past week
      </button>
    </p>`;
  }

  const FEED_TREEMAP_MAX = 14;
  const FEED_TREEMAP_W = 1000;
  const FEED_TREEMAP_H = 220;

  function feedTreemapIsCompact() {
    try {
      return window.matchMedia("(max-width: 640px)").matches;
    } catch {
      return false;
    }
  }

  function feedTreemapShortName(card) {
    const name = String(card.name || "").trim();
    if (!name) return "?";
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0];
    return parts[parts.length - 1];
  }

  function accentLuminance(hex) {
    const raw = String(hex || "").replace("#", "");
    if (raw.length !== 6) return 0.5;
    const r = parseInt(raw.slice(0, 2), 16) / 255;
    const g = parseInt(raw.slice(2, 4), 16) / 255;
    const b = parseInt(raw.slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function feedTreemapTextColor(accent) {
    return accentLuminance(accent) > 0.55 ? "#111" : "#fff";
  }

  // Squarified treemap (Bruls et al.) — layout only in abstract units.
  function squarifyFeedMentions(items, width, height) {
    const total = items.reduce((sum, d) => sum + d.value, 0);
    if (!total || width <= 0 || height <= 0) return [];
    const nodes = items.map((d) => ({
      ...d,
      area: (d.value / total) * width * height,
    }));
    const out = [];
    let x0 = 0;
    let y0 = 0;
    let x1 = width;
    let y1 = height;
    let row = [];
    let i = 0;

    const shortest = () => Math.min(x1 - x0, y1 - y0);
    const worst = (areas, side) => {
      if (!areas.length) return Infinity;
      const s = areas.reduce((a, b) => a + b, 0);
      const mx = Math.max(...areas);
      const mn = Math.min(...areas);
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    };

    const flush = (rowNodes) => {
      if (!rowNodes.length) return;
      const sum = rowNodes.reduce((a, b) => a + b.area, 0);
      const wide = x1 - x0 >= y1 - y0;
      if (wide) {
        const rw = sum / (y1 - y0);
        let y = y0;
        for (const node of rowNodes) {
          const h = node.area / rw;
          out.push({ ...node, x: x0, y, w: rw, h });
          y += h;
        }
        x0 += rw;
      } else {
        const rh = sum / (x1 - x0);
        let x = x0;
        for (const node of rowNodes) {
          const w = node.area / rh;
          out.push({ ...node, x, y: y0, w, h: rh });
          x += w;
        }
        y0 += rh;
      }
    };

    while (i < nodes.length) {
      const side = shortest();
      const next = nodes[i];
      const rowAreas = row.map((n) => n.area);
      if (!row.length || worst(rowAreas.concat(next.area), side) <= worst(rowAreas, side)) {
        row.push(next);
        i += 1;
      } else {
        flush(row);
        row = [];
      }
    }
    flush(row);
    return out;
  }

  function clearFeedTreemap() {
    if (!el.feedTreemap) return;
    el.feedTreemap.hidden = true;
    el.feedTreemap.classList.remove("is-scrollable");
    el.feedTreemap.innerHTML = "";
  }

  function renderFeedTreemap(cards, rangeLabel) {
    if (!el.feedTreemap) return;
    // Desktop/tablet only — mobile cards already carry the mention list.
    if (feedTreemapIsCompact()) {
      clearFeedTreemap();
      return;
    }
    const selected = state.feedSelectedCode != null ? String(state.feedSelectedCode) : "";
    const top = (cards || [])
      .filter((c) => c && c.posts > 0)
      .slice(0, FEED_TREEMAP_MAX)
      .map((c) => ({
        code: c.code,
        name: c.name,
        shortName: feedTreemapShortName(c),
        team: c.team,
        value: c.posts,
      }));
    if (top.length < 2) {
      clearFeedTreemap();
      return;
    }

    const totalMentions = top.reduce((s, d) => s + d.value, 0);
    const layoutW = FEED_TREEMAP_W;
    const layoutH = FEED_TREEMAP_H;
    const layout = squarifyFeedMentions(top, layoutW, layoutH);
    const selectedCard = selected
      ? top.find((c) => String(c.code) === selected)
      : null;
    const cells = layout
      .map((cell, i) => {
        const accent = TEAM_SCATTER_ACCENT[cell.team] || "#6b7280";
        const text = feedTreemapTextColor(accent);
        const left = (cell.x / layoutW) * 100;
        const topPct = (cell.y / layoutH) * 100;
        const width = (cell.w / layoutW) * 100;
        const height = (cell.h / layoutH) * 100;
        const pct = totalMentions ? Math.round((cell.value / totalMentions) * 100) : 0;
        const showCount = cell.w * cell.h > 9000;
        const showName = cell.w > 70 && cell.h > 36;
        const isSelected = selected && String(cell.code) === selected;
        const tip = isSelected
          ? `${cell.name} · selected — click to clear`
          : `${cell.name} · ${cell.value} post${cell.value === 1 ? "" : "s"} — click to filter`;
        return `<button type="button" class="feed-treemap-cell${isSelected ? " is-selected" : ""}" style="--enter-i:${i};left:${left.toFixed(2)}%;top:${topPct.toFixed(2)}%;width:${width.toFixed(2)}%;height:${height.toFixed(2)}%;--cell-accent:${accent};--cell-fg:${text}" data-feed-card="${escapeHtml(String(cell.code))}" aria-pressed="${isSelected ? "true" : "false"}" aria-label="${escapeHtml(`${cell.name}: ${cell.value} post${cell.value === 1 ? "" : "s"} (${pct}%)${isSelected ? ", selected" : ""}`)}"${tipAttr(tip)}>
          ${showName ? `<span class="feed-treemap-name">${escapeHtml(cell.shortName)}</span>` : ""}
          ${showCount ? `<span class="feed-treemap-count">${cell.value}</span>` : ""}
        </button>`;
      })
      .join("");

    const clearBtn = selectedCard
      ? `<button type="button" class="feed-treemap-clear" data-feed-treemap-clear${tipAttr("Show all players")}>Clear ${escapeHtml(selectedCard.shortName)}</button>`
      : "";

    el.feedTreemap.hidden = false;
    el.feedTreemap.classList.remove("is-scrollable");
    el.feedTreemap.innerHTML = `
      <div class="feed-treemap-head">
        <div>
          <h3>Mention share</h3>
          <p>${
            selectedCard
              ? `Filtered to <strong>${escapeHtml(selectedCard.name)}</strong> — click again or Clear to show all.`
              : `Top players in ${escapeHtml(rangeLabel)} — sized by posts (one count per player per post). Click a tile to filter.`
          }</p>
        </div>
        ${clearBtn}
      </div>
      <div class="feed-treemap-scroll">
        <div class="feed-treemap-plot" role="group" aria-label="Treemap of player mention volume">${cells}</div>
      </div>
    `;

    el.feedTreemap.querySelectorAll(".feed-treemap-cell").forEach((btn) => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-feed-card");
        if (!code) return;
        state.feedSelectedCode =
          state.feedSelectedCode != null && String(state.feedSelectedCode) === code
            ? null
            : code;
        renderFeed();
      });
    });
    const clearEl = el.feedTreemap.querySelector("[data-feed-treemap-clear]");
    if (clearEl) {
      clearEl.addEventListener("click", () => {
        state.feedSelectedCode = null;
        renderFeed();
      });
    }
  }

  function renderFeed() {
    const root = el.feedTrending || el.feedList;
    if (!root) return;
    if (el.feedTrending) el.feedTrending.classList.remove("is-player-selected");
    syncFeedRangeSeg();
    syncFeedFiltersToggle();
    const posts = SOCIAL.posts || [];
    const accounts = SOCIAL.accounts || [];
    const postsById = new Map(posts.map((p) => [String(p.id), p]));
    const rangeLabel = FEED_RANGE_LABELS[state.feedRange] || "the selected range";
    const query = el.feedSearch ? el.feedSearch.value : "";
    const trimmed = String(query || "").trim();
    const mention = computeFeedMentionCards(posts);

    if (!posts.length) {
      state.feedSelectedCode = null;
      clearFeedTreemap();
      const handles = accounts.map((a) => `@${a.handle}`).filter(Boolean).join(", ") || "@LetsTalk_FPL";
      root.innerHTML = `<div class="empty-state feed-empty">
        <p>No posts loaded yet — player cards need a fetched corpus.</p>
        <p class="feed-empty-hint">Watching ${escapeHtml(handles)}. Add more handles in <code>site/social_accounts.json</code>, then:</p>
        <pre class="feed-empty-cmd">python3 site/fetch_social.py
python3 site/annotate_social.py</pre>
      </div>`;
      return;
    }

    if (!mention.cards.length) {
      state.feedSelectedCode = null;
      clearFeedTreemap();
      const widenCount = trimmed ? feedSearchWiderRangeHits(posts, query) : 0;
      root.innerHTML = `<div class="empty-state feed-empty">
        <p>No player mentions for ${escapeHtml(rangeLabel)}.</p>
        ${
          widenCount
            ? feedWidenRangeHintHTML(widenCount)
            : `<p class="feed-empty-hint">Widen the date range, clear type/team filters, or pull fresher posts.</p>`
        }
      </div>`;
      return;
    }

    const filtered = mention.cards.filter(
      (card) => feedCardMatchesTeamFilter(card) && feedCardMatchesQuery(card, query)
    );
    if (!filtered.length) {
      state.feedSelectedCode = null;
      clearFeedTreemap();
      const widenCount = trimmed ? feedSearchWiderRangeHits(posts, query) : 0;
      root.innerHTML = `<div class="empty-state feed-empty" role="status">
        <p>No players found${trimmed ? ` for “${escapeHtml(trimmed)}”` : ""} in ${escapeHtml(rangeLabel)}.</p>
        ${
          widenCount
            ? feedWidenRangeHintHTML(widenCount)
            : `<p class="feed-empty-hint">Try another name or team, or clear search / filters.</p>`
        }
      </div>`;
      return;
    }

    if (
      state.feedSelectedCode != null &&
      !filtered.some((c) => String(c.code) === String(state.feedSelectedCode))
    ) {
      state.feedSelectedCode = null;
    }

    // Treemap stays on the full filtered set so selection can switch; cards narrow.
    renderFeedTreemap(filtered, rangeLabel);
    const cardsForList =
      state.feedSelectedCode != null
        ? filtered.filter((c) => String(c.code) === String(state.feedSelectedCode))
        : filtered;

    const playerSelected =
      state.feedSelectedCode != null && !feedTreemapIsCompact();
    if (el.feedTrending) {
      el.feedTrending.classList.toggle("is-player-selected", playerSelected);
    }

    if (playerSelected && cardsForList.length === 1) {
      root.innerHTML = feedPlayerCardHTML(cardsForList[0], postsById, 0, { detail: true });
    } else {
      const cards = cardsForList
        .map((card, i) => feedPlayerCardHTML(card, postsById, i))
        .join("");
      root.innerHTML = `<div class="rankings-grid feed-player-grid">${cards}</div>`;
    }

    root.querySelectorAll("img.feed-player-photo").forEach((img) => {
      img.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "feed-player-photo feed-player-photo-fallback";
        fallback.setAttribute("aria-hidden", "true");
        fallback.textContent = img.getAttribute("data-initials") || "?";
        img.replaceWith(fallback);
      });
    });
  }


  // ---------------------------------------------------------------------
