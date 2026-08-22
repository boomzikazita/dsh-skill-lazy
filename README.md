# dsh-skill-lazy

Lazy skill catalog loading for DeepSeek Harness (DSH). Save tokens on every session by injecting only **skill names + one-line summaries** instead of the full catalog, and look up full descriptions on demand via `skill_search`.

## Why

By default, DSH injects the full skill catalog — the name plus up to a 500-character description of every installed skill — into the context of every new session. With dozens of skills installed this costs roughly **3K tokens of persistent context per session**, even though the model rarely touches most of those skills.

`dsh-skill-lazy` replaces that full dump with a compact catalog: **just the skill name and a one-line summary (≤ 40 characters by default)**. Full descriptions stay one `skill_search` call away and are only fetched when actually needed.

## How it works

### First pass: compact catalog injection

- On every agent pre-step, the plugin rewrites the official `skill-catalog` message into a `<system-reminder>` block where each skill appears as `` `name`: one-line summary ``.
- Entries are sorted by **call frequency (most-used first)**, falling back to alphabetical order for ties.
- The underlying `source.entries` of the catalog message is left untouched, so the harness's own digest/deduplication logic is unaffected.

### On demand: `skill_search`

- Registers a `skill_search` tool that queries the **full** catalog by keywords and returns hits grouped by **MECE domains** (mutually exclusive groups, collectively exhaustive coverage), each with its full description, usage count, and a domain-coverage report that flags empty or weak domains.
- Query scoring covers exact name matches, description substring matches, tokenized keywords, and Chinese 2-gram overlap.

### Usage tracking

- A `tools/post-execute` hook records every `skill` tool invocation into `usage.json` (runtime data — see [.gitignore](.gitignore)). The accumulated counts drive catalog ordering.
- An optional proactive match hint (top-3 skills with relevance ≥ threshold) can be injected right after a user message.

### `skill_mece_check`

- A `skill_mece_check` tool runs before creating or evaluating a skill: it checks **mutual exclusivity** (keyword overlap against every existing skill, with overlap ratio) and **collective exhaustiveness** (domain coverage matrix with empty/weak domain flags), then recommends whether to create a new skill or extend an existing one.

### `cost_audit`

- A `cost_audit` token-cost watchdog (added 2026-08-21) tallies the character/token cost of every plugin tool `description` and every skill directory `description`, compares against budgets (tool descriptions default **1500 tokens**; skill directory default **800 tokens**), and flags anything over budget for slimming or collapsing.
- Single tool descriptions longer than 700 characters are marked for slimming — the detail belongs in the skill's own docs, not in the injected description.

## Installation

```bash
dsh plugin --profile web add github:boomzikazita/dsh-skill-lazy
```

The plugin mounts via its bundle patch (`cordis.patch.yml`), which adds the `skill-lazy` bundle to the profile's `dsh.profile.bundles`.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `catalogDescriptionMaxLength` | `40` | Max characters of the one-line summary per skill in the compact catalog. |
| `topK` | `6` | Max hits per domain group returned by `skill_search` (clamped to 1–20). |
| `sortByUsage` | `true` | Sort catalog entries by recorded call frequency (fallback: alphabetical). |
| `matchThreshold` | `6` | Minimum relevance score for the proactive match hint. |

Example bundle patch with custom config:

```yaml
- insert:
    - id: skill-lazy
      name: 'dsh-skill-lazy'
      config:
        catalogDescriptionMaxLength: 40
        topK: 6
```

## Requirements

- DeepSeek Harness with `@deepseek-ai/dsh-tools` **≥ 0.1.0-rc.6** (peer dependency — it is not bundled).

## License

MIT © 2026 [boomzikazita](https://github.com/boomzikazita). See [LICENSE](LICENSE).
