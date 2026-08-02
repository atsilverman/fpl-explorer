# FPL API Data Dictionary

**Generated:** 2026-01-24  
**Based on:** Live FPL API analysis and verification

---

## Complete Data Dictionary

This section provides comprehensive data dictionaries for all FPL API endpoints, including all available fields, their types, possible values, and descriptions.

### Bootstrap Static

**Endpoint:** `GET /api/bootstrap-static/`

#### Top-Level Structure

| Key | Type | Description |
|-----|------|-------------|
| `chips` | array | Chip definitions |
| `events` | array | Gameweeks |
| `game_settings` | object | Game settings |
| `game_config` | object | Game configuration |
| `phases` | array | Season phases |
| `teams` | array | Teams |
| `total_players` | integer | Total number of players |
| `element_stats` | array | Available stat definitions |
| `element_types` | array | Position types (GK, DEF, MID, FWD) |
| `elements` | array | All players |

#### Chips Array

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 1 | 1-8 | Chip ID |
| `name` | string | "wildcard" | "wildcard", "freehit", "bboost", "3xc" | Chip name |
| `number` | integer | 1 | Integer | Chip number |
| `start_event` | integer | 2 | 1-38 | First gameweek chip is available |
| `stop_event` | integer | 19 | 1-38 | Last gameweek chip is available |
| `chip_type` | string | "transfer" | "transfer", "points" | Type: 'transfer' or 'points' |
| `overrides` | object | {object} | Object with 4 keys | Rule overrides for this chip |

#### Events Array (Gameweeks)

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 1 | 1-38 | Gameweek ID |
| `name` | string | "Gameweek 1" | String | Gameweek name |
| `deadline_time` | string | "2025-08-15T17:30:00Z" | ISO 8601 UTC | Transfer deadline datetime |
| `release_time` | null/string | null | null or ISO datetime | When gameweek data is released |
| `average_entry_score` | integer | 54 | Integer | Average points scored by all managers |
| `finished` | boolean | true | true, false | All matches finished |
| `data_checked` | boolean | true | true, false | All data confirmed |
| `highest_scoring_entry` | integer | 3772644 | Integer | Manager ID with highest score |
| `highest_score` | integer | 127 | Integer | Highest points scored |
| `is_current` | boolean | false | true, false | Is current active gameweek |
| `is_next` | boolean | false | true, false | Is next gameweek |
| `is_previous` | boolean | false | true, false | Is previous gameweek |
| `chip_plays` | array | [{object}, ...] | Array of objects | Array of chip usage stats |
| `most_selected` | integer | 235 | Integer | Most selected player ID |
| `most_transferred_in` | integer | 1 | Integer | Most transferred in player ID |
| `top_element` | integer | 531 | Integer | Top scoring player ID |
| `transfers_made` | integer | 0 | Integer | Total transfers made by all managers |
| `most_captained` | integer | 381 | Integer | Most captained player ID |
| `most_vice_captained` | integer | 235 | Integer | Most vice-captained player ID |

#### Teams Array

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 1 | 1-20 | Team ID |
| `name` | string | "Arsenal" | String | Full team name |
| `short_name` | string | "ARS" | String | Short team name (3 letters) |
| `code` | integer | 3 | Integer | Team code number |
| `strength` | integer | 5 | Integer | Team strength rating (1-5) |
| `strength_overall_home` | integer | 1300 | Integer | Overall home strength |
| `strength_overall_away` | integer | 1375 | Integer | Overall away strength |
| `strength_attack_home` | integer | 1340 | Integer | Attack strength at home |
| `strength_attack_away` | integer | 1400 | Integer | Attack strength away |
| `strength_defence_home` | integer | 1260 | Integer | Defence strength at home |
| `strength_defence_away` | integer | 1350 | Integer | Defence strength away |
| `played` | integer | 0 | Integer | Matches played |
| `win` | integer | 0 | Integer | Wins |
| `draw` | integer | 0 | Integer | Draws |
| `loss` | integer | 0 | Integer | Losses |
| `points` | integer | 0 | Integer | League points |
| `position` | integer | 1 | Integer | League position |

