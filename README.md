# Canvas Local Archive

A local Chromium Manifest V3 extension for Helium on NixOS/Linux. It discovers accessible Cal Poly Canvas course materials, lets you select them, and saves them in a **different real filesystem folder for each course**. Click the extension icon to open the full interface.

For normal Nix-managed installation using an **`{ id; hash; }`** entry, use the signed package and resolver in **[Packaged installation](docs/PACKAGED-INSTALL.md)**. It installs through Helium’s existing external-CRX mechanism with Developer mode off. Your Google-only fetcher needs the documented resolver change for this private package; nothing is published to the Web Store.

The ready-to-load development extension is **[`extension/`](extension/)**. Neither installation needs Python, Playwright, browser debugging flags, a server, personal access token, password entry, or cookie export. No materials are uploaded and no services are published.

**Verification:** real folder picking, reading, writing, handle restoration, permission renewal, and a synthetic download workflow were tested in installed Helium 0.17.2.1 / Chromium 153 on this machine. Live Cal Poly login/MFA, session API access, and actual Canvas/CDN downloads have **not** been verified. See [the evidence and manual checklist](docs/VERIFICATION.md).

## Install unpacked in Helium (development)

1. Keep this project in a permanent local location. The folder to load is:
   `/home/edward/Documents/projects/canvas-scraper/extension`
   If you move the project, use its new `extension/` folder instead.
2. Open **`helium://extensions`**. `chrome://extensions` also works and redirects to Helium’s extension manager.
3. Enable **Developer mode** in the upper right.
4. Click **Load unpacked**. Select the **extension folder containing `manifest.json`**, not the project root or `reference/python/`.
5. Open the toolbar’s **Extensions** menu (puzzle-piece icon), find **Canvas Local Archive**, and click its pin icon. Click the pinned extension icon to open its full tab. Subsequent clicks focus an existing archive tab.
6. Leave access to `https://canvas.calpoly.edu/*` enabled in the extension’s Details/Site access settings. The only required extension API permission is `scripting`, used for read-only session requests through an open Canvas tab when needed.

There is no automatic installer or Nix activation. The existing `.dotnix` Helium extensions were inspected at your request: they use unpacked MV3 directories with local scripts. This project follows that arrangement and **does not change `.dotnix`, browser policies, or Nix configuration**. Your declaratively loaded extensions can coexist with this manually loaded one.

## Verify the browser before real downloads

Click **Check browser capabilities** in the archive tab. Use a visible, full extension tab in your **normal Helium profile**:

