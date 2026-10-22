# Local routing security update — 2026-10-22

This branch hardens the owned CLI fork. It does not publish an npm release, update existing global installations, launch a real coding agent, or deploy an application.

## Changes

- Require supported patched Node lines: 22.23.4+, 24.22.1+, or 26.12.1+ within the corresponding major. `.node-version` / `.nvmrc` select 22.23.4. These versions are the October 21 baseline, not a promise that no later security update is needed.
- Check the exact bound loopback Host and reject browser Origin/fetch metadata before routing or upstream forwarding. Bound actual request bodies to 32 MiB, including chunked input, and reject aborted input.
- Restrict env-file loading to routing credential names and the backend selector. Project env loading requires explicit opt-in from the trusted launch environment. Child process controls and provider endpoint overrides must come from the trusted process, not env files.
- Keep new session/status/settings, opt-in dumps, and interactive diagnostic logs in owner-only storage. Use atomic JSON replacement, file ownership/type checks, symlink refusal on reads/appends, and Unix directory/file modes 700/600. Dumps no longer accept arbitrary output prefixes.
- Remove prompt excerpts and raw processing errors from diagnostic messages. Render untrusted explanation/statusline text without terminal control characters. Quote statusline executable paths as shell data.
- Launch CLI prompt arguments without a command shell. Windows batch-only shims are no longer accepted; install a native executable or use the existing PowerShell shim. No PowerShell policy bypass is added.
- Remove blanket Node-command preapproval from the explanation skill. Underlying CLI permission rules remain in control.
- Add immutable npm-install/dummy regression CI with read-only GitHub permissions and SHA-pinned official actions; no deployment/publish job.

## Validation

- Before changes: existing 67 tests passed; both newly added real proxy browser-boundary tests failed against dummy loopback upstreams.
- After changes: 79 tests passed using Node 22.23.4 in a clean environment with dummy data and local upstreams. Includes legitimate forwarding, blocked Origin/Host/fetch metadata, declared/chunked oversize and abort, private modes and symlink refusal, dump confinement, env allowlist/precedence, terminal output, actual Unix shell path quoting, and Windows resolver policy tests.
- `npm ci --ignore-scripts --no-audit --no-fund` and `npm audit --ignore-scripts --json`: success; audit reports zero advisories. Dependency versions are unchanged; the lockfile engine requirement is aligned.
- Executable/module syntax checks and regression YAML parsing passed. `git -c core.whitespace=cr-at-eol diff --check` passed, preserving existing CRLF files.
- Twelve locked dependencies use the official npm registry and SHA512 integrity. Exact published Datadog package/version and file indicators did not match the reviewed lock/install snapshot. The dependency prepare hook was inspected as data and was not executed. This is not a complete source/provenance audit.
- Pattern-based secret checks found no candidates in the reviewed current text files or the 145 text blobs in 49 reachable fetched commits. Deleted/unreachable objects, hosted logs, historical installed copies and diagnostic artifacts are not covered. No absence-of-leakage conclusion follows from pattern scans.

## Remaining checks and rollout

- Loopback header checks protect the browser boundary; they do not authenticate other native local processes. Use a trusted single-user execution context. Peer authentication / a CLI-compatible shared session token requires separate integration work.
- Exact prompt and request/response histories remain a feature and persist privately until owner cleanup. Coordinate retention and review historical artifacts without destroying possible incident evidence.
- Windows native execution, ACL equivalence and unusual install paths still require native Windows validation. Tests on macOS verify resolver policy, not a full Windows installation. Windows-only unsupported paths fail closed.
- Real Claude/Codex model catalogs, live provider routing, CLI version compatibility, underlying tool sandbox/approvals, account MFA/token scope, provider retention, and access/egress logs were not exercised. Routing can send the latest prompt and model metadata to TypeSafe or Vercel AI Gateway; review provider policy before sensitive use. Model selection is not prompt-injection prevention for the underlying agent.
- No PHP server, database, tenant API, file upload, webhook or public web hosting was found in this repository. Those application checks are not applicable to this CLI source. GitHub metadata and configuration do not establish the state of globally installed copies.
- Before release, a maintainer should test both CLIs with dummy prompts in an isolated account, inspect effective sandbox/permission settings, confirm only expected provider destinations, verify `node --version` and installed commit, and apply owner-only Windows ACLs where applicable. No credentials or real customer material should be used for smoke tests.
- Merge only after required review/checks, then use the existing explicit installation/release procedure. No automatic npm publishing has been added. Restart the installed routing process after updating and confirm its effective runtime and source revision.
- Rollback: restore the prior installed package/commit and restart the CLI. Reverting this branch restores prior behavior and its associated risks. Reverting code neither deletes historical diagnostics nor revokes any credential; no secret rotation was performed here.

Official reference: [Node October security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), checked 2026-10-22. CVE-2026-111497 affects the Node 22/24/26 Brotli decoder; TLS/HTTP fixes also apply by line. SDK HTTP decoding/TLS paths motivate patching the runtime even without a direct zlib import. The lockfile and engine range are configuration evidence, not proof of the version used by an existing installation. [OWASP prompt injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) informs the tool/egress boundaries; prompt-only defenses are insufficient.