#### Elements Array (Players)

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 624 | Integer | Player element ID |
| `web_name` | string | "Bowen" | String | Display name |
| `first_name` | string | "Jarrod" | String | First name |
| `second_name` | string | "Bowen" | String | Last name |
| `team` | integer | 19 | 1-20 | Team ID |
| `element_type` | integer | 3 | 1-4 | Position ID (1=GK, 2=DEF, 3=MID, 4=FWD) |
| `now_cost` | integer | 80 | Integer (tenths) | Current price (e.g., 80 = £8.0m) |
| `total_points` | integer | 66 | Integer | Total points this season |
| `event_points` | integer | 2 | Integer | Points in current gameweek |
| `bonus` | integer | 3 | Integer | Total bonus points this season |
| `bps` | integer | 267 | Integer | Total BPS this season |
| `minutes` | integer | 1350 | Integer | Total minutes played |
| `goals_scored` | integer | 0 | Integer | Total goals |
| `assists` | integer | 0 | Integer | Total assists |
| `clean_sheets` | integer | 8 | Integer | Total clean sheets |
| `defensive_contribution` | integer | 0 | Integer | Total defensive contribution |
| `selected_by_percent` | string | "34.7" | String | Ownership percentage |
| `transfers_in` | integer | 2793762 | Integer | Total transfers in |
| `transfers_out` | integer | 1095330 | Integer | Total transfers out |
| `form` | string | "3.2" | String | Recent form (points per game) |
| `points_per_game` | string | "4.4" | String | Average points per game |
| `status` | string | "a" | "a", "d", "i", "n", "s" | Availability status (a=available, d=doubtful, i=injured, n=not available, s=suspended) |
| `chance_of_playing_this_round` | null/integer | null | null or 0-100 | Chance of playing (0-100%) |
| `chance_of_playing_next_round` | null/integer | null | null or 0-100 | Chance of playing next gameweek |
| `news` | string | "" | String | News/injury updates |
| `news_added` | null/string | null | null or ISO datetime | When news was added |
| `in_dreamteam` | boolean | true | true, false | In current gameweek dream team |
| `dreamteam_count` | integer | 1 | Integer | Times in dream team |

#### Element Types Array (Positions)

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 1 | 1-4 | Position ID (1=GK, 2=DEF, 3=MID, 4=FWD) |
| `plural_name` | string | "Goalkeepers" | String | Position plural name |
| `plural_name_short` | string | "GKP" | String | Position abbreviation |
| `singular_name` | string | "Goalkeeper" | String | Position singular name |
| `singular_name_short` | string | "GKP" | String | Position short name |
| `squad_select` | integer | 2 | Integer | Number required in squad |
| `squad_min_select` | null/integer | null | null or integer | Minimum required |
| `squad_max_select` | null/integer | null | null or integer | Maximum allowed |
| `squad_min_play` | integer | 1 | Integer | Minimum to play |
| `squad_max_play` | integer | 1 | Integer | Maximum to play |
| `element_count` | integer | 88 | Integer | Number of players in this position |

### Fixtures

**Endpoint:** `GET /api/fixtures/`

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 230 | Integer | Fixture ID |
| `code` | integer | 2561895 | Integer | Fixture code |
| `event` | integer | 23 | 1-38 | Gameweek ID |
| `team_h` | integer | 19 | 1-20 | Home team ID |
| `team_a` | integer | 17 | 1-20 | Away team ID |
| `team_h_score` | null/integer | 3 | null or integer | Home team score (null if not started) |
| `team_a_score` | null/integer | 1 | null or integer | Away team score (null if not started) |
| `started` | boolean | true | true, false | Match has started |
| `finished` | boolean | false | true, false | Match is finished |
| `finished_provisional` | boolean | true | true, false | Match finished but data provisional |
| `minutes` | integer | 90 | 0-90+ | Current minute (caps at 90) |
| `kickoff_time` | string | "2026-01-24T12:30:00Z" | ISO 8601 UTC | Kickoff datetime |
| `provisional_start_time` | boolean | false | true, false | Provisional start time flag |
| `stats` | array | [{object}, ...] | Array of objects | Match statistics |
| `team_h_difficulty` | integer | 2 | 1-5 | Home team fixture difficulty |
| `team_a_difficulty` | integer | 3 | 1-5 | Away team fixture difficulty |
| `pulse_id` | integer | 1 | Integer | Pulse ID |

#### Stats Array Structure

Each fixture contains a `stats` array with match statistics. Each stat object has:

