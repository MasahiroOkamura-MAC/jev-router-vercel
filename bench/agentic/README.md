# bench/agentic

Automated evaluation of Jev's routing decisions on **real agentic turns**, with an
LLM-as-a-judge supplying the labels.

RouterBench (in `../`) measures single-turn QA and [did not
transfer](../RESULTS.md). This measures the thing the product actually does: a developer
prompt, in a real repository, with real tools.

## The question

Routing is only worth anything if escalation is worth something *on the turns it escalates*.
So the label is not "was this task hard" but:

> did the expensive tier produce a **materially** better answer than the cheap one?

Those are not the same thing, and conflating them is what sank the RouterBench run: Jev
detected difficulty well (AUC 0.73) while difficulty and escalation value were nearly
decorrelated.

## Pipeline

Each stage writes JSONL and skips work already recorded, so any stage can be interrupted and
resumed. That is not a nicety: a full run will hit a subscription usage limit.

```
node bench/agentic/harvest.mjs                 # transcripts   -> tasks.jsonl
node bench/agentic/generate.mjs --per-repo 24  # repos         -> tasks.jsonl  (appends)
node bench/agentic/screen.mjs                  # marks which harvested prompts stand alone
node bench/agentic/replay.mjs                  # tasks x tiers -> replays.jsonl
node bench/agentic/judge.mjs                   # replay pairs  -> verdicts.jsonl
node bench/agentic/decide.mjs                  # tasks         -> decisions.jsonl
node bench/agentic/score.mjs                   # the scoreboard
```

`decide.mjs` imports `src/router.mjs` and `src/policy.mjs` directly, so the scoreboard grades
the code that ships rather than a reimplementation of it.

## Three things that make the numbers trustworthy

**The tier is verified, not requested.** `claude --model haiku` does not do what it looks like
it does: on a Pro subscription it silently falls back, and reports `claude-sonnet-4-6` in its
own `modelUsage`. A harness built on it would have compared Sonnet to Sonnet and found no
difference. Replays instead pin the tier with `JEV_FORCE_TIER` in the proxy, and every row
carries `served`, the model name the API itself echoed back, plus a `tierVerified` flag.
Unverified replays are dropped before judging.

**Every pair is judged twice, with the answers swapped.** A verdict counts only when both
orderings name the same *answer*; otherwise the pair is recorded as `unstable` and folded in
with the ties. Position bias and most verbosity bias then surface as disagreement between the
two orderings instead of as a silent thumb on the scale, and the stability rate is printed so
the judge can be audited rather than trusted.

**The judge is asked the right question.** Not "which is better" — a judge asked to pick a
winner will always find one — but whether one answer is *materially* better: correct where the
other is wrong, or containing something whose absence would lead a competent engineer to do
the wrong thing next. Style, length, formatting and confidence are explicitly excluded, and the
rubric says most pairs are ties.

## The baseline that matters

Not always-strong. **Random escalation at the same rate.** A router that escalates 40% of
turns will beat never escalating; the question is whether it beats a coin weighted to escalate
40% of the time. On RouterBench, a headline gain of +0.023 turned out to sit inside the
random baseline's confidence interval. `score.mjs` reports `P(random >= jev)` for exactly this
reason, alongside prompt length, which is a free signal any router has to beat.

## Safety

Replays run agents in real repositories, so they run in `--permission-mode plan` with
`Edit`, `Write`, `NotebookEdit`, `Bash`, `WebFetch` and `WebSearch` denied. Plan mode alone
would do it; the deny list is a second barrier in case a future Claude Code release changes
what plan mode permits. Read, Glob and Grep stay enabled, so the agent genuinely explores the
codebase.

## Known limitations

- **Single turn.** Transcripts record rendered messages but not the system prompt or tool
  schemas, so a mid-conversation prompt cannot be replayed in its original context. It is
  replayed as a first turn instead. `screen.mjs` removes prompts that make no sense that way,
  but turns whose difficulty came from accumulated context are simply not represented.
- **Two tiers.** Labels are `cheap` vs `strong`. Sonnet, the actual default, is not in the
  comparison.
- **Corpus size and provenance.** There are only a few dozen harvested tasks and most come
  from one repository. `generate.mjs` expands the corpus, but a model asked to invent hard
  tasks invents tasks that are hard in the way *that model* imagines. Generated and harvested
  results are reported separately for this reason, and `score.mjs` also prints whether the
  generator's own difficulty labels predict measured escalation value — if they do not, the
  corpus has no difficulty range and nothing downstream means anything.
- **Judge self-preference.** The judge is Opus, which is also the strong candidate. Swapping
  positions controls for position, not for a model preferring its own output. Re-running with
  `--judge fable` and comparing is the check; it has not been done.
- **One subscription, one machine.** Costs come from the proxy ledger and Claude Code's own
  `total_cost_usd`, both list-price figures, not what a Pro subscription is actually billed.

## Cost

A replay is a real agentic session. Budget roughly one to two minutes per task per tier, plus
two judge calls per pair. A 100-task corpus is about 200 replays and 200 judge calls, which
will exceed a Pro five-hour window; run it in stages.

## Running against a subscription

A replay is a full agentic session and a judged pair is two more model calls, so a corpus of
any size will exhaust a Claude Pro five-hour window. Every stage is resumable, and every stage
stops rather than records when it hits the limit; re-run the same command after the window
resets.

A usage-limit refusal is the failure mode to watch for. It does not look like an error: it
arrives as a well-formed success envelope with `is_error: true` and prose such as "You''ve hit
your limit" in `result`. Recorded, it permanently marks the task as done, and because every
stage skips work already present in its output file, that task is never retried. `claude.mjs`
detects it centrally; `prune.mjs` removes any that slipped through an older run.

The replay queue is sorted by task id, which is a content hash and therefore a stable shuffle.
A run cut short by a usage limit is then still a random sample of the corpus rather than
whichever repository happened to be listed first.
