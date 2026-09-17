"""Evaluate Jev's decisions against RouterBench's precomputed outcomes.

Two views:
  1. The as-shipped operating point over a 3-model ladder (one point).
  2. A swept strong/weak router over the full probability vector (a curve), which is what
     AIQ and RouteLLM's APGR require.
"""
import argparse, io, json, sys

import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# Ladder chosen from the Pareto frontier of the full dataset: routing to a dominated model
# (cheaper AND better alternative exists) is never rational, so only non-dominated models
# are eligible. mixtral < Yi-34B < gpt-4 on both cost and mean score.
LADDER = {
    "haiku": "mistralai/mixtral-8x7b-chat",
    "sonnet": "zero-one-ai/Yi-34B-Chat",
    "opus": "gpt-4-1106-preview",
    "fable": "gpt-4-1106-preview",
}
WEAK, STRONG = "mistralai/mixtral-8x7b-chat", "gpt-4-1106-preview"

ALL_MODELS = [
    "WizardLM/WizardLM-13B-V1.2", "claude-instant-v1", "claude-v1", "claude-v2",
    "gpt-3.5-turbo-1106", "gpt-4-1106-preview", "meta/code-llama-instruct-34b-chat",
    "meta/llama-2-70b-chat", "mistralai/mistral-7b-chat",
    "mistralai/mixtral-8x7b-chat", "zero-one-ai/Yi-34B-Chat",
]


def read_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def non_decreasing_hull(points):
    """Upper-left convex hull, monotone in cost. Mirrors RouterBench's AIQ construction."""
    pts = sorted(points)
    hull = []
    for x, y in pts:
        if hull and x == hull[-1][0]:
            if y > hull[-1][1]:
                hull[-1] = (x, y)
            continue
        if hull and y <= hull[-1][1]:
            continue
        hull.append((x, y))
    return hull


