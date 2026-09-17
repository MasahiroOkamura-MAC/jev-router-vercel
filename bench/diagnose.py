"""Does Jev's difficulty score carry signal about escalation, independent of the ladder?

The ladder mapping and the cost axis both confound the headline AIQ number. This isolates
the question: does Jev's score rank the prompts where the weak model actually fails?
"""
import argparse, io, json, sys

import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

WEAK, STRONG = "mistralai/mixtral-8x7b-chat", "gpt-4-1106-preview"


def read_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def auc(scores, labels):
    """Mann-Whitney AUC: P(score of a positive > score of a negative), ties at 0.5."""
    pos = [s for s, l in zip(scores, labels) if l]
    neg = [s for s, l in zip(scores, labels) if not l]
    if not pos or not neg:
        return float("nan")
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", default="data/sample_p0.jsonl")
    ap.add_argument("--decisions", default="data/decisions_p0.jsonl")
    args = ap.parse_args()

    sample = {r["id"]: r for r in read_jsonl(args.sample)}
    dec = {r["id"]: r for r in read_jsonl(args.decisions)}
    ids = [i for i in sample if i in dec and dec[i]["probabilities"]]

    need = {}
    for i in ids:
        p = dec[i]["probabilities"]
        # Shipped question emits claude tiers; the pool-calibrated variant emits weak/strong.
        need[i] = float(p["strong"]) if "strong" in p else 1.0 - float(p.get("haiku", 0.0))

    # Label 1: escalation is *worth it* — weak fails, strong succeeds.
    worth = [1 if (sample[i]["scores"][WEAK] < 1.0 and sample[i]["scores"][STRONG] >= 1.0) else 0 for i in ids]
    # Label 2: weak model simply fails (regardless of strong).
    weakfail = [1 if sample[i]["scores"][WEAK] < 1.0 else 0 for i in ids]

    s = [need[i] for i in ids]
    print(f"n = {len(ids)}")
    print(f"  base rate, escalation worth it : {np.mean(worth):.3f}")
    print(f"  base rate, weak model fails    : {np.mean(weakfail):.3f}")
    print()
    print(f"  AUC(need -> escalation worth it) = {auc(s, worth):.4f}   (0.5 = no signal)")
    print(f"  AUC(need -> weak model fails)    = {auc(s, weakfail):.4f}")

    # Is the score just measuring prompt length?
    lens = [len(sample[i]["prompt"]) for i in ids]
    costs = [sample[i]["costs"][STRONG] for i in ids]
    print()
    print(f"  corr(need, prompt length) = {np.corrcoef(s, lens)[0,1]:.4f}")
    print(f"  corr(need, strong cost)   = {np.corrcoef(s, costs)[0,1]:.4f}")
    print(f"  AUC(length -> weak fails) = {auc(lens, weakfail):.4f}")

    # Per-family: is the signal there but swamped by between-family variance?
    print("\nPer-family AUC (within-family signal):")
    print(f"  {'family':<20} {'n':>4} {'worth_rate':>11} {'AUC_worth':>10} {'AUC_weakfail':>13}")
    for f in sorted({sample[i]["family"] for i in ids}):
        fi = [i for i in ids if sample[i]["family"] == f]
        fs = [need[i] for i in fi]
        fw = [1 if (sample[i]["scores"][WEAK] < 1.0 and sample[i]["scores"][STRONG] >= 1.0) else 0 for i in fi]
        fwf = [1 if sample[i]["scores"][WEAK] < 1.0 else 0 for i in fi]
        print(f"  {f:<20} {len(fi):>4} {np.mean(fw):>11.3f} {auc(fs, fw):>10.4f} {auc(fs, fwf):>13.4f}")

    # Where does the weak model stand vs the strong one per family?
    print("\nCapability gap by family (why the pool matters):")
    print(f"  {'family':<20} {'weak':>7} {'strong':>7} {'gap':>7}")
    for f in sorted({sample[i]["family"] for i in ids}):
        fi = [i for i in ids if sample[i]["family"] == f]
        w = np.mean([sample[i]["scores"][WEAK] for i in fi])
        st = np.mean([sample[i]["scores"][STRONG] for i in fi])
        print(f"  {f:<20} {w:>7.4f} {st:>7.4f} {st-w:>7.4f}")

    # Distribution of Jev's raw choice
    print("\nJev raw choice distribution:")
    ch = {}
    for i in ids:
        ch[dec[i]["choice"]] = ch.get(dec[i]["choice"], 0) + 1
    print(" ", ch)
    print(f"  need score: mean={np.mean(s):.4f} std={np.std(s):.4f} min={min(s):.4f} max={max(s):.4f}")


if __name__ == "__main__":
    main()
