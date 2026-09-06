---
name: badminton-session-finder
description: Organize exported Facebook posts into player sessions, venue rentals/transfers, coaching courses, and tournament registration tables. Use for extracting these listings or querying player sessions by schedule, play format, level, fee, and contact. Sport identification is out of scope; preserve the existing collection context. Not for generic CSV work or Facebook collection problems.
---

# Badminton Session Finder

Use the repository's Node scripts for every deterministic transformation. Never improvise a semantic parser with regular expressions.

## Route the request

- For archive-backed resumable processing, read [the operations guide](../../docs/development/post-etl-operations.md), then use `prepare --db` and `etl` to keep per-post state. A partial report allows validated posts to publish; resolve or report every incomplete task.
- When the user authorizes extraction through Codex CLI, use `etl extract` with the prepared model configuration. It passes the frozen contract to `codex exec`, saves responses, validates each post, and bounds retries. Preserve the requested model, reasoning effort, and service tier.
- For one or more raw Facebook export JSON files, read [references/extraction-mode.md](references/extraction-mode.md) and [references/output-contract.md](references/output-contract.md).
- For questions over an existing `output_result.csv`, read [references/search-mode.md](references/search-mode.md) and [references/result-format.md](references/result-format.md).
- When the user asks to organize and then search, finish extraction first and query the newly generated CSV in the same task.
- When the user asks to update or publish the online session website, follow [the static website publishing procedure](../../docs/development/post-etl-operations.md#靜態網站發布). Local ETL publication does not update `site/index.html` or GitHub Pages. Validate the intended publication, update the snapshot, and commit/push within the user's existing authorization; verify the deployment before reporting the website as updated. Extraction alone does not imply an online deployment request.

## Classification

For every new listing, classify listing_type as session, venue_rental, coaching, or tournament, then fill the matching service_details and a single nullable play_format. Read extraction-mode.md and its examples through the extraction route above. Existing unclassified records stay in the session view; never silently reclassify stored results. Other types publish to separate JSON/CSV tables and do not appear in the session browser.

## Invariants

- Run `prepare` before model analysis. For every handoff, read the generated `extraction_contract.json`, including the same-version purpose, rules, schema, examples, and model configuration; give it to the model together with each `{id, context}` task.
- Model results contain only `id` and `analysis`. Do not add source metadata or URLs.
- Run `join` after analysis. Join only by ID; never rely on array or file order.
- URLs come only from the deterministic link inventory. Do not generate, repair, or copy URLs through model output.
- Keep `output_result.json` lossless. Treat `output_result.csv` as the searchable listing view.
- A search result is useful only when it explains the level and price and gives a real contact entry point. Never present bare text such as `未標示｜FB私訊` as an actionable recommendation.

## Commands

Run commands from the repository root:

```sh
npm run badminton -- prepare <raw.json> [more.json ...] --out <result-directory>
npm run badminton -- join --source <source_records.json> --analysis <llm_results.jsonl> --out <joined_records.json>
npm run badminton -- finalize --joined <joined_records.json> --out <result-directory>
npm run badminton -- query --csv <output_result.csv> --plan <query.json> --out <search_result.csv>
npm run badminton -- validate --run <result-directory>
```

Use the structured schemas in `references/` when producing model analysis or a query plan. After each command, inspect its JSON summary. Standalone join remains strict on missing IDs. The archive path records failures per task and may publish a clearly reported partial batch; use explicit retry/recover commands, never rewrite a successful task. Publication paths returned by finalize are immutable; use the `current` directory for the latest complete batch.