def aiq(points):
    """Normalized area under the non-decreasing hull, extended to the max cost observed."""
    hull = non_decreasing_hull(points)
    if len(hull) < 2:
        return float("nan")
    xs = np.array([p[0] for p in hull])
    ys = np.array([p[1] for p in hull])
    return float(np.trapezoid(ys, xs) / (xs.max() - xs.min())) if xs.max() > xs.min() else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", default="data/sample_p0.jsonl")
    ap.add_argument("--decisions", default="data/decisions_p0.jsonl")
    ap.add_argument("--policy", default="data/policy_p0.jsonl")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    sample = {r["id"]: r for r in read_jsonl(args.sample)}
    decisions = {r["id"]: r for r in read_jsonl(args.decisions)}
    policy = {r["id"]: r for r in read_jsonl(args.policy)}
    ids = [i for i in sample if i in decisions and i in policy]
    n = len(ids)
    print(f"evaluating {n} prompts\n")

    # ---- fixed-model baselines -------------------------------------------------
    print("Fixed models (whole sample):")
    print(f"  {'model':<40} {'score':>8} {'cost':>12}")
    fixed = {}
    for m in ALL_MODELS:
        s = np.mean([sample[i]["scores"][m] for i in ids])
        c = np.mean([sample[i]["costs"][m] for i in ids])
        fixed[m] = (c, s)
        print(f"  {m:<40} {s:>8.4f} {c:>12.6f}")

    # ---- oracle & random -------------------------------------------------------
    ladder_models = [LADDER["haiku"], LADDER["sonnet"], LADDER["opus"]]
    orc_s, orc_c = [], []
    for i in ids:
        best = None
        for m in ladder_models:  # cheapest first
            if sample[i]["scores"][m] >= 1.0:
                best = m
                break
        if best is None:
            best = max(ladder_models, key=lambda m: sample[i]["scores"][m])
        orc_s.append(sample[i]["scores"][best])
        orc_c.append(sample[i]["costs"][best])
    print(f"\n  {'ORACLE (cheapest correct in ladder)':<40} {np.mean(orc_s):>8.4f} {np.mean(orc_c):>12.6f}")

    # ---- as-shipped operating point -------------------------------------------
    sh_s, sh_c, tiers = [], [], {}
    for i in ids:
        t = policy[i]["tier"]
        m = LADDER[t]
        tiers[t] = tiers.get(t, 0) + 1
        sh_s.append(sample[i]["scores"][m])
        sh_c.append(sample[i]["costs"][m])
    shipped = (float(np.mean(sh_c)), float(np.mean(sh_s)))
    print(f"\nAs-shipped jev-router (3-tier ladder): score={shipped[1]:.4f} cost={shipped[0]:.6f}")
    print(f"  tier mix: {tiers}")

    # 3-tier ladder penalises Jev wherever the middle model is not actually mid-ranked on
    # that task type (Yi-34B is worse than Mixtral at code). The strong/weak collapse avoids
    # that confound, so it is the fairer headline point.
    two_s, two_c, n_strong = [], [], 0
    for i in ids:
        m = WEAK if policy[i]["tier"] == "haiku" else STRONG
        n_strong += m == STRONG
        two_s.append(sample[i]["scores"][m])
        two_c.append(sample[i]["costs"][m])
    print(f"\nAs-shipped jev-router (strong/weak collapse): score={np.mean(two_s):.4f} "
          f"cost={np.mean(two_c):.6f}  strong={n_strong}/{n} ({n_strong/n:.1%})")
    # What does random routing at the same strong-call fraction achieve?
    rng0 = np.random.default_rng(args.seed)
    reps = []
    for _ in range(200):
        pick = set(rng0.choice(ids, size=n_strong, replace=False).tolist())
        reps.append(np.mean([sample[i]["scores"][STRONG if i in pick else WEAK] for i in ids]))
    print(f"  random at same strong fraction: score={np.mean(reps):.4f} "
          f"[{np.percentile(reps,2.5):.4f}, {np.percentile(reps,97.5):.4f}]")

    # ---- swept strong/weak router (curve) --------------------------------------
    # Routing score = probability the task needs more than the cheapest tier.
    need = {}
    for i in ids:
        p = decisions[i]["probabilities"] or {}
        need[i] = 1.0 - float(p.get("haiku", 0.0))

    def arm(route_strong):
        s = [sample[i]["scores"][STRONG if route_strong[i] else WEAK] for i in ids]
        c = [sample[i]["costs"][STRONG if route_strong[i] else WEAK] for i in ids]
        return float(np.mean(c)), float(np.mean(s))

    jev_curve, rand_curve = [], []
    rng = np.random.default_rng(args.seed)
    order = sorted(ids, key=lambda i: -need[i])
    for k in range(0, n + 1, max(1, n // 40)):
        chosen = set(order[:k])
        jev_curve.append(arm({i: i in chosen for i in ids}))
        rnd = set(rng.choice(ids, size=k, replace=False).tolist()) if k else set()
        rand_curve.append(arm({i: i in rnd for i in ids}))

    weak_pt, strong_pt = fixed[WEAK], fixed[STRONG]
    print(f"\nStrong/weak pair: {STRONG} vs {WEAK}")
    print(f"  weak:   score={weak_pt[1]:.4f} cost={weak_pt[0]:.6f}")
    print(f"  strong: score={strong_pt[1]:.4f} cost={strong_pt[0]:.6f}")
    print(f"  AIQ jev   = {aiq(jev_curve):.6f}")
    print(f"  AIQ random= {aiq(rand_curve):.6f}")

    print("\n  frac_strong |  jev score   cost    | random score   cost")
    for idx in range(0, len(jev_curve), max(1, len(jev_curve) // 10)):
        k = idx * max(1, n // 40)
        jc, js = jev_curve[idx]
        rc, rs = rand_curve[idx]
        print(f"   {k/n:>9.2f}  |  {js:.4f}  {jc:.6f} |  {rs:.4f}  {rc:.6f}")

    # APGR at the as-shipped fraction of strong calls
    span = strong_pt[1] - weak_pt[1]
    print(f"\n  APGR (jev curve, at 50% strong) = ", end="")
    mid = jev_curve[len(jev_curve) // 2]
    print(f"{(mid[1] - weak_pt[1]) / span:.4f}" if span else "n/a")

    # ---- per-family breakdown --------------------------------------------------
    print("\nPer-family as-shipped tier mix and score:")
    fams = sorted({sample[i]["family"] for i in ids})
    print(f"  {'family':<20} {'n':>4} {'tiers':<28} {'jev':>7} {'weak':>7} {'strong':>7}")
    for f in fams:
        fi = [i for i in ids if sample[i]["family"] == f]
        tm = {}
        for i in fi:
            tm[policy[i]["tier"]] = tm.get(policy[i]["tier"], 0) + 1
        js = np.mean([sample[i]["scores"][LADDER[policy[i]["tier"]]] for i in fi])
        ws = np.mean([sample[i]["scores"][WEAK] for i in fi])
        ss = np.mean([sample[i]["scores"][STRONG] for i in fi])
        print(f"  {f:<20} {len(fi):>4} {str(tm):<28} {js:>7.4f} {ws:>7.4f} {ss:>7.4f}")


if __name__ == "__main__":
    main()
