# RouterBench evaluation

Result of evaluating Jev's routing decisions against
[RouterBench](https://arxiv.org/abs/2403.12031) (Hu et al., 2024).

**Headline: this is a negative result for the benchmark, and a partial positive result for
Jev.** At its shipped operating point the router is statistically indistinguishable from
random routing on RouterBench. The diagnostics show why, and the reason is a property of
the benchmark's model pool rather than of Jev's judgment.

Run date: 2026-09-17. Dataset `routerbench_0shot.pkl` (36,497 prompts × 11 models).
Sample: 1,800 prompts, 300 each from six families, seed 0.

## What was measured

RouterBench scores a router over *its own* pool of 11 models, all from 2023: Mixtral-8x7B,
Mistral-7B, CodeLlama-34B, WizardLM-13B, Yi-34B, Llama-2-70B, GPT-3.5, GPT-4-1106, and three
Claude v1/v2 models. `jev-router` routes among Claude Haiku/Sonnet/Opus, so the pools do not
overlap and the router cannot be evaluated directly.

Jev's tier output was therefore mapped onto a cost-ranked ladder drawn from RouterBench's
Pareto frontier:

| Jev tier | RouterBench model | mean score | cost/req |
| --- | --- | --- | --- |
| `haiku` | Mixtral-8x7B | 0.5678 | $0.000122 |
| `sonnet` | Yi-34B-Chat | 0.6279 | $0.000168 |
| `opus` | GPT-4-1106-preview | 0.7986 | $0.003841 |

This measures **Jev's difficulty discrimination**, not the shipped product. No agentic
behaviour, tool use, multi-turn context or prompt caching is exercised.

## Result 1 — at the shipped operating point, routing is no better than random

Collapsing to a strong/weak pair (GPT-4 vs Mixtral-8x7B, as in RouteLLM) to avoid the
three-tier ladder's confound:

| Router | Score | Cost/req | Strong calls |
| --- | --- | --- | --- |
| Weak only (Mixtral-8x7B) | 0.5678 | $0.000122 | 0% |
| **jev-router as shipped** | **0.5906** | **$0.001383** | **12.6%** |
| Random at the same 12.6% | 0.5968 [0.5885, 0.6054] | $0.001383 | 12.6% |
| Strong only (GPT-4) | 0.7986 | $0.003841 | 100% |
| Oracle (cheapest correct) | 0.8676 | $0.000830 | — |

Jev's score falls **inside** random's 95% interval. It pays 11× the weak-only cost for
+0.023 score, which random routing matches.

Cost-normalized over a full sweep, Jev is behind random:

```
AIQ (jev)    = 0.6458
AIQ (random) = 0.6859
```

The sweep does show real ranking ability, but only on the call-count axis. At an equal
*fraction* of strong calls Jev beats random at every point from 30% to 80%:

| Frac strong | Jev score | Jev cost | Random score | Random cost |
| --- | --- | --- | --- | --- |
| 0.30 | 0.6438 | 0.002141 | 0.6407 | 0.001260 |
| 0.40 | 0.6821 | 0.002453 | 0.6543 | 0.001608 |
| 0.50 | 0.7061 | 0.002957 | 0.6857 | 0.001954 |
| 0.60 | 0.7231 | 0.003346 | 0.7028 | 0.002404 |

It loses on the cost axis because `corr(Jev escalation score, GPT-4 cost) = 0.71` — Jev
escalates *long* prompts, and long prompts are the expensive ones. Escalating a long prompt
costs disproportionately more than escalating a short one.

## Result 2 — Jev detects difficulty, but difficulty is not escalation value

Two labels, same prompts, same 50/50 split, AUC with bootstrap CIs (n=914 test):

**"Will the weak model fail?"** — intrinsic difficulty:

| Signal | AUC | 95% CI |
| --- | --- | --- |
| Family label only (trained) | 0.7516 | [0.7200, 0.7809] |
| **Jev (pool-calibrated question)** | **0.7257** | [0.6931, 0.7581] |
| Prompt length | 0.6492 | [0.6131, 0.6861] |
| Jev (shipped question) | 0.6352 | [0.6010, 0.6720] |

**"Is escalation worth it?"** — weak model wrong *and* strong model right, the label routing
actually depends on:

| Signal | AUC | 95% CI |
| --- | --- | --- |
| **Family label only (trained)** | **0.7141** | [0.6802, 0.7476] |
| Jev (shipped question) | 0.5511 | [0.5081, 0.5947] |
| Jev (pool-calibrated question) | 0.4675 | [0.4305, 0.5060] |
| Prompt length | 0.4636 | [0.4196, 0.5038] |

Jev has a clear difficulty signal — AUC 0.726, well ahead of the prompt-length baseline —
but that signal carries almost nothing about whether escalating pays off.

A router shown **only the benchmark family name**, and nothing whatsoever of the question,
scores 0.714 on the escalation label. That is the finding: on RouterBench, escalation value
is mostly a property of *which benchmark a prompt came from*, not of the prompt.

Two families show this directly:

| Family | Weak | Strong | Gap | Escalation worth it |
| --- | --- | --- | --- | --- |
| hellaswag | 0.3733 | 0.8333 | 0.4600 | 0.636 |
| grade-school-math | 0.5100 | 0.6683 | 0.1583 | 0.000 |

- **HellaSwag** is sentence completion. It looks trivial, so Jev rates it easy — but 2023-era
  Mixtral is catastrophically bad at it while GPT-4 is fine, so it is the single most
  valuable family to escalate. Jev routed 300/300 to the weak model.
- **GSM8K** is genuinely hard, and Jev detects that best of any family (AUC 0.875 on "weak
  fails"). But GPT-4-1106 is also bad at it, so escalating never pays — `worth_rate = 0.000`.
  Jev's *best* difficulty detection produced its *least* useful routing.

This is why RouterBench's own KNN/MLP/SVM baselines are trained on the pool's outcomes: they
learn "hellaswag → escalate" empirically. A zero-shot semantic difficulty judge structurally
cannot know that, because it is a fact about Mixtral, not about the question.

## Why this does not straightforwardly condemn the product

Semantically, `haiku` in Jev's question means "trivial for Claude Haiku 4.5". Mapping that to
Mixtral-8x7B assumes the two have comparable ability, and they do not — Haiku 4.5 outperforms
GPT-4-1106 on most of these tasks. "Trivial for Haiku 4.5" genuinely does not imply "Mixtral
can do it", so the mapping is semantically strained no matter how it is drawn.

`jev-router` ships against Haiku 4.5 / Sonnet 4.6 / Opus 4.6 — one family, a far more
monotone capability ordering, and far less scope for the HellaSwag anomaly where the weak
model collapses on a task that looks easy. **That is a hypothesis, not a result.** Nothing
here measures it.

## What carries over to the product

1. **Escalating long prompts is disproportionately expensive** (`corr = 0.71`). Our policy
   guards downgrades on large contexts but does not guard upgrades. Worth revisiting.
2. **Measure escalation value, not difficulty.** The right label is "cheap tier fails *and*
   expensive tier succeeds". Difficulty alone is the wrong target, and the two came apart
   completely here.
3. **Always report random-at-the-same-call-fraction.** It is the baseline that showed the
   headline gain was not real.
4. **Prompt length is a serious free baseline** (AUC 0.649 on difficulty). Any future claim
   has to beat it.

## Honest limitations

- Six families, 300 each; equal allocation, not RouterBench's natural task mix, so these are
  not comparable to published RouterBench leaderboard numbers.
- Single run, no seed variation on the Jev calls.
- The three-tier ladder is invalid per-family: Yi-34B is worse than Mixtral at MBPP, so the
  three-tier as-shipped score (0.5464) understates Jev. The strong/weak collapse avoids this
  and is the number quoted above.
- The pool-calibrated question is a secondary, clearly-labelled variant written for this
  benchmark. The shipped question is the primary result. Neither was tuned against the test
  split, and the shipped question was not modified.
- RouterBench has no prompt caching in its cost model; caching dominates real Claude Code
  cost.

## Reproducing

See `README.md` in this directory.
