Cal Poly Canvas module downloader
================================

Downloads course-module materials using an interactive Chromium login.
No personal access token is needed. The default URL is https://canvas.calpoly.edu.
Enter your Cal Poly password and complete MFA in the browser, not the script.

QUICK START ON NIXOS

1. Extract this ZIP and open a terminal in the canvas-downloader folder.
2. Run:

   nix-shell shell.nix
   python canvas_download.py

The Nix shell includes Chromium and the Playwright Python package. The script
finds Chromium on PATH automatically. You can also specify it explicitly:

   python canvas_download.py --executable "$(command -v chromium)"

3. Sign into Cal Poly in the Chromium window. When your Canvas dashboard or
   a course is visible, return to the terminal and press Enter.
4. Enter the desired course IDs separated by spaces, or type all to select
   every listed course.

OTHER PLATFORMS (Python 3.10+)

   python -m venv .venv

Activate it on Linux/macOS:
   source .venv/bin/activate

Or on Windows PowerShell:
   .venv\Scripts\Activate.ps1

Then:
   python -m pip install -r requirements.txt
   python -m playwright install chromium
   python canvas_download.py

If system Chromium is on PATH, the script uses it. Otherwise it uses Playwright's
bundled Chromium. Use --executable /path/to/chromium to choose an executable.
On conventional Linux distributions, Playwright may require system browser
libraries; consult its official installation instructions. On NixOS, use the
provided Nix shell rather than downloading the Playwright Chromium binary.

OPTIONS

Only list courses after signing in:
   python canvas_download.py --list

Download specific courses (ID is the number in a /courses/12345 URL):
   python canvas_download.py --course 12345 --course 67890

Choose a download destination:
   python canvas_download.py --course 12345 --output ~/Documents/Canvas

Use a different Canvas origin if needed:
   python canvas_download.py --url https://YOUR-SCHOOL.instructure.com

WHAT IT SAVES

Canvas-Materials/
  <course-ID>__<course-name>/
    <module-position>__<module-ID>__<module-name>/
      <file-ID>__Lecture.pdf
      <file-ID>__Practice-Problems.pdf
      page_<course-ID>_<page-slug>__<title>.html
      assignment_<course-ID>_<assignment-ID>__<title>.html
  download-index.json
  download-report.json

Direct module files and Canvas-file attachments linked in pages, assignment
descriptions, discussion prompts, and quiz descriptions are downloaded. Linked
Canvas pages/assignments/discussions are followed up to five levels deep. Pages
and descriptions are saved as HTML, with downloaded attachments linked locally.

Quizzes: only accessible descriptions and their attachments are saved. Quiz
questions, answers, attempts, submissions, and discussion replies are not fetched.

External URLs and tools (for example Google Drive, Panopto, textbook platforms)
are recorded in download-report.json, not downloaded. Active embedded tools are
removed from saved HTML. Unrecognized Canvas link formats are reported rather
than guessed. Inline styles and scripts are removed, so saved pages are simplified
and may need Canvas online for interactive or MathJax-rendered content.

This script traverses modules. Files that are not linked from modules or their
pages/descriptions are outside its scope. Accessible old courses may be listed;
choose specific IDs if you only want current classes. Locked and hidden content
can only be downloaded after it becomes accessible to your account.

RUNNING IT AGAIN

Sign in each run. The script verifies cached file metadata and local SHA-256
checksums, then skips unchanged files. Updated files replace previous versions
after a complete download. Interrupted downloads are restarted on the next run.
Saved HTML is refreshed each run. Changed module/course names or positions may
create new folders. Old files/folders are retained, including removed course items.
This is a download archive, not an exact mirror of Canvas.

download-index.json tracks completed files. download-report.json reports the
current run's unavailable items and external/unhandled links. Exit code 0 means
the selected scan finished without unavailable items; 2 means partial results;
1 means a setup/fatal error; 130 means it was interrupted. External links alone
do not produce exit code 2, so a successful scan does not mean external content
has been archived.

LOGIN AND PRIVACY

The script opens a fresh Chromium session and closes it after downloading.
It uses only cookies for the verified Canvas origin in memory; it does not
export cookies, save a browser profile, or record credentials. Downloads and
reports remain in your chosen local folder. Ordinary Canvas content can itself
include authenticated links; treat your archive as personal course material.
Your usual browser extensions and saved logins are not loaded into this session.

The script recognizes signed-in Canvas pages on the requested origin,
*.calpoly.edu, or *.instructure.com. It checks the opened window and other tabs
for Canvas's navigation instead of guessing from the login provider's address.
If you are still on an SSO/MFA screen, it waits for you to finish and press Enter
again. You do not need to rerun with a login-provider URL. For a Canvas host
outside these domains, explicitly supply that Canvas origin with --url.
If the script returns a login-page or HTTP 401/403 error after you are signed in,
your session may have expired or the school may restrict that endpoint. Sign in
again and retry; persistent session/API restrictions need a different approach.

VALIDATION

Local tests cover pagination, origin isolation, attachment discovery, cyclic
pages, HTML sanitization, cache integrity, interrupted downloads, reporting,
Chromium startup, browser cleanup, and login-tab detection.
The actual Cal Poly SSO/MFA and course-download flow has not been run here because
it requires your account. This first version must be validated on your machine.

Official references:
https://playwright.dev/python/docs/library
https://playwright.dev/python/docs/api/class-browsertype
https://developerdocs.instructure.com/services/canvas/resources/modules
https://developerdocs.instructure.com/services/canvas/resources/files

Run the included offline tests with:
   python -m unittest -v test_canvas_download.py