| Field | Type | Description |
|-------|------|-------------|
| `identifier` | string | Stat type identifier |
| `h` | array | Home team players with this stat |
| `a` | array | Away team players with this stat |

**Available Stat Identifiers:**
- `goals_scored` - Goals scored by players
- `assists` - Assists by players
- `own_goals` - Own goals
- `penalties_saved` - Penalties saved
- `penalties_missed` - Penalties missed
- `yellow_cards` - Yellow cards
- `red_cards` - Red cards
- `saves` - Saves made (GK)
- `bonus` - Bonus points awarded
- `bps` - BPS (Bonus Points System) scores
- `defensive_contribution` - DEFCON values

Each player entry in `h` or `a` arrays contains:

| Field | Type | Description |
|-------|------|-------------|
| `element` | integer | Player element ID |
| `value` | integer | Stat value |

### Live Data

**Endpoint:** `GET /api/event/{gameweek}/live`

Replace `{gameweek}` with the gameweek number (e.g., `/event/23/live`).

#### Elements Array

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 624 | Integer | Player element ID |
| `stats` | object | {object} | Object | Player statistics object |
| `explain` | array | [{object}, ...] | Array of objects | Points breakdown explanation |
| `modified` | boolean | false | true, false | Data has been modified |

#### Stats Object (Player Statistics)

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `minutes` | integer | 90 | 0-90+ | Minutes played |
| `goals_scored` | integer | 1 | Integer | Goals scored |
| `assists` | integer | 1 | Integer | Assists |
| `clean_sheets` | integer | 0 | Integer | Clean sheets |
| `goals_conceded` | integer | 0 | Integer | Goals conceded |
| `own_goals` | integer | 0 | Integer | Own goals |
| `penalties_saved` | integer | 0 | Integer | Penalties saved |
| `penalties_missed` | integer | 0 | Integer | Penalties missed |
| `yellow_cards` | integer | 0 | Integer | Yellow cards |
| `red_cards` | integer | 0 | Integer | Red cards |
| `saves` | integer | 0 | Integer | Saves made |
| `bonus` | null/integer | 0 | null or 0-3 | Bonus points (0-3, or null if not confirmed) |
| `bps` | integer | 41 | Integer | BPS (Bonus Points System) score |
| `influence` | string | "10.6" | String | Influence score |
| `creativity` | string | "4.3" | String | Creativity score |
| `threat` | string | "34.0" | String | Threat score |
| `ict_index` | string | "4.9" | String | ICT (Influence, Creativity, Threat) index |
| `clearances_blocks_interceptions` | integer | 0 | Integer | CBI (Clearances + Blocks + Interceptions) |
| `recoveries` | integer | 6 | Integer | Ball recoveries |
| `tackles` | integer | 2 | Integer | Tackles made |
| `defensive_contribution` | integer | 4 | Integer | DEFCON (Defensive Contribution) |
| `starts` | integer | 1 | Integer | Number of starts |
| `expected_goals` | string | "0.15" | String | xG (Expected Goals) |
| `expected_assists` | string | "0.05" | String | xA (Expected Assists) |
| `expected_goal_involvements` | string | "0.20" | String | xGI (Expected Goal Involvements) |
| `expected_goals_conceded` | string | "0.68" | String | xGC (Expected Goals Conceded) |
| `total_points` | integer | 9 | Integer | Total points (may not include bonus if provisional) |
| `in_dreamteam` | boolean | false | true, false | In dream team |

### Element Summary (Player Summary)

**Endpoint:** `GET /api/element-summary/{player_id}/`

Replace `{player_id}` with the player's element ID.

