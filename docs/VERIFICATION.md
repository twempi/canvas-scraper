# Verification record

Test date: **2026-10-12**. Installed browser reports **Helium 0.17.2.1 (Chromium 153.0.8010.52)** on NixOS/Linux. The extension is unpacked MV3. No real account material was placed in fixtures or committed output.

## Essential proof before the application

The reference implementation, README, and tests were read before designing the extension. All 18 original Python tests passed. Current official Chrome/Canvas/Helium documentation was consulted; documentation was not treated as runtime proof.

A minimal `proof.html` was implemented and tested before the full course GUI/job workflow. Tests used the installed Helium executable and a **new test profile under ignored `.local/`**, with an Xvfb X11 display. No normal browser profile, cookies, credentials, or unrelated directories were read. The optional `.dotnix` inspection was limited to its Helium extension structure and related instructions; nothing there was changed.

| Capability | Evidence | Status |
| --- | --- | --- |
| Existing authenticated Cal Poly session | Production profile probe and exact-origin Canvas-tab GET fallback implemented; synthetic expiry/IdP/JSON tests pass. No live account session used. | **Not live-verified** |
| Select arbitrary real directory in full extension tab | Native folder dialog opened from the visible proof button; a project test folder was selected and Helium’s edit prompt accepted. | **Real Helium pass** |
| Read pre-existing file | `existing.txt` was created on disk before the browser test and its actual contents/size appeared in the proof result. | **Real Helium pass** |
| Create/read test file | A UUID-named capability file appeared in the selected real directory and matched after read-back. | **Real Helium pass** |
| Remember handle | Helium was closed and restarted; IndexedDB restored the folder handle with `queryPermission: prompt`. | **Real Helium pass** |
| Renew permission | Visible Renew button invoked Helium’s Allow this time / Allow on every visit / Don’t allow prompt; accepting renewed read/write access, and another read/write test passed. | **Real Helium pass** |
| Default normal Wayland desktop portal | The isolated display’s inherited portal request failed. A test-only disconnected session-bus environment used Helium’s native GTK chooser successfully. Normal desktop portal not changed/tested. | **Manual check remains** |

These are real directory handles, not `chrome.downloads`, private origin storage, browser history, or a mocked filesystem. Browser policies, desktop dialog behavior, and other Helium versions can still differ. Production requires no Xvfb, flags, Python, Playwright, or server.

After the fixture run, the production folder was loaded through the actual **Developer mode → Load unpacked** UI in the isolated profile. Pinning was exercised. The pinned action opened a full extension tab and focused that existing tab on a subsequent click. **Reload** on the extension card followed by reopening worked; the proof handle was still restored from IndexedDB with permission `prompt`. This verifies the documented local installation/update controls on the installed build.

## Full-tab native browser fixture run

`npm run test:browser:prepare` copied production source to ignored `.local/browser-fixture/` and replaced **only the bootstrap** with a clearly labelled test harness. Canvas API and authentication responses were synthetic. UI, IndexedDB, folder permission renewal, Web Locks, file handles, writable streams, and local checksum checks used **real Helium**.

All **10 native assertions passed**:

1. Real folder handle with granted read/write permission.
2. `chrome.runtime.getContexts` returns the current full extension tab.
3. Course checkbox selects discovered descendants.
4. Individual deselection leaves course/module checkboxes mixed.
5. Job saves only the selected original and offline HTML.
6. Actual on-disk original bytes match the fixture exactly.
7. Second job rechecks actual disk content and skips both unchanged items.
8. No unselected original file is fetched.
9. Aborting a real `createWritable` stream preserves a pre-existing good copy.
10. Native IndexedDB round-trips the actual directory handle (`isSameEntry`).

The native run produced module folders directly under the selected root, a course-scoped checksum index, and two per-run reports. [Sanitized assertion record](helium-fixture-results.json) includes only synthetic test results and browser version information. Raw screenshots, profile files, destination data, and test course output remain ignored in `.local/`.

This run **does not verify Cal Poly SSO/MFA, real session cookies, same-origin Canvas injection against a live account, institutional endpoint restrictions, or signed CDN/CORS behavior**. Node tests for those use fixtures/stubs. No separate automated account browser or cookie export was used.

