"""Export a stratified prompt sample from RouterBench to JSONL for the Jev decision pass."""
import argparse, ast, io, json, sys

import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

MODELS = [
    "WizardLM/WizardLM-13B-V1.2", "claude-instant-v1", "claude-v1", "claude-v2",
    "gpt-3.5-turbo-1106", "gpt-4-1106-preview", "meta/code-llama-instruct-34b-chat",
    "meta/llama-2-70b-chat", "mistralai/mistral-7b-chat",
    "mistralai/mixtral-8x7b-chat", "zero-one-ai/Yi-34B-Chat",
]


def family(eval_name: str) -> str:
    """Collapse the 57 mmlu subject splits into one family so strata stay balanced."""
    return "mmlu" if eval_name.startswith("mmlu") else eval_name


def unwrap(prompt):
    """RouterBench stores prompts as the repr of a one-element Python list."""
    if isinstance(prompt, str) and prompt.startswith("[") and prompt.endswith("]"):
        try:
            parsed = ast.literal_eval(prompt)
            if isinstance(parsed, list):
                return "\n\n".join(str(p) for p in parsed)
        except (ValueError, SyntaxError):
            pass
    return str(prompt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/routerbench_0shot.pkl")
    ap.add_argument("--n", type=int, default=200, help="total prompts to sample")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="data/sample.jsonl")
    ap.add_argument("--families", type=int, default=6, help="number of largest families to use")
    args = ap.parse_args()

    df = pd.read_pickle(args.data)
    df["family"] = df["eval_name"].map(family)

    keep = df["family"].value_counts().head(args.families).index.tolist()
    df = df[df["family"].isin(keep)]

    # Equal allocation per family: the population is dominated by hellaswag, and we care
    # about behaviour across task types rather than reproducing RouterBench's task mix.
    per = args.n // len(keep)
    parts = [
        df[df["family"] == f].sample(n=min(per, (df["family"] == f).sum()), random_state=args.seed)
        for f in keep
    ]
    sample = pd.concat(parts).reset_index(drop=True)

    with open(args.out, "w", encoding="utf-8") as fh:
        for _, row in sample.iterrows():
            fh.write(json.dumps({
                "id": row["sample_id"],
                "family": row["family"],
                "eval_name": row["eval_name"],
                "prompt": unwrap(row["prompt"]),
                "scores": {m: float(row[m]) for m in MODELS},
                "costs": {m: float(row[f"{m}|total_cost"]) for m in MODELS},
                "oracle": row["oracle_model_to_route_to"],
            }) + "\n")

    print(f"wrote {len(sample)} prompts to {args.out}")
    print(sample["family"].value_counts().to_string())


if __name__ == "__main__":
    main()