#### History Array (Per Gameweek Stats)

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `element` | integer | 624 | Integer | Player element ID |
| `fixture` | integer | 230 | Integer | Fixture ID |
| `opponent_team` | integer | 17 | 1-20 | Opponent team ID |
| `total_points` | integer | 9 | Integer | Points scored |
| `was_home` | boolean | true | true, false | Was home match |
| `kickoff_time` | string | "2026-01-24T12:30:00Z" | ISO 8601 UTC | Kickoff datetime |
| `team_h_score` | integer | 3 | Integer | Home team score |
| `team_a_score` | integer | 1 | Integer | Away team score |
| `round` | integer | 23 | 1-38 | Gameweek number |
| `modified` | boolean | false | true, false | Data modified |
| `minutes` | integer | 90 | 0-90+ | Minutes played |
| `goals_scored` | integer | 1 | Integer | Goals scored |
| `assists` | integer | 1 | Integer | Assists |
| `clean_sheets` | integer | 0 | Integer | Clean sheets |
| `goals_conceded` | integer | 0 | Integer | Goals conceded |
| `own_goals` | integer | 0 | Integer | Own goals |
| `penalties_saved` | integer | 0 | Integer | Penalties saved |
| `penalties_missed` | integer | 0 | Integer | Penalties missed |
| `yellow_cards` | integer | 0 | Integer | Yellow cards |
| `red_cards` | integer | 0 | Integer | Red cards |
| `saves` | integer | 0 | Integer | Saves |
| `bonus` | integer | 0 | Integer | Bonus points |
| `bps` | integer | 41 | Integer | BPS score |
| `influence` | string | "10.6" | String | Influence score |
| `creativity` | string | "4.3" | String | Creativity score |
| `threat` | string | "34.0" | String | Threat score |
| `ict_index` | string | "4.9" | String | ICT index |
| `clearances_blocks_interceptions` | integer | 0 | Integer | CBI |
| `recoveries` | integer | 6 | Integer | Recoveries |
| `tackles` | integer | 2 | Integer | Tackles |
| `defensive_contribution` | integer | 4 | Integer | DEFCON |
| `starts` | integer | 1 | Integer | Starts |
| `expected_goals` | string | "0.15" | String | xG |
| `expected_assists` | string | "0.05" | String | xA |
| `expected_goal_involvements` | string | "0.20" | String | xGI |
| `expected_goals_conceded` | string | "0.68" | String | xGC |
| `value` | integer | 80 | Integer (tenths) | Player value at time |
| `transfers_balance` | integer | 0 | Integer | Net transfers |
| `selected` | integer | 1697709 | Integer | Ownership count |
| `transfers_in` | integer | 0 | Integer | Transfers in |
| `transfers_out` | integer | 0 | Integer | Transfers out |

#### Fixtures Array (Upcoming Matches)

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 231 | Integer | Fixture ID |
| `code` | integer | 2561896 | Integer | Fixture code |
| `team_h` | integer | 19 | 1-20 | Home team ID |
| `team_h_score` | null/integer | null | null or integer | Home team score (null if not played) |
| `team_a` | integer | 18 | 1-20 | Away team ID |
| `team_a_score` | null/integer | null | null or integer | Away team score (null if not played) |
| `event` | integer | 24 | 1-38 | Gameweek number |
| `finished` | boolean | false | true, false | Match finished |
| `minutes` | integer | 0 | 0-90+ | Current minute |
| `provisional_start_time` | boolean | false | true, false | Provisional start time |
| `kickoff_time` | string | "2026-01-31T15:00:00Z" | ISO 8601 UTC | Kickoff datetime |
| `event_name` | string | "Gameweek 24" | String | Gameweek name |
| `is_home` | boolean | true | true, false | Is home match |
| `difficulty` | integer | 3 | 1-5 | Fixture difficulty |

### Manager Entry

**Endpoint:** `GET /api/entry/{manager_id}/`

Replace `{manager_id}` with the manager's entry ID.

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `id` | integer | 1 | Integer | Manager entry ID |
| `name` | string | "Getting the Worm" | String | Manager name |
| `current_event` | integer | 23 | 1-38 | Current gameweek ID |
| `favourite_team` | integer | 12 | 1-20 | Favourite team ID |
| `joined_time` | string | "2025-07-21T10:52:51.272771Z" | ISO 8601 UTC | When manager joined |
| `last_deadline_bank` | integer | 10 | Integer (tenths) | Bank value at last deadline |
| `last_deadline_total_transfers` | integer | 0 | Integer | Total transfers made |
| `last_deadline_value` | integer | 976 | Integer (tenths) | Team value at last deadline |
| `leagues` | object | {object} | Object | Manager's leagues |
| `kit` | null/string | null | null or URL | Kit image URL |
| `club_badge_src` | null/string | null | null or URL | Club badge URL |

### Manager Picks

**Endpoint:** `GET /api/entry/{manager_id}/event/{gameweek}/picks/`

