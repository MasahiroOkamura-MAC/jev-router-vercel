# bench

Evaluation harness for Jev's routing decisions against
[RouterBench](https://github.com/withmartian/routerbench).

Findings are in [RESULTS.md](RESULTS.md).

## Design

The expensive Jev pass runs **once** and is cached to JSONL. Everything downstream — policy
application, threshold sweeps, metrics — replays that cache offline and for free.

The pass calls the real shipped `src/router.mjs` and `src/policy.mjs`, so the benchmark
measures the code we ship rather than a reimplementation of it.

```
export_sample.py  ->  decide.mjs     ->  apply_policy.mjs  ->  evaluate.py
 (stratified          (Jev, network,      (shipped policy,      (cost/quality,
  sample)              cached)             offline)              AIQ, APGR)
                                                            ->  diagnose.py  (signal check)
                                                            ->  compare.py   (signal ranking)
```

## Setup

```bash
cd bench
python -m venv .venv
.venv/Scripts/python -m pip install pandas numpy          # Windows
curl -L https://huggingface.co/datasets/withmartian/routerbench/resolve/main/routerbench_0shot.pkl \
  -o data/routerbench_0shot.pkl
```

`JEV_API_KEY` is read from `~/.jev-claude.env`, `bench/.env` or the repo `.env`.

> The dataset ships as a pickle, which executes arbitrary code on load. It is loaded here
> from a known source into a throwaway venv; treat it accordingly.

## Running

```bash
.venv/Scripts/python export_sample.py --n 1800 --out data/sample_p1.jsonl

node decide.mjs      --in=data/sample_p1.jsonl --out=data/decisions_p1.jsonl --concurrency=10
node decide_pool.mjs --in=data/sample_p1.jsonl --out=data/decisions_pool_p1.jsonl --concurrency=10

node apply_policy.mjs --sample=data/sample_p1.jsonl --decisions=data/decisions_p1.jsonl \
                      --out=data/policy_p1.jsonl

.venv/Scripts/python evaluate.py --sample=data/sample_p1.jsonl \
    --decisions=data/decisions_p1.jsonl --policy=data/policy_p1.jsonl
.venv/Scripts/python compare.py
.venv/Scripts/python diagnose.py --decisions data/decisions_pool_p1.jsonl
```

Both decision passes are resumable — ids already present in the output file are skipped, so
an interrupted run can simply be re-issued.

Throughput measured at ~30 decisions/sec at concurrency 10, so the full 36,497-prompt
dataset is about 20 minutes.

## Scripts

| File | Purpose |
| --- | --- |
| `inspect_data.py` | Dataset overview: per-model score/cost, eval families, oracle column |
| `export_sample.py` | Stratified sample, equal allocation across the six largest families |
| `decide.mjs` | Jev pass using the **shipped** question (primary result) |
| `decide_pool.mjs` | Jev pass using a **pool-calibrated** question (secondary, labelled) |
| `apply_policy.mjs` | Replays cached decisions through the shipped policy, offline |
| `evaluate.py` | Fixed-model baselines, oracle, operating point, AIQ, APGR, sweep |
| `diagnose.py` | Is there signal? AUC, length correlation, per-family breakdown |
| `compare.py` | Ranks routing signals against each other on a held-out split |

`data/` and `.venv/` are gitignored.

## Live cost accounting

RouterBench measures decision quality on single-turn QA. It cannot measure what routing
actually saves, because savings depend on the prompt cache and multi-turn context growth that
a QA dataset has none of. That needs measurement on real sessions.

```
$env:JEV_USAGE="1"; jev-claude       # use Claude Code normally
node bench/usage_report.mjs          # summarise ~/.jev-claude-usage.jsonl
```

The proxy reads the four token classes back off the wire (`input`, `cache_read`,
`cache_creation`, `output`) and prices each separately, because a tier switch invalidates the
prompt cache and turns cheap cache reads into 12.5x more expensive cache writes. A blended
per-token rate would hide the single effect most likely to make routing lose money.

The report''s counterfactual reprices the *same* token counts at a fixed baseline model. That
is an approximation, not a measured total: a different model would have emitted a different
number of output tokens and would not have paid the switch penalty. Treat it as an input-side
bound.
