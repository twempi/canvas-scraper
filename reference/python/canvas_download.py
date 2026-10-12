#!/usr/bin/env python3
"""Download accessible Canvas module materials using an interactive browser login."""
import argparse
import hashlib
import html
import http.cookiejar
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path


class DownloadError(Exception):
    pass


def open_browser(playwright, args, base):
    options = {'headless': False}
    executable = args.executable or shutil.which('chromium') or shutil.which('chromium-browser')
    if executable:
        options['executable_path'] = executable
    browser = playwright.chromium.launch(**options)
    try:
        context = browser.new_context()
        page = context.new_page()
        page.goto(base, wait_until='domcontentloaded', timeout=120000)
    except Exception:
        browser.close()
        raise
    return browser, context, page


def canvas_page(context, opened_page, requested_origin):
    """Find Canvas even when SSO puts its dashboard in another tab."""
    original = urllib.parse.urlsplit(requested_origin)
    candidates = [opened_page] + list(reversed(context.pages))
    seen = set()
    for page in candidates:
        if page in seen:
            continue
        seen.add(page)
        try:
            if page.is_closed():
                continue
            parsed = urllib.parse.urlsplit(page.url)
            host = parsed.hostname or ''
            if (parsed.scheme != 'https' or parsed.username or parsed.password
                    or not (parsed.netloc == original.netloc
                            or host.endswith('.instructure.com')
                            or host.endswith('.calpoly.edu'))):
                continue
            ready = page.evaluate('''() => !!(
                document.querySelector('#global_nav_dashboard_link') ||
                (window.ENV && window.ENV.current_user_id &&
                 document.querySelector('#application'))
            )''')
            if ready:
                return page, f'https://{parsed.netloc}'
        except Exception:
            # SSO navigations can invalidate the DOM while checking a tab.
            continue
    return None, None


def wait_for_canvas(context, opened_page, base):
    print('\nSign into Cal Poly in the Chromium window, including MFA.')
    while True:
        input('Once a Canvas dashboard or course is visible, press Enter here: ')
        page, actual_origin = canvas_page(context, opened_page, base)
        if page:
            if actual_origin != base:
                print(f'Using the signed-in Canvas domain: {actual_origin}')
            return actual_origin
        print('A signed-in Canvas page is not visible yet. Finish login in the browser, '
              'then press Enter again. Press Ctrl+C to cancel.')


def safe_name(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', '_', str(value)).strip(' .')
    value = value[:130].rstrip(' .') or 'untitled'
    if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', value, re.I):
        value = '_' + value
    return value


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


class SecureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != 'https' or target.username or target.password:
            raise DownloadError('Refused an insecure download redirect.')
        return super().redirect_request(request, fp, code, msg, headers, newurl)


class Canvas:
    def __init__(self, base, cookies, delay=0.25):
        self.base = base.rstrip('/')
        self.origin = urllib.parse.urlsplit(self.base)
        self.delay = delay
        jar = http.cookiejar.CookieJar(http.cookiejar.DefaultCookiePolicy(
            strict_ns_domain=http.cookiejar.DefaultCookiePolicy.DomainStrictNonDomain))
        # Only Canvas cookies enter this client. No SSO cookies or disk cookie files.
        for c in cookies:
            jar.set_cookie(http.cookiejar.Cookie(
                version=0, name=c['name'], value=c['value'], port=None,
                port_specified=False, domain=self.origin.hostname,
                domain_specified=False, domain_initial_dot=False,
                path=c.get('path', '/'), path_specified=True,
                secure=c.get('secure', True),
                expires=int(c['expires']) if c.get('expires', -1) > 0 else None,
                discard=c.get('expires', -1) <= 0, comment=None, comment_url=None,
                rest={'HttpOnly': c.get('httpOnly', False)}, rfc2109=False))
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar), SecureRedirect())

    def same_origin(self, url):
        target = urllib.parse.urlsplit(url)
        return (target.scheme, target.netloc) == (self.origin.scheme, self.origin.netloc)

    def open(self, url):
        target = urllib.parse.urlsplit(url)
        if target.scheme != 'https' or target.username or target.password:
            raise DownloadError('Refused an insecure URL.')
        for attempt in range(4):
            time.sleep(self.delay)
            request = urllib.request.Request(url, headers={
                'User-Agent': 'CanvasPersonalArchive/1.0', 'Accept-Encoding': 'identity'})
            try:
                return self.opener.open(request, timeout=60)
            except urllib.error.HTTPError as exc:
                status = exc.code
                retry = exc.headers.get('Retry-After', '')
                exc.close()
                if (status == 429 or 500 <= status < 600) and attempt < 3:
                    time.sleep(min(30, int(retry)) if retry.isdigit() else 2 ** attempt)
                    continue
                raise DownloadError(f'HTTP {status}; content may be locked or unavailable.') from None
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise DownloadError('Network request failed after retries.') from None

    def api(self, path):
        url = urllib.parse.urljoin(self.base + '/', path)
        if not self.same_origin(url) or not urllib.parse.urlsplit(url).path.startswith('/api/v1/'):
            raise DownloadError('Refused an API URL outside this Canvas instance.')
        with self.open(url) as response:
            if not self.same_origin(response.url):
                raise DownloadError('Canvas redirected to login. Sign in again and rerun.')
            try:
                raw = response.read().decode('utf-8-sig')
                raw = re.sub(r'^\s*while\s*\(1\)\s*;\s*', '', raw)
                data = json.loads(raw)
            except (ValueError, UnicodeError):
                raise DownloadError('Canvas returned a login page instead of API data. '
                                    'Finish signing in, or this school may restrict session API access.') from None
            link = response.headers.get('Link', '')
            match = re.search(r'<([^>]+)>\s*;\s*rel=[\"\']?next[\"\']?(?:[,;\s]|$)', link)
            return data, match.group(1) if match else None

    def one(self, path):
        data, _ = self.api(path)
        if not isinstance(data, dict) or 'errors' in data:
            raise DownloadError('Canvas did not return the requested item.')
        return data

    def all(self, path):
        seen = set()
        while path:
            if path in seen:
                raise DownloadError('Canvas returned a repeating pagination link.')
            seen.add(path)
            data, path = self.api(path)
            if not isinstance(data, list):
                raise DownloadError('Canvas did not return a list of items.')
            yield from data