Replace `{manager_id}` with manager ID and `{gameweek}` with gameweek number.

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `active_chip` | null/string | "wildcard" | null, "wildcard", "freehit", "bboost", "3xc" | Active chip for this gameweek |
| `automatic_subs` | array | [] | Array of objects | Automatic substitutions |
| `entry_history` | object | {object} | Object | Manager's gameweek history |
| `picks` | array | [{object}, ...] | Array of 15 objects | Team picks (11 starters + 4 bench) |

#### Picks Array Structure

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `element` | integer | 624 | Integer | Player element ID |
| `position` | integer | 1 | 1-15 | Position in team (1-11 = starting XI, 12-15 = bench) |
| `is_captain` | boolean | false | true, false | Is captain |
| `is_vice_captain` | boolean | false | true, false | Is vice-captain |
| `multiplier` | integer | 1 | 1, 2, 3 | Points multiplier (1=normal, 2=captain, 3=triple captain) |

#### Entry History Structure

| Field | Type | Description |
|-------|------|-------------|
| `event` | integer | Gameweek ID |
| `points` | integer | Points scored |
| `total_points` | integer | Cumulative total points |
| `rank` | integer | Overall rank |
| `rank_sort` | integer | Rank for sorting |
| `overall_rank` | integer | Overall rank |
| `bank` | integer | Bank value (tenths) |
| `value` | integer | Team value (tenths) |
| `event_transfers` | integer | Transfers made |
| `event_transfers_cost` | integer | Transfer cost (points deducted) |
| `points_on_bench` | integer | Points on bench |

**Transfer Cost Rules:**
- **Free Transfers**: 1 free transfer per gameweek (can accumulate up to 2 maximum)
- **Hits**: Each transfer beyond free transfers costs -4 points
- **Wildcard/Free Hit**: All transfers are free (no hits)
- **Calculation**: The API calculates `event_transfers_cost` correctly based on:
  - Free transfers accumulated from previous gameweeks
  - Number of transfers made (`event_transfers`)
  - Wildcard/Free Hit chip usage
- **Example**: 2 transfers with 1 free available = 1 hit = -4 points

### Manager History

**Endpoint:** `GET /api/entry/{manager_id}/history/`

| Field | Type | Description |
|-------|------|-------------|
| `current` | array | Gameweek-by-gameweek history |
| `past` | array | Previous seasons summary |

#### Current Array Structure (Same as Entry History above)

#### Past Array Structure

| Field | Type | Description |
|-------|------|-------------|
| `season_name` | string | Season name (e.g., "2024/25") |
| `element_code` | integer | Player element code |
| `start_cost` | integer | Starting cost (tenths) |
| `end_cost` | integer | Ending cost (tenths) |
| `total_points` | integer | Total points |
| `minutes` | integer | Total minutes |
| `goals_scored` | integer | Total goals |
| `assists` | integer | Total assists |
| `clean_sheets` | integer | Total clean sheets |
| `goals_conceded` | integer | Total goals conceded |
| `own_goals` | integer | Own goals |
| `penalties_saved` | integer | Penalties saved |
| `penalties_missed` | integer | Penalties missed |
| `yellow_cards` | integer | Yellow cards |
| `red_cards` | integer | Red cards |
| `saves` | integer | Saves |
| `bonus` | integer | Bonus points |
| `bps` | integer | BPS total |
| `influence` | string | Influence score |
| `creativity` | string | Creativity score |
| `threat` | string | Threat score |
| `ict_index` | string | ICT index |

### Manager Transfers

**Endpoint:** `GET /api/entry/{manager_id}/transfers/`

| Field | Type | Example Value | Possible Values | Description |
|-------|------|---------------|-----------------|-------------|
| `element_in` | integer | 624 | Integer | Player element ID transferred in |
| `element_out` | integer | 615 | Integer | Player element ID transferred out |
| `entry` | integer | 1 | Integer | Manager entry ID |
| `event` | integer | 23 | 1-38 | Gameweek when transfer was made |
| `time` | string | "2026-01-24T11:00:00Z" | ISO 8601 UTC | Transfer datetime (UTC) |

---

## References

- **Official FPL Bonus Timing**: [Premier League - How to check FPL bonus points during matches](https://www.premierleague.com/en/news/1573937)
- **FPL API Base URL**: `https://fantasy.premierleague.com/api`
- **Verified**: 2026-01-24 (Gameweek 23)

---

*This document was generated from live FPL API analysis and verification.*
