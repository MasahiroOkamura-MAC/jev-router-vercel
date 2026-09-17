import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import pandas as pd

df = pd.read_pickle("data/routerbench_0shot.pkl")

MODELS = [
    "WizardLM/WizardLM-13B-V1.2", "claude-instant-v1", "claude-v1", "claude-v2",
    "gpt-3.5-turbo-1106", "gpt-4-1106-preview", "meta/code-llama-instruct-34b-chat",
    "meta/llama-2-70b-chat", "mistralai/mistral-7b-chat",
    "mistralai/mixtral-8x7b-chat", "zero-one-ai/Yi-34B-Chat",
]

print("rows:", len(df))
print("\nper-model mean score and mean cost (whole dataset):")
print(f"{'model':<40} {'score':>8} {'cost/req':>12}")
for m in MODELS:
    s = pd.to_numeric(df[m], errors="coerce")
    c = df[f"{m}|total_cost"]
    print(f"{m:<40} {s.mean():>8.4f} {c.mean():>12.6f}")

print("\nscore value distribution (gpt-4):")
print(pd.to_numeric(df["gpt-4-1106-preview"], errors="coerce").describe())

print("\noracle_model_to_route_to top:")
print(df["oracle_model_to_route_to"].value_counts().head(12))

print("\ntop eval_name groups:")
print(df["eval_name"].value_counts().head(12))

mmlu = df[df["eval_name"].str.startswith("mmlu")]
print(f"\nmmlu* rows: {len(mmlu)}  distinct eval_name: {mmlu['eval_name'].nunique()}")
print("\nexample prompt (mmlu, truncated):")
print(repr(mmlu.iloc[0]["prompt"])[:600])