def reference(base, url):
    """Return a Canvas file/page/assignment/discussion reference, never external URLs."""
    url = urllib.parse.urljoin(base + '/', url)
    target, origin = urllib.parse.urlsplit(url), urllib.parse.urlsplit(base)
    if (target.scheme, target.netloc) != (origin.scheme, origin.netloc):
        return None
    path = urllib.parse.unquote(target.path)
    match = re.fullmatch(r'/(?:api/v1/)?(?:courses/\d+/)?files/(\d+)(?:/(?:download|preview))?/?', path)
    if match:
        return ('File', match.group(1), None)
    match = re.fullmatch(r'/(?:api/v1/)?courses/(\d+)/(pages|assignments|discussion_topics)/([^/]+)/?', path)
    if match:
        return ({'pages': 'Page', 'assignments': 'Assignment',
                 'discussion_topics': 'Discussion'}[match.group(2)], match.group(3), match.group(1))
    return None


class BodyParser(HTMLParser):
    """Collect attachments and render conservative, script-free offline HTML."""
    allowed = set('p div span h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr td th '
                  'a img strong em b i u br hr pre code blockquote sup sub dl dt dd figure '
                  'figcaption caption section article'.split())
    blocked = {'script', 'style', 'iframe', 'object', 'embed', 'form'}

    def __init__(self, base, replacements=None):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.replacements = replacements or {}
        self.links, self.parts = [], []
        self.suppressed = []

    def handle_starttag(self, tag, attrs):
        if self.suppressed:
            if tag == self.suppressed[-1]:
                self.suppressed.append(tag)
            return
        if tag in self.blocked:
            if tag not in {'embed'}:
                self.suppressed.append(tag)
            # Preserve the external target in the report, without rendering active embeds.
            self.links.extend(v for k, v in attrs if k in {'src', 'data'} and v)
            return
        out = []
        for key, value in attrs:
            if key in {'href', 'src'} and value:
                full = urllib.parse.urljoin(self.base + '/', value)
                if urllib.parse.urlsplit(full).scheme not in {'http', 'https'}:
                    continue
                self.links.append(full)
                value = self.replacements.get(full, full)
            elif key not in {'alt', 'title', 'colspan', 'rowspan', 'width', 'height'}:
                continue
            if value is not None:
                out.append(f' {key}="{html.escape(value, quote=True)}"')
        if tag in self.allowed:
            self.parts.append('<' + tag + ''.join(out) + '>')

    def handle_endtag(self, tag):
        if self.suppressed:
            if tag == self.suppressed[-1]:
                self.suppressed.pop()
            return
        if tag in self.allowed and tag not in {'img', 'br', 'hr'}:
            self.parts.append('</' + tag + '>')

    def handle_data(self, value):
        if not self.suppressed:
            self.parts.append(html.escape(value))