1. Create a small `existing.txt` in an empty test folder using your file manager/editor.
2. Click **Choose test folder**, select that real folder, and accept Helium’s read/write permission prompt.
3. Click **Read and write test**. Check that the output shows the existing file’s contents and `passed: true`. A uniquely named `canvas-capability-*.txt` should appear in the selected directory.
4. Close/reopen the tab or restart Helium. The folder name should be restored from IndexedDB. Permission can return to `prompt`; click **Renew folder access**, accept the browser prompt, then repeat the test. Picker cancellation preserves the previous handle.
5. Open [Canvas](https://canvas.calpoly.edu/) in this same profile. Finish normal Cal Poly login and MFA. Return to the capability tab and click **Check Canvas session**. Success must come from an authenticated Canvas API response. If it fails, use Open Canvas / Sign in, then retry.

The picker grants access; a path typed into a label does not. The capability test writes only its unique test file and does not overwrite `existing.txt`.

If `showDirectoryPicker` is absent, or the browser/desktop rejects folder access, downloads are blocked. See [folder-access troubleshooting](#folder-access-and-smallest-alternative). The extension does not substitute Downloads or private browser storage for real course folders.

## Connect and choose course folders

Open Canvas in your normal Helium profile, complete login/MFA, and click **Connect / Refresh** in the archive. The extension verifies **GET `/api/v1/users/self/profile`** on the fixed origin `https://canvas.calpoly.edu`. It does not accept a hostname, page title, Canvas-looking DOM, or an IdP page as proof of authentication. `idp.calpoly.edu` never becomes an API base.

It first tries an extension fetch with the browser’s ambient session. If that fails, it tries a same-origin GET from an already-open, exact-origin Canvas tab using `chrome.scripting` in an isolated world. This matters because the inspected Helium configuration blocks third-party cookies. The fallback reads no DOM or cookies, enters no credentials, and opens no automated login browser. **Keep the Canvas tab open if the connection status says it is using that tab.** An IdP tab alone is insufficient; finish sign-in and return to Canvas.

Search courses by name, course code, or term. **Show previous courses** reveals accessible concluded/older courses. Completed enrollments are explicitly requested; if that listing is unavailable, the status reports the limitation. Cached listings do not authenticate a new session.

For each course:

1. Click **Scan materials**.
2. Click **Choose folder** and select that class’s actual root folder. For example, you can choose your EE2328 and STAT3310 folders through the picker; those example paths are not hardcoded permissions.
3. Optionally enter a destination label such as `Documents/notes/.../EE2328`. The interface displays the chosen folder name because browsers do not reveal its absolute path. The label is descriptive only.

Mappings are keyed by **verified Canvas origin and numeric course ID**, not course code or term name. Handles are stored locally in IndexedDB. A folder already mapped to another course, or containing another course’s archive index, is rejected. **Change folder** replaces the mapping and invalidates previous disk checks; it does not move or remove materials in the old folder. Renew access only through the visible button.

## Scan and select

Scanning discovers metadata and instruction documents. **It never downloads original attachments automatically.** Expand **Modules**, **Assignments**, and **Other course files**. Course/module/section checkboxes select descendants; you can deselect individual files or documents afterward. Mixed checkboxes indicate a partial selection. Select all and Clear section operate on the stated section count, including rows beyond its first 100 visible items; Show next reveals more rows. Clear selection clears all courses.

The scan covers:

- Paginated modules and module items, including direct Canvas files.
- Canvas attachments and linked pages/instructions in accessible pages, assignment descriptions, discussion **prompts**, and classic quiz **descriptions**.
- Accessible Assignments and course Files outside modules.
- Course file folder metadata for supplemental subfolder layout.

It does not request quiz questions/answers/attempts, discussion replies, student submissions, grades, or personal account files. All Canvas requests are GET requests in a restricted endpoint allowlist. Locked, hidden, unpublished, and restricted items are not downloaded or traversed. New Quizzes and external tools remain online links. Cross-course content links are recorded rather than followed.

Cycles are deduplicated; linked-content recursion stops at five levels. Limits are 20,000 unique assets per course, 2,000 pages per paginated endpoint, 16 MiB per API/index response, a bounded discovery queue, and 20 supplemental folder levels. Limits and unavailable endpoints appear in coverage reports. If course Files is denied, accessible module discovery continues. File titles are retrieved from permitted course-scoped metadata before a restriction is reported; if metadata itself is denied, the module title is retained.

External resources (Colab, YouTube, Google Drive, external learning tools, etc.) remain links and are listed separately. They are not archived or counted as failed downloads.

## Folder layout and deduplication

The directory you select **is the course root**. There is no extra `<course-ID>__<course-name>` folder inside it.

```text
<chosen course root>/
  01__234__Introduction _ theory/
    456__Lecture notes.pdf
    page_123_start__Getting started.html
    assignment_123_789__Worksheet.html
    discussion_123_321__Discussion prompt.html
    quiz_123_654__Quiz description.html
  02__235__Practice/
    456__Lecture notes.pdf
  _Assignments/
    assignment_123_790__Independent assignment.html
    457__Lab data.csv
  _Other-course-files/
    987__Reference notes/
      458__Reference.pdf
  .canvas-archive/
    index.json
    reports/
      <timestamp-and-run-ID>.json
```

Module folders use position padded to two digits, module ID, and sanitized module name, exactly as in the Python reference. Files use Canvas file ID plus the sanitized original filename. HTML uses lower-case content type, course ID, page slug/content ID, and sanitized title. The sanitizer replaces `<>:"/\\|?*`, controls and DEL with `_`, trims leading/trailing spaces/dots, keeps 130 Unicode code points, substitutes `untitled`, and prefixes Windows reserved names with `_`.

Very long UTF-8 names receive a deterministic shortened form/hash to fit Linux’s usual 255-byte component limit. That extra shortening retains file extensions that survived the reference’s 130-character sanitizer. Document-name collisions, including case/Unicode normalization collisions, receive stable Canvas identifiers. Paths are validated against absolute paths, separators, and `..` traversal.

Discovery is deduplicated by Canvas identifier, with page aliases reconciled through page IDs. **Placements preserve module associations.** A file used in two modules has two selectable module placements, matching the Python archive layout. Selecting both creates one copy per module. Deselecting one placement leaves the other selected placement intact. Metadata is discovered once; copies are streamed separately. A module-associated file never gets an automatic third copy under Other course files.

Assignments already associated with modules appear in the Assignments section as the same placements. They do not get an extra `_Assignments` document. Non-module assignment content goes under `_Assignments`; remaining files go under `_Other-course-files`. Supplemental subfolders keep Canvas folder IDs and sanitized names. If folder metadata is unavailable, supplemental files use a flat layout and report that limitation.

Renamed/reordered modules or renamed files/documents can produce new paths on a rescan. Old paths remain. This is an archive, not a deleting mirror.

## Check disk, review, and download

**Check destination** inspects all discovered paths for that course without changing selection. **Review selected items** inspects only the final selection, refreshes remote metadata/instructions, and checks each expected path inside that course’s chosen directory. A cached index is never sufficient evidence that a file still exists.

| Status | Meaning and default action |
| --- | --- |
| Missing | Actual path is absent; download it. |
| Existing—unverified | File exists, but no trustworthy checksum/origin/revision evidence exists; preserve it. |
| Unchanged | Completed index, local SHA-256, and remote revision match; skip it. |
| Remote update available | Indexed local content is intact; current remote revision or offline links changed; download the update. |
| Locally modified/conflict | Local checksum differs from the recorded copy; preserve it. |
| Unavailable | Restriction, invalid metadata, endpoint failure, inaccessible path, or another concrete problem; report it. |

Matching filenames or sizes do not establish identity. Checksums are computed incrementally from actual file contents. Missing cached files are downloaded again. An EE2328 copy does not satisfy a check in STAT3310’s different root. Local edits are detected even when size is unchanged. Without reliable remote revision metadata, repeated checks require explicit verification instead of assuming unchanged content.

For unverified/conflicting files, choose **Verify contents** to fetch/hash the current remote content and compare it without writing over the local file. Identical content is indexed; different content remains a conflict. Alternatively, choose **Replace this file** in the review to explicitly allow replacement. Default Preserve never silently overwrites these files. Recheck after changing the selection or destination.

The review lists new items, unchanged files, updates, conflicts/unverified items, unavailable items, estimated known sizes, and each relative destination. Some document sizes are unknown until rendering. Selecting a course does not immediately start a job.

Dependencies remain subject to selection. A selected document with a deselected/unavailable attachment shows that dependency and retains a cleaned online link. If the attachment is selected in another module, the document can link to that selected placement. Failed downloads fall back to online links in generated HTML where the job can finish reconciliation. External images are online links rather than automatic remote image loads. Offline HTML is conservative, script-free, and simplified, like the Python version; active embeds/styles are removed and MathJax/interactive content may need Canvas online.

Click **Download reviewed selection**. Browser prompts can request access to the exact separate hosting origins supplied by selected Canvas file metadata. Those optional host permissions permit original-file fetches; they do not change the API base or enable an external-resource crawler. Canvas-origin downloads use the same-origin tab stream when Connect used the tab transport. See hosting troubleshooting below.

## Safe writes, progress, and cancellation

Jobs run in the full extension tab, with at most two original-file writers and sequential document rendering. Network/file data streams in chunks; SHA-256 uses bounded buffers. Bodies are kept in IndexedDB and loaded one document at a time rather than holding all course downloads in memory. Requests retry transient network errors, HTTP 429 and server failures up to four attempts, with bounded backoff/Retry-After delays. Denied endpoints are not bypassed.

Each file is checked again before writing. `createWritable({mode: 'exclusive'})` stages browser-managed writes; the writer is aborted on size mismatch, failure, cancellation, permission loss, or a detected local edit before close. The final size and SHA-256 are read back from disk. A completed index entry is written only after that check. Index commits are serialized across the two writers, and Web Locks prevent simultaneous jobs in different archive tabs.

**This is not a guarantee of atomic replacement or a transaction across file/index/report writes.** Browser close/crash, OS failure, antivirus checks, an external editor racing the last check, or failure during close can have limits beyond JavaScript’s control. There is no portable filesystem rename/fsync transaction here. A new empty placeholder can remain after an interrupted write; it has no completed index entry and is preserved as unverified until explicitly verified/replaced. No unrelated files, notes, or old material are deleted.

Keep the full extension tab open. The MV3 worker only opens/focuses the tab; its suspension does not own or interrupt the job. The tab can still be closed, discarded by Helium, or interrupted by browser restart. **Cancel operation** aborts requests/open writers and retains completed files. Progress shows downloaded/skipped/failed/cancelled counts. Retry restores failed/cancelled items and opens a fresh review; it does not silently restart downloading.

## Reports, index, and recovery

Each course has `.canvas-archive/index.json` and a separate JSON report under `.canvas-archive/reports/` for every normal run. Reports include titles/filenames, course/module context, Canvas IDs, relative paths, per-item outcomes and specific reasons, counts, coverage limitations, and separate external-link entries. A job with denied selected content or incomplete coverage is marked partial. External links alone do not make a run fail.

Open **Python index and reports → View latest report** in the course card. A copy of the latest report/selected keys is retained in IndexedDB for recovery. If the directory report save fails, **Save report again** retries after access is renewed; the browser copy remains viewable. File signed URLs exist only in memory. Reports and stored scan bodies remove unnecessary authentication/tracking query parameters; cookies, passwords, tokens, and profile data are not logged.

After interruption:

1. Reopen the extension, sign in to Canvas normally if needed, and **Connect / Refresh**.
2. **Renew access** for each course folder or choose it again if moved/deleted.
3. Click **Restore last selection and recheck**, or Retry failed / cancelled items after a completed/cancelled run.
4. Review the actual folders again. Completed intact files skip; absent files download; changed/unverified files preserve by default.
5. Start the reviewed job. Interrupted streams restart from the beginning; no HTTP range resume is attempted.

Recovery does not pretend to recreate a closed network stream. A file committed before its index write failed remains on disk and may need explicit verification. Interrupted HTML reconciliation can leave links to later unsaved documents; restoring the last selected set and completing a recheck/run repairs supported links. Old materials remain untouched.

## Import the Python index

The Python script stores `download-index.json` at the archive parent, above `<course-ID>__<course-name>/`. Choose the existing Python **course directory** as this extension’s course root to match module paths. The directory grant does not include its parent.

In that course’s **Python index and reports** section, click **Import Python index** and select the parent’s JSON file through the separate file picker. Safe entries matching the numeric course ID and `file-ID__filename` layout are reconciled to course-relative paths and checked against the chosen root. The Python index and original report are never overwritten. A copied index placed at the chosen root can also be discovered automatically.

The Python index has no origin field. Leave **This Python index came from canvas.calpoly.edu** unchecked unless you know its source. Matching imported local checksums still remain unverified in that case; use Verify contents. Confirming the origin allows matching remote version metadata plus the actual local checksum to establish Unchanged. Missing files and local edits are still detected. Imported paths outside the course root, foreign course IDs, malformed entries, and unsafe paths are rejected/ignored. Python HTML was not indexed; those documents remain unverified until you verify or explicitly replace them.

## Update the unpacked extension

For the normal signed package, follow the [package update procedure](docs/PACKAGED-INSTALL.md#package-updates): bump version, package with the same signing key, update the Nix pin/input, apply your configuration, and restart Helium. The following Reload procedure applies to the unpacked development installation.

1. Finish/cancel jobs and close the archive tab.
2. Update the source in this project’s **same `extension/` directory**. No build/install command is needed for runtime changes.
3. Open `helium://extensions` with Developer mode enabled. Click **Reload** (circular-arrow icon) on the **Canvas Local Archive** card. Reload the extension itself, not just a Canvas webpage.
4. Click the pinned icon again. Reconnect, renew directory permissions if requested, rescan changed courses, and recheck selection.

Keep `manifest.json`’s public `key` unchanged. It fixes extension ID `fhnmbadoigdiagenjabomlcafagmcifh`, helping preserve extension storage across unpacked path changes. The key is a public identity key; no private signing key is included. Normal Reload retains data; removing the extension, clearing its data, switching profiles, or changing its identity can erase handles/selections. On a path move, load the new folder, check the identity, and reselect folders if necessary. On a different machine/profile, select destinations again.

Update source with your chosen Git workflow, then use the procedure for your installation type. These implementation steps do not create/publish a repository or change Git remotes. There is no publisher, telemetry, update server, or automatic course download schedule.

## Development dependencies and tests

Detected tools: Helium 0.17.2.1 (Chromium 153.0.8010.52), Nix 2.34.8, Python 3.13.15, `uv`, Git, curl, Xvfb, xdotool, and ImageMagick. Node/npm were not initially on PATH. A project `shell.nix` supplies Node.js 24; the resolved environment used Node 24.20.0/npm 11.19.0. This shell is separate from your Nix configuration and uses the configured `<nixpkgs>` channel; it is not a pinned Nix flake.

Runtime dependencies: **Helium/Chromium with the tested browser APIs only**. All JS/CSS/HTML lives in `extension/`; there are no CDN scripts/fonts or runtime npm packages.

Development dependencies: **Node ≥24** and **linkedom 0.18.12** (DOM fixture tests only), with npm transitives pinned in `package-lock.json`. npm packages are installed under this project’s `node_modules/`. Nix retains Node in its ordinary store. Python is only optional for running the pre-existing reference tests; the extension does not use it.

```bash
cd /home/edward/Documents/projects/canvas-scraper
nix-shell shell.nix
npm ci --ignore-scripts
npm run check
npm test
```

If Node 24+ is already available, skip `nix-shell`. Or run project commands with `nix-shell shell.nix --run 'npm test'`. The check validates JavaScript syntax, manifest scope, imports, and referenced local assets. Tests use synthetic Canvas responses and filesystem contract mocks. They cannot prove your account’s login or a real browser’s filesystem behavior.

Optional original reference validation:

```bash
cd reference/python
python3 -m unittest -v test_canvas_download.py
```

For the native fixture workflow, run `npm run test:browser:prepare`. It creates `.local/browser-fixture/`, which substitutes a clearly labelled fixture bootstrap while keeping production source modules. **Use only an isolated test profile; it shares the public extension key.** Load it unpacked there, choose an empty test folder for TEST101, renew permissions, and click Run fixture workflow checks. It checks actual browser UI, directory writes, IndexedDB, locking, aborts, and second-run skipping using synthetic API data. Use a fresh folder for a fresh workflow run. There is no server or Playwright. Xvfb/xdotool/ImageMagick were used only for this machine’s isolated GUI verification and are not extension dependencies.

`.gitignore` excludes node_modules, `.local/` signing keys/test profiles/evidence/output, reference Python caches, download indexes/reports, course archives, logs, private keys, and browser capture files. Public signed CRXs in `packages/` are explicitly allowed for version control and Nix input visibility. Fixtures contain no real coursework, credentials, profiles, or personal destination mappings. No Git repository, remote, commit, or publication is created by the implementation steps.

## Hosting/session troubleshooting

- **Sign in required / API returns HTML or a redirect:** use Open Canvas / Sign in, finish MFA, return to Canvas, then Connect / Refresh. Never change the API origin to an IdP address. A school restricting session-based API access remains a reported limitation; no token/password workaround is added.
- **Canvas tab closed/navigated:** the fallback loses its context. Reopen Canvas and reconnect. Its file stream uses bounded 128 KiB messages and same-origin credentials; CDN redirects remain subject to browser/CORS behavior.
- **Signed file URL expired:** reconnect, rescan/review to obtain current metadata, then retry.
- **Separate file host denied:** permit the exact metadata hosting origin when Start/Verify requests it. For an otherwise permitted file whose redirect requires a different host, the Advanced section can request that HTTPS origin explicitly. It rejects IdP/insecure origins and paths/queries. Some hosts may still deny CORS; that is reported as a failed original-file download. There is no claim of verified Cal Poly CDN compatibility yet.
- **Restricted Files/folders endpoint:** module and instruction discovery continues. Read the coverage report for material outside the scan’s access.
- **Invalid/foreign index or file/folder path collision:** the operation stops safely. Preserve the file/index, repair/rename the problematic metadata if appropriate, or choose a different root; do not erase notes to make a download succeed.

## Folder access and smallest alternative

Real arbitrary-folder access was verified in the installed Helium through a visible full extension tab, not through `chrome.downloads` or the origin-private filesystem. The isolated Xvfb display could not use the desktop’s normal portal; a test-only native GTK dialog fallback succeeded. Normal NixOS/Wayland portal behavior, other Helium builds, and policies still need the visible capability check.

If it fails in your actual profile, first retry in a visible top-level tab and check whether the existing desktop folder dialog/extension permissions work. This project does not modify desktop portal services, flags, or Nix configuration to force access. If the browser cannot grant real folder handles, the smallest alternative would be an **optional native messaging helper** scoped to explicitly chosen course roots, performing filesystem reads/writes while the extension keeps Canvas session requests. That would add a local executable and `nativeMessaging` permission. **No helper has been implemented, installed, or silently enabled.** Ordinary Downloads-only saving and origin-private storage do not satisfy this version’s requirements.

## Official references checked

- [Chrome File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) — real directory handles, user gestures, and IndexedDB storage.
- [Persistent filesystem permissions](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api) — query and user-initiated renewal.
- [FileSystemFileHandle.createWritable](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable) — staging/close behavior and exclusive writers.
- [Extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) and [storage/cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) — host access/session restrictions.
- [Chrome unpacked installation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) and [runtime contexts](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts).
- [Helium project](https://github.com/imputnet/helium) — Chromium-based extension support; runtime evidence remains necessary.
- Canvas [Courses](https://developerdocs.instructure.com/services/canvas/resources/courses), [Modules](https://developerdocs.instructure.com/services/canvas/resources/modules), [Files/Folders](https://developerdocs.instructure.com/services/canvas/resources/files), [Assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments), [Users](https://developerdocs.instructure.com/services/canvas/resources/users), and [Pagination](https://developerdocs.instructure.com/services/canvas/basics/file.file_pagination).

Implementation map and validation boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/VERIFICATION.md](docs/VERIFICATION.md).
