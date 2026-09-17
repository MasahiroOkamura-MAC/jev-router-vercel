"""Rank candidate routing signals on the same label, same split.

If the useful signal is a property of the model pool rather than the prompt, then a router
that sees only the benchmark family name -- and nothing of the question itself -- should
beat a zero-shot semantic difficulty judge. That is the hypothesis this tests.
"""
import argparse, io, json, sys

import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

WEAK, STRONG = "mistralai/mixtral-8x7b-chat", "gpt-4-1106-preview"


def read_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def auc(scores, labels):
    pos = np.array([s for s, l in zip(scores, labels) if l], dtype=float)
    neg = np.array([s for s, l in zip(scores, labels) if not l], dtype=float)
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    # Rank-based Mann-Whitney U, O(n log n) so this scales past the P0 sample.
    allv = np.concatenate([pos, neg])
    order = allv.argsort()
    ranks = np.empty(len(allv), dtype=float)
    ranks[order] = np.arange(1, len(allv) + 1)
    _, inv, counts = np.unique(allv, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts))
    np.add.at(sums, inv, ranks)
    ranks = (sums / counts)[inv]
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def bootstrap_auc(scores, labels, n=1000, seed=0):
    rng = np.random.default_rng(seed)
    s, l = np.array(scores, dtype=float), np.array(labels)
    out = []
    for _ in range(n):
        idx = rng.integers(0, len(s), len(s))
        if 0 < l[idx].sum() < len(idx):
            out.append(auc(s[idx], l[idx]))
    return (np.percentile(out, 2.5), np.percentile(out, 97.5)) if out else (float("nan"),) * 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", default="data/sample_p1.jsonl")
    ap.add_argument("--shipped", default="data/decisions_p1.jsonl")
    ap.add_argument("--pool", default="data/decisions_pool_p1.jsonl")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    sample = {r["id"]: r for r in read_jsonl(args.sample)}
    shipped = {r["id"]: r for r in read_jsonl(args.shipped)}
    try:
        pool = {r["id"]: r for r in read_jsonl(args.pool)}
    except FileNotFoundError:
        pool = {}

    ids = [i for i in sample if i in shipped and shipped[i]["probabilities"]]
    if pool:
        ids = [i for i in ids if i in pool and pool[i]["probabilities"]]
    print(f"n = {len(ids)}")

    rng = np.random.default_rng(args.seed)
    mask = rng.random(len(ids)) < 0.5
    train = [i for i, m in zip(ids, mask) if m]
    test = [i for i, m in zip(ids, mask) if not m]
    print(f"train = {len(train)}, test = {len(test)}\n")

    worth = lambda i: 1 if (sample[i]["scores"][WEAK] < 1.0 and sample[i]["scores"][STRONG] >= 1.0) else 0
    weakfail = lambda i: 1 if sample[i]["scores"][WEAK] < 1.0 else 0

    # Family-mean router: fit escalation rate per family on train, apply to test.
    fam_rate_worth, fam_rate_fail = {}, {}
    for f in {sample[i]["family"] for i in ids}:
        tr = [i for i in train if sample[i]["family"] == f]
        fam_rate_worth[f] = np.mean([worth(i) for i in tr]) if tr else 0.0
        fam_rate_fail[f] = np.mean([weakfail(i) for i in tr]) if tr else 0.0

    def shipped_need(i):
        p = shipped[i]["probabilities"]
        return 1.0 - float(p.get("haiku", 0.0))

    def pool_need(i):
        p = pool[i]["probabilities"]
        return float(p.get("strong", 0.0))

    signals = {
        "Jev (shipped question)": shipped_need,
        "prompt length": lambda i: len(sample[i]["prompt"]),
        "family mean rate (trained)": lambda i: fam_rate_worth[sample[i]["family"]],
    }
    if pool:
        signals["Jev (pool-calibrated)"] = pool_need

    for label_name, label_fn, fam_lookup in [
        ("escalation worth it (weak wrong, strong right)", worth, fam_rate_worth),
        ("weak model fails", weakfail, fam_rate_fail),
    ]:
        labels = [label_fn(i) for i in test]
        print(f"AUC -> {label_name}   [base rate {np.mean(labels):.3f}]")
        print(f"  {'signal':<30} {'AUC':>7}  {'95% CI':>18}")
        rows = []
        for name, fn in signals.items():
            f = (lambda i: fam_lookup[sample[i]["family"]]) if "family" in name else fn
            scores = [f(i) for i in test]
            a = auc(scores, labels)
            lo, hi = bootstrap_auc(scores, labels, seed=args.seed)
            rows.append((a, name, lo, hi))
        for a, name, lo, hi in sorted(rows, reverse=True):
            print(f"  {name:<30} {a:>7.4f}  [{lo:.4f}, {hi:.4f}]")
        print()


if __name__ == "__main__":
    main()