## Automated fixture/contract tests

Final source check passed and **53 Node tests passed** (including authentication subtests). The original reference’s **18 Python tests** also passed separately.

Use Node 24+ with the project’s pinned test dependency:

```bash
nix-shell shell.nix
npm ci --ignore-scripts
npm run check
npm test
```

The suite covers:

- Authenticated JSON shape, expired authentication, login HTML, IdP redirects, exact origin checks, forbidden endpoints/parameters, and no token headers.
- Pagination/JSON prefix, foreign and repeating next links, duplicate discoveries, explicit concluded course listings, and capped rate-limit/server retry behavior.
- Modules/Assignments/Files/folders, page aliases/cycles/depth, useful restricted-file titles, unavailable endpoints, and forbidden quiz/submission/reply/grade endpoints.
- Inert HTML sanitization, external links, authentication-query removal, dependency deselection, original bytes, and module/supplemental deduplication.
- Python naming/layout, spaces, unsafe names, Unicode/code points, byte limits, stable identifiers and document collisions.
- Actual handlers for parent/child checkboxes, search/previous courses, cancelled pickers, duplicate roots, and explicit renewal behavior (mocked handles in Node).
- Separate roots/mapping keys, unindexed existing files, deleted cached files, changed destinations, same-size local edits, remote updates, and Python index reconciliation.
- Incremental SHA-256 against independent Node crypto; staged writer aborts, wrong lengths, permission loss, local edits after review/during writing, and post-close checking.
- Final-selection jobs, explicit verify/replace, second-run skipping, unknown revisions, failure reasons, privacy, reports/journals, interrupted recovery, cyclic failed-link repair, and bounded original-file concurrency.
- Separate-host permission requests/credential omission, download redirect/HTML rejection, and bounded/cancellable same-origin stream logic.

Filesystem mocks model staged writes/commit/abort, not all OS/browser behavior. DOM tests use linkedom; mocked `chrome.scripting` and fake page location/fetch do not prove a live Canvas tab works. The real browser checks above are separate evidence.

## Concise manual Helium checklist

- [ ] Load production `extension/` via Developer mode → Load unpacked; pin it; icon opens/focuses a full tab.
- [ ] In your normal desktop/profile, run `proof.html`: real picker, pre-existing read, test write, restart/restore, and renewed permission.
- [ ] Sign into Canvas with normal Cal Poly MFA; the capability API check succeeds. An IdP-only/expired session must fail clearly; finishing sign-in and reconnecting must work.
- [ ] Connect; check course name/code/term and Show previous courses. Scan a known course without downloading originals.
- [ ] Choose two different course roots. A file already in one must not satisfy the other. Confirm module folders go directly under each selected root.
- [ ] Select a course/module, deselect an individual attachment, review its dependency warning, and save a selected page. Its deselected attachment should stay online.
- [ ] Download one small accessible original. Open it locally; run again and check Unchanged/skip. Check the actual file host permission/CORS behavior.
- [ ] Put an existing unindexed matching-path file in the test destination: it must stay unverified/preserved until Verify or Replace. Test one Python-indexed course if available.
- [ ] Delete a test cached file, edit another without changing its size, and select a different destination: Missing/conflict/new-root states must come from actual disk checks.
- [ ] Test a known locked file and a course whose Files endpoint is denied; confirm useful titles and coverage, while permitted module content still scans.
- [ ] Cancel a test job, revoke folder access, and close/reopen the tab during another test job. Renew, restore selection, and recheck. Existing good copies must remain; empty incomplete placeholders must stay unverified.
- [ ] Inspect per-course reports for paths, IDs, useful titles, specific reasons, and separate external links. Ensure no credentials/signed auth parameters appear.
- [ ] Update a source file, Reload the extension card, reopen it, and confirm destination handle restoration/renewal and fresh checks.

Do not claim all live account/browser-hosting tests have passed until these normal-profile checks are completed. Folder access is established for the tested installed Helium build; Cal Poly session/CDN behavior remains explicitly pending.
