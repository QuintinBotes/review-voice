# Local comparison evidence

Set `REVIEW_VOICE_COMPARISON_REPORT` to the absolute path of a regular JSON file produced by your trusted CI job. The review driver reads it alongside the ordinary static evidence, including when repository commands are disabled. For a manual run, pass `--review-dir` to `evidence` with the directory written by `diff --out`. Use a base or PR review with known commits. Place the report outside the PR checkout.

The envelope contains the full merge-base and head commit IDs and an array of reports. The CLI bounds the input to 4 MiB, returns at most 100 leads and records incomplete comparisons in `evidence.json`. Revision metadata is the producer’s assertion. The producer must run the comparison on those revisions before attaching their IDs. A lead can support a candidate after verification and challenge.

### API compatibility

Run oasdiff with JSON output, using repository-relative paths or git-revision inputs. In a trusted job that already resolved and checked out the revisions, create the envelope as follows.

```sh
oasdiff breaking "$base:api.yaml" "$head:api.yaml" --format json > changes.json
jq -n --arg base "$base" --arg head "$head" --slurpfile data changes.json \
  '{base:$base,head:$head,reports:[{format:"oasdiff",data:$data[0]}]}' > comparisons.json
```

The adapter accepts breaking levels 2 and 3 with a revision source matching an added line or a deletion site. The evidence identifies the operation, endpoint, compatibility rule and changed element. A base-only location must identify a removed line with a surviving head-side deletion site in the full diff. Other unmapped locations are inconclusive. Verify which callers rely on the affected contract.

### New clone pairs

Use `jscpd` JSON with a baseline built from the same base revision and project-relative paths. Set the report entry to `{"format":"jscpd","data":<jscpd-report.json object>}`. The adapter uses the detector’s `isNew` classification and retains both ranges when a new pair intersects added code. Verify that the original covers the new inputs and edge cases and that keeping both copies has a concrete maintenance consequence.

### Paired benchmark samples

Use the following entry inside the same envelope. Populate each side from independent samples collected using the named test environment.

```json
{"format":"benchmark-v1","data":[{
  "base":{"name":"lookup","metric":"latency","unit":"us","runner":"linux-a","samples":[10,11,12]},
  "head":{"name":"lookup","metric":"latency","unit":"us","runner":"linux-a","samples":[20,21,22]},
  "direction":"lower","thresholdPercent":15,
  "location":{"path":"src/cache.ts","line":31}
}]}
```

Use `higher` for throughput and `lower` for latency. Each side needs 3–100 positive finite samples with the same name, metric, unit and runner. A lead requires disjoint sample ranges and a median degradation at or above the supplied percentage. This noise filter makes no statistical significance claim. A regression without a changed source location stays in the local notes. The verifier must connect the measured workload to the proposed cause.
