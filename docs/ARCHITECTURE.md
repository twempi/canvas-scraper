# Source map and design decisions

The unpacked extension is also the readable production source. There is no bundler or generated runtime output.

| File | Responsibility |
| --- | --- |
| `extension/manifest.json` | MV3, public identity key, Cal Poly host grant, optional HTTPS file host grants, local CSP. |
| `script/background.js` | Action opens/focuses the full tab through runtime contexts. No jobs, secrets, or filesystem state. |
| `script/canvas.js` | Exact API origin, read-only endpoint/parameter allowlist, authenticated profile probe, pagination, retries, cancellation, bounded API responses, optional same-origin Canvas-tab transport. |
| `script/scan.js` | Broader course discovery, ID/page-alias deduplication, module associations, recursion limits, restriction checks, supplemental layout, coverage. |
| `script/html.js` | Inert parsing, conservative offline renderer, secret-query removal, dependency/relative-link decisions. Canvas HTML is never inserted into the application UI. |
| `script/names.js` | Python sanitizer/layout parity, UTF-8 byte limits, document collision handling, path containment checks. |
| `script/store.js` | IndexedDB records/handle serialization and explicit permission query/renewal. |
| `script/filesystem.js` | Destination reads, incremental local hashing, disk classification, Python import, index identity validation, staged writers and post-close integrity checks. |
| `script/hash.js` | Small incremental SHA-256 implementation, tested against Node’s independent crypto implementation. |
| `script/download.js` | Permitted file metadata, specific optional host grants, streaming original bytes, bounded Canvas-tab stream fallback. |
| `script/jobs.js` | Reviewed selection only, metadata rechecks, two file workers, serialized index commits, sequential HTML, failed-link reconciliation, journal/report/recovery. |
| `script/selection.js`, `script/ui.js` | Shared placement selection with mixed checkboxes, full-tab controls, per-course destinations, review policies and reports. |
| `proof.html`, `script/proof.js` | Visible minimal session and native filesystem capability check. |
| `tests/`, `scripts/` | Synthetic fixtures, contract tests, source checks, and an ignored native-browser fixture build. |

Read before design: all 499 lines of the Python implementation, its 142-line README, and its 263-line test file. Its original 18 tests passed. The extension retains naming/sanitization, module placements, prompt/description HTML, pagination, bounded traversal, checksums, external links, and non-deleting archive behavior. It replaces fresh-browser automation/cookie handling/DOM-based login recognition with native browser-session GETs and an authenticated API probe.

Catalogs deduplicate **assets** independently from **placements**. A Canvas file has one asset/metadata record per course, and a placement per associated module. Page IDs deduplicate aliases while filenames retain the canonical page slug. Additional association with the Files endpoint does not create another copy. Assignment controls share placements with module controls. Scans preserve existing selected placement keys and never automatically select new discoveries.

Current metadata and local SHA-256 determine state. The index is course-root scoped and validates origin/course ID before use. Review snapshots store disk checksums; writers recheck them before starting and before close. No filename/size-only equivalence is used. User decisions to replace unverified/conflicting content are placement specific. Imported Python indexes require an explicit origin assertion or a remote content comparison because their schema omits origin.

Original bytes stream directly into `createWritable`; no course-sized blobs exist. API bodies are capped, instruction bodies persist in IndexedDB, file hashes process bounded chunks, and only one document is rendered at a time. The Canvas-tab file fallback keeps its reader in an isolated world of an already-open Canvas tab, with chunks capped at 128 KiB and idle timeouts. It does not export cookies or drive login/navigation.

The full extension tab owns the job, while Web Locks prohibit concurrent jobs in another archive tab. Report/selection journals persist independently of the MV3 opener worker. Completed files are indexed after close/read-back only. File, index, and report updates are separate writes, **not an atomic transaction**. Interrupted new writes can leave empty unindexed placeholders. Completed-but-unindexed material is preserved and verified/reconciled on recovery. No delete or browser Downloads fallback exists.

Files are processed before HTML so failed originals keep online links. Selected document destinations are reserved to support cyclic links. If a later selected document fails, freshly saved or verified intact dependents are reconciled to online links. If cancellation or revoked permissions prevent that pass, coverage explicitly reports the limitation; retrying/rechecking the selected set resolves supported links. Unselected attachments are never queued implicitly.

Everything remains local except authorized read-only requests to Canvas and hosting origins for selected original files. Required site access is only Cal Poly Canvas; `optional_host_permissions: ["https://*/*"]` declares possible user-requested hosting grants and does not itself grant them. Requests never use OAuth/API tokens or the cookies API. No external-resource crawlers, native helper, Nix activation, telemetry, or publisher are present.
