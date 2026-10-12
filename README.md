# IndexNow Submit Action

Submits only the sitemap URLs that **changed since the last successful run** to [IndexNow](https://www.indexnow.org) (Bing, Yandex, Seznam, Naver, ...).

IndexNow is meant for URLs that were recently added, updated or deleted, not for resubmitting a whole site. Other actions filter the sitemap by a `<lastmod>` time window. That misses deleted pages and backdated content, and resubmits URLs when runs overlap. This action instead:

1. restores the sitemap state (URL → `<lastmod>`) from the last successful submission, stored in the GitHub Actions cache,
2. fetches the live sitemap (`<urlset>`, `<sitemapindex>`, gzip),
3. submits URLs that were **added**, **updated** (`<lastmod>` changed) or **removed**,
4. saves the new state only if every submission succeeded, so failures are retried on the next run.

It's a composite action with a dependency-free Node script that runs on the runner's preinstalled Node. It doesn't need or touch `actions/setup-node`. It needs Node.js 18 or later on `PATH`, which matters on self-hosted runners and in `container:` jobs.

## Usage

Run it after a deploy, once the new revision is actually serving, plus a daily cron to catch changes that didn't come from a deploy and to retry failures:

```yaml
name: IndexNow

on:
  workflow_run:
    workflows: [Deploy]
    types: [completed]
    branches: [main]
  schedule:
    - cron: "17 4 * * *"
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        options: [changed, all]
        default: changed

# Runs must not race on the stored state.
concurrency:
  group: indexnow
  cancel-in-progress: false

jobs:
  indexnow:
    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: JannikWempe/indexnow-submit-action@v1
        with:
          site-url: https://example.com
          key: ${{ vars.INDEXNOW_KEY }}
          mode: ${{ inputs.mode || 'changed' }}
```

Or as the last step of the deploy job itself:

```yaml
      - name: Wait for the rollout
        run: aws ecs wait services-stable --cluster prod --services web
      - uses: JannikWempe/indexnow-submit-action@v1
        with:
          site-url: https://example.com
          key: ${{ vars.INDEXNOW_KEY }}
```

If you do this, add the job to the same `concurrency` group as the cron workflow, or put both triggers in one workflow. Don't do this if the deploy is triggered by a tag or release: the state would be cached per tag and never restored (see [Branch and tag scope](#things-to-know)). Use the `workflow_run` setup above instead.

Use `mode: all` via `workflow_dispatch` after a migration (for example, a domain or URL structure change) to submit every URL once.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `site-url` | (required) | Base URL, for example `https://example.com`. Only sitemap URLs on its host are submitted. Others are skipped with a warning, because IndexNow rejects them. |
| `key` | (required) | Your IndexNow key. |
| `sitemap-url` | `<site-url>/sitemap.xml` | Sitemap or sitemap index. |
| `key-location` | `<site-url>/<key>.txt` | URL of the key file. |
| `mode` | `changed` | `changed`: added, updated and removed URLs since the last state. `all`: every sitemap URL plus removed ones. Still saves state. |
| `on-missing-state` | `baseline` | When no state exists: `baseline` records the sitemap and submits nothing. `all` submits every URL. |
| `endpoint` | `https://api.indexnow.org/indexnow` | IndexNow endpoint. |
| `dry-run` | `false` | Print what would be submitted. Doesn't submit or save state. |
| `cache-key-prefix` | `indexnow-state` | Cache key prefix. The host is appended, so several sites in one repository work. |

The key is public by design (search engines fetch it from `key-location`), so you can pass it as plain text, a variable or a secret.

## Outputs

| Output | Description |
| --- | --- |
| `submitted-count` | Number of URLs submitted. In dry-run, the number that would have been submitted. |
| `submitted-urls` | Newline-separated submitted URLs. |
| `added` | URLs new since the last state. |
| `updated` | URLs whose `<lastmod>` changed, including when it appeared or disappeared. |
| `removed` | URLs in the last state but no longer in the sitemap. |

The step log groups the URLs, and the job summary shows a table of changes and the IndexNow response.

## Things to know

- **Run it after the new revision is serving.** The action reads the live sitemap. If it runs before the deployment is done (for example, before an ECS rollout has stabilized or a CDN cache was invalidated), it sees the old sitemap and the changes only go out on the next run.
- **`<lastmod>` drives "updated".** Added and removed URLs are detected regardless, but changes to existing pages are only detected if their `<lastmod>` changes. A sitemap that sets every `<lastmod>` to the build time makes every page look updated on every deploy.
- **First run / lost state.** Without state, the default `on-missing-state: baseline` records the current sitemap and submits nothing. IndexNow asks not to submit changes from before you started using it. Because lost state looks the same as a first run, recording a baseline emits a warning.
- **Cache eviction.** GitHub evicts cache entries that haven't been accessed for 7 days. A restore counts as access, so a daily cron keeps the state alive. A new entry is only saved when the sitemap changed. If the state is evicted, the next run records a new baseline, and changes made since the last successful run are not submitted.
- **Branch and tag scope.** Caches are scoped to the ref. Run the action on the default branch so all runs share one state. Runs triggered by a tag (`push: tags`, `release`) can't restore state saved by other tags, so every run records a new baseline and submits nothing. The action warns when it runs on a tag.
- **Scheduled workflows get disabled.** GitHub disables `schedule` triggers in public repositories after 60 days without repository activity. Without the cron, the state can be evicted on a quiet site.
- **Concurrency.** Use a `concurrency` group so two runs don't read the same state and submit the same changes twice.
- **Failures.** 429, 5xx and network errors are retried with backoff. 200 and 202 (key validation pending) count as success. Any other response fails the step and leaves the state untouched. URLs are sent in batches of up to 10,000. If one batch fails after another succeeded, the next run resubmits both.
- An empty sitemap fails the step instead of being treated as "every URL was removed". So does a sitemap fetch error.

## Development

```sh
npm test   # node:test, no dependencies
```

CI runs the unit tests on Linux, macOS and Windows. It also runs the action end to end (`uses: ./`) against a local stub site and IndexNow endpoint.

## License

[MIT](LICENSE)