class Archive:
    def __init__(self, canvas, output, max_depth=5):
        self.canvas, self.output, self.max_depth = canvas, output, max_depth
        output.mkdir(parents=True, exist_ok=True)
        self.cache_path = output / 'download-index.json'
        try:
            self.cache = json.loads(self.cache_path.read_text(encoding='utf-8'))
            if not isinstance(self.cache, dict):
                raise ValueError()
        except FileNotFoundError:
            self.cache = {}
        except (ValueError, UnicodeError):
            raise DownloadError('download-index.json is invalid. Rename it and rerun.') from None
        self.report = []
        self.downloaded = self.skipped = 0
        self.failed = 0

    def issue(self, label, message, status='unavailable'):
        self.report.append({'item': label, 'status': status, 'detail': message})
        if status == 'unavailable':
            self.failed += 1
        print(f'  {status}: {label} — {message}')

    def file(self, course, folder, file_id):
        meta = self.canvas.one(f'/api/v1/files/{file_id}')
        if meta.get('locked_for_user') or meta.get('hidden_for_user'):
            raise DownloadError('This file is locked or hidden for your account.')
        if not meta.get('url'):
            raise DownloadError('Canvas did not provide a download URL.')
        path = folder / f'{file_id}__{safe_name(meta.get("filename") or meta.get("display_name") or file_id)}'
        key = f'{course}/{folder.relative_to(self.output).as_posix()}/{file_id}'
        old = self.cache.get(key, {})
        expected_size = meta.get('size')
        if (path.is_file() and old.get('updated_at') == meta.get('updated_at')
                and old.get('size') == expected_size and old.get('sha256') == digest(path)):
            self.skipped += 1
            return path
        partial = path.with_name(path.name + '.part')
        try:
            with self.canvas.open(meta['url']) as response, partial.open('wb') as stream:
                content_type = response.headers.get('Content-Type', '').split(';')[0]
                if content_type == 'text/html' and meta.get('content-type') != 'text/html':
                    raise DownloadError('File request returned HTML, possibly a login page.')
                shutil.copyfileobj(response, stream, length=1024 * 1024)
            if isinstance(expected_size, int) and partial.stat().st_size != expected_size:
                raise DownloadError('Downloaded size differs from Canvas metadata; rerun to retry.')
            checksum = digest(partial)
            partial.replace(path)
        except (OSError, urllib.error.URLError):
            raise DownloadError('Could not finish writing the download; rerun to retry.') from None
        finally:
            partial.unlink(missing_ok=True)
        self.cache[key] = {'updated_at': meta.get('updated_at'), 'size': expected_size,
                           'path': path.relative_to(self.output).as_posix(), 'sha256': checksum}
        write_json(self.cache_path, self.cache)
        self.downloaded += 1
        print(f'  downloaded: {path.name}')
        return path

    def module(self, course, module, folder):
        folder.mkdir(parents=True, exist_ok=True)
        visited, replacements, documents = {}, {}, []

        def visit(kind, content_id, linked_course=None, depth=0, label=None):
            owner = str(linked_course or course)
            ident = (kind, owner if kind != 'File' else '', str(content_id))
            if ident in visited:
                return visited[ident]
            if depth > self.max_depth:
                self.issue(label or str(content_id), 'Linked-page depth limit reached.', 'link-only')
                return None
            visited[ident] = None
            label = label or f'{kind} {content_id}'
            try:
                if kind == 'File':
                    path = self.file(course, folder, content_id)
                else:
                    endpoint = {'Page': 'pages', 'Assignment': 'assignments',
                                'Discussion': 'discussion_topics', 'Quiz': 'quizzes'}.get(kind)
                    if not endpoint:
                        return None
                    meta = self.canvas.one(f'/api/v1/courses/{owner}/{endpoint}/'
                                           + urllib.parse.quote(str(content_id), safe=''))
                    if meta.get('locked_for_user'):
                        raise DownloadError('This item is locked for your account.')
                    title = meta.get('title') or meta.get('name') or label
                    body = meta.get('body') if kind == 'Page' else meta.get('description')
                    if kind == 'Discussion':
                        body = meta.get('message')
                    body = body or ''
                    path = folder / f'{kind.lower()}_{owner}_{safe_name(content_id)}__{safe_name(title)}.html'
                    visited[ident] = path  # Reserve early to break cycles.
                    parser = BodyParser(self.canvas.base)
                    parser.feed(body)
                    for link in dict.fromkeys(parser.links):
                        ref = reference(self.canvas.base, link)
                        if ref:
                            local = visit(*ref, depth=depth + 1)
                            if local:
                                replacements[urllib.parse.urljoin(self.canvas.base + '/', link)] = local.name
                        else:
                            self.report.append({'item': title, 'status': 'link-only',
                                                'detail': 'External or unhandled link',
                                                'url': urllib.parse.urljoin(self.canvas.base + '/', link)})
                    documents.append((path, title, body))
                visited[ident] = path
                return path
            except DownloadError as exc:
                visited[ident] = None
                self.issue(label, str(exc))
                return None

        for item in self.canvas.all(f'/api/v1/courses/{course}/modules/{module["id"]}/items?per_page=100'):
            kind = item.get('type')
            if kind == 'SubHeader':
                continue
            if kind in {'ExternalUrl', 'ExternalTool'}:
                self.report.append({'item': item.get('title'), 'status': 'link-only',
                                    'detail': kind, 'url': item.get('external_url') or item.get('html_url')})
                continue
            content_id = item.get('page_url') if kind == 'Page' else item.get('content_id')
            if content_id is None:
                self.issue(item.get('title', 'Unknown item'), 'No supported content reference.', 'link-only')
                continue
            visit(kind, content_id, label=item.get('title'))
        for path, title, body in documents:
            parser = BodyParser(self.canvas.base, replacements)
            parser.feed(body)
            path.write_text('<!doctype html><html><head><meta charset="utf-8">'
                            '<meta name="viewport" content="width=device-width,initial-scale=1">'
                            f'<title>{html.escape(title)}</title><style>'
                            'body{max-width:900px;margin:40px auto;padding:0 20px;'
                            'font:17px/1.6 system-ui}img{max-width:100%}table{border-collapse:collapse}'
                            'td,th{padding:8px;border:1px solid #aaa}pre{white-space:pre-wrap}'
                            '</style></head><body>' + f'<h1>{html.escape(title)}</h1>'
                            + ''.join(parser.parts) + '</body></html>', encoding='utf-8')

    def course(self, course_id):
        course = self.canvas.one(f'/api/v1/courses/{course_id}')
        folder = self.output / f'{course_id}__{safe_name(course.get("name", course_id))}'
        print(f'\nCourse: {course.get("name", course_id)}')
        modules = list(self.canvas.all(f'/api/v1/courses/{course_id}/modules?per_page=100'))
        if not modules:
            self.issue(str(course_id), 'No accessible modules found.', 'link-only')
        for module in modules:
            print(f'Module: {module["name"]}')
            target = folder / f'{int(module.get("position", 0)):02d}__{module["id"]}__{safe_name(module["name"])}'
            try:
                self.module(str(course_id), module, target)
            except DownloadError as exc:
                self.issue(module['name'], str(exc))

    def finish(self):
        write_json(self.output / 'download-report.json', self.report)
        print(f'\nFinished: {self.downloaded} files downloaded, {self.skipped} unchanged, '
              f'{self.failed} unavailable. See download-report.json for details.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='https://canvas.calpoly.edu')
    parser.add_argument('--output', type=Path, default=Path('Canvas-Materials'))
    parser.add_argument('--course', action='append', type=int, help='Course ID; may be repeated.')
    parser.add_argument('--list', action='store_true', help='Only list courses after signing in.')
    parser.add_argument('--executable', help='Path to Chromium; auto-detected from PATH when available.')
    parser.add_argument('--delay', type=float, default=0.25, help='Delay between requests (seconds).')
    args = parser.parse_args()
    base = args.url.rstrip('/')
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
        parser.error('--url must be an HTTPS origin, such as https://canvas.calpoly.edu')
    if args.delay < 0:
        parser.error('--delay cannot be negative')
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        parser.exit(1, 'Install Playwright first; see README.txt for NixOS and other platforms.\n')
    archive = None
    try:
        with sync_playwright() as playwright:
            browser, context, page = open_browser(playwright, args, base)
            try:
                base = wait_for_canvas(context, page, base)
                canvas = Canvas(base, context.cookies([base]), args.delay)
                course_ids = args.course
                if args.list or not course_ids:
                    courses = list(canvas.all('/api/v1/courses?per_page=100&enrollment_type=student'))
                    for course in courses:
                        if course.get('name'):
                            print(f'{course["id"]}: {course["name"]}')
                    if args.list:
                        return 0
                    selected = input('\nEnter course IDs separated by spaces (or all): ').strip()
                    if selected.lower() == 'all':
                        course_ids = [c['id'] for c in courses if c.get('name')]
                    else:
                        try:
                            course_ids = [int(n) for n in re.split(r'[\s,]+', selected)]
                        except ValueError:
                            raise DownloadError('Enter numeric course IDs or all.') from None
                    if not course_ids:
                        raise DownloadError('No courses selected.')
                archive = Archive(canvas, args.output.resolve())
                for course_id in dict.fromkeys(course_ids):
                    try:
                        archive.course(course_id)
                    except DownloadError as exc:
                        archive.issue(f'Course {course_id}', str(exc))
                archive.finish()
                return 2 if archive.failed else 0
            finally:
                browser.close()
    except (KeyboardInterrupt, EOFError):
        if archive:
            archive.finish()
        print('\nStopped. Completed files are retained; rerun to resume.')
        return 130
    except DownloadError as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1
    except OSError:
        print('Could not access the output folder. Check disk space and permissions.', file=sys.stderr)
        return 1
    except Exception as exc:
        # Browser errors may contain login URLs, so avoid exposing their full text.
        print(f'Browser/runtime error ({type(exc).__name__}). See README.txt for browser setup.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
