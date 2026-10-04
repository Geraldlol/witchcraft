# Witchcraft guide reference data

`guide-starter.json` is a small, manually curated factual reference: seven Defias Brotherhood quest stages and twelve item goals across three early Classic dungeons. It supplies the first useful quest and loot queries without pretending to be a complete game database.

This catalog was originally assembled for Forever **1.60.1.69913**; see the [main README](../../../README.md#requirements) for the current release's client target. It uses older Classic source data and remains **reference-only**. Source revisions identify the upstream records examined; they do not certify that Forever has identical requirements, drops, or quest behavior. The catalog does not establish matching in-game behavior.

Every record points to a catalog source with an immutable upstream URL and commit. Names and IDs are factual identifiers. Hints are brief original paraphrases, not copied quest prose. No upstream executable Lua, art, database files, or libraries are bundled or executed.

Catalog conventions:

- Quest IDs distinguish the seven identically named stages. Search results must preserve those IDs.
- `minLevel` comes from Questie's `requiredLevel`, not its recommended quest level.
- `prerequisiteQuestIds` records known predecessor requirements. An empty array is not a promise that every other acceptance condition has been modeled.
- Omitted `requiredItems` means unmodeled. Items supplied by a quest or collected to finish it must not become invented conditions for accepting it.
- Acquisition-source `id` groups the whole dungeon so several wanted items count toward one run.
- Optional `encounter` names the boss inside that dungeon; it does not change the dungeon grouping key.
- There are no drop rates, upgrade scores, travel times, guaranteed rewards, faction eligibility checks, or exhaustive source claims in this starter.
- A wishlist can contain an item outside this catalog; its acquisition path remains unknown until a cited source is added.

Keep future catalog updates reviewable. Verify source revisions, ID/name pairs, prerequisite semantics, and source grouping before adding facts; retain the compatibility warning until matching Forever evidence exists.

`adventure-starter.json` extends this reference with nine selected boss lessons across three dungeons, nine zone detours and three personal campaigns. Boss quizzes and role advice are original preparation text supported by the pinned source mechanics. Personal passport milestones are user-confirmed records, not official achievements. The same reference-only compatibility limits apply.
