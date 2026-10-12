import http.cookiejar
import io
import tempfile
import types
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

from canvas_download import (Archive, BodyParser, Canvas, DownloadError, reference, safe_name,
                             canvas_page, main, open_browser, wait_for_canvas)


BASE = 'https://canvas.calpoly.edu'


class Response(io.BytesIO):
    def __init__(self, body=b'lecture', headers=None, url=BASE + '/files/7/download'):
        super().__init__(body)
        self.headers = headers or {'Content-Type': 'application/pdf'}
        self.url = url


class FakeCanvas:
    base = BASE

    def __init__(self):
        self.fetches = 0
        self.updated = '2026-10-01T00:00:00Z'
        self.payload = b'lecture'
        self.failure = False

    def one(self, path):
        if path == '/api/v1/files/7':
            return {'filename': '../Lecture.pdf', 'url': BASE + '/files/7/download',
                    'size': 7, 'updated_at': self.updated, 'content-type': 'application/pdf'}
        if path == '/api/v1/courses/1/pages/start':
            return {'title': 'Notes', 'body': '<a href="/courses/1/files/7/download">PDF</a>'
                    '<a href="/courses/1/pages/other">Next</a>'}
        if path == '/api/v1/courses/1/pages/other':
            return {'title': 'More', 'body': '<a href="/courses/1/pages/start">Back</a>'
                    '<a href="https://example.org/notes">External</a>'}
        raise DownloadError('HTTP 403; unavailable')

    def all(self, path):
        if '/modules/2/items' in path:
            yield {'type': 'Page', 'page_url': 'start', 'title': 'Notes'}
            yield {'type': 'File', 'content_id': 7, 'title': 'Lecture'}
            yield {'type': 'ExternalTool', 'title': 'Video', 'html_url': BASE + '/courses/1/external_tools/3'}

    def open(self, url):
        self.fetches += 1
        if self.failure:
            class Broken(Response):
                def read(self, *args):
                    raise OSError('interrupted')
            return Broken()
        return Response(self.payload)


class Tests(unittest.TestCase):
    @staticmethod
    def page(url, ready):
        page = MagicMock()
        page.url = url
        page.is_closed.return_value = False
        page.evaluate.return_value = ready
        return page

    def test_canvas_found_in_new_tab_after_sso(self):
        login = self.page('https://login.microsoftonline.com/signin?secret=example', False)
        dashboard = self.page('https://calpoly.instructure.com/', True)
        context = types.SimpleNamespace(pages=[login, dashboard])
        page, origin = canvas_page(context, login, BASE)
        self.assertIs(page, dashboard)
        self.assertEqual(origin, 'https://calpoly.instructure.com')
        login.evaluate.assert_not_called()

    def test_calpoly_canvas_alias_recognized(self):
        dashboard = self.page('https://learn.calpoly.edu/courses/1', True)
        page, origin = canvas_page(types.SimpleNamespace(pages=[dashboard]), dashboard, BASE)
        self.assertIs(page, dashboard)
        self.assertEqual(origin, 'https://learn.calpoly.edu')

    def test_untrusted_domain_cannot_supply_canvas_cookies(self):
        page = self.page('https://calpoly.edu.evil.example/courses/1', True)
        self.assertEqual(canvas_page(types.SimpleNamespace(pages=[page]), page, BASE),
                         (None, None))
        page.evaluate.assert_not_called()

    def test_login_waits_instead_of_raising_domain_error(self):
        login = self.page('https://sso.calpoly.edu/login', False)
        context = types.SimpleNamespace(pages=[login])
        with patch('builtins.input', return_value='') as entered, patch(
                'canvas_download.canvas_page', side_effect=[
                    (None, None), (self.page(BASE + '/', True), BASE)]):
            self.assertEqual(wait_for_canvas(context, login, BASE), BASE)
            self.assertEqual(entered.call_count, 2)

    def test_chromium_uses_auto_detected_executable(self):
        engine = MagicMock()
        browser = engine.chromium.launch.return_value
        context = browser.new_context.return_value
        page = context.new_page.return_value
        args = types.SimpleNamespace(executable=None)
        with patch('canvas_download.shutil.which', return_value='/nix/store/test/bin/chromium'):
            result = open_browser(engine, args, BASE)
        self.assertEqual(result, (browser, context, page))
        engine.chromium.launch.assert_called_once_with(
            headless=False, executable_path='/nix/store/test/bin/chromium')
        engine.chromium.connect_over_cdp.assert_not_called()
        page.goto.assert_called_once_with(BASE, wait_until='domcontentloaded', timeout=120000)
        browser.close.assert_not_called()

    def test_main_closes_its_chromium_session(self):
        browser = MagicMock()
        context = types.SimpleNamespace(cookies=lambda _: [])
        with patch.dict('sys.modules', {'playwright': MagicMock(),
                                       'playwright.sync_api': MagicMock()}), patch(
                'sys.argv', ['canvas_download.py', '--list']), patch(
                'canvas_download.open_browser', return_value=(browser, context, None)), patch(
                'canvas_download.wait_for_canvas', return_value=BASE), patch.object(
                Canvas, 'all', return_value=iter([])):
            self.assertEqual(main(), 0)
        browser.close.assert_called_once()

    def test_references_and_external_origin(self):
        for path in ['/files/7', '/courses/1/files/7/download?download_frd=1',
                     '/api/v1/courses/1/files/7', '/api/v1/files/7']:
            self.assertEqual(reference(BASE, path), ('File', '7', None))
        self.assertEqual(reference(BASE, '/courses/1/pages/hello%20world'),
                         ('Page', 'hello world', '1'))
        self.assertIsNone(reference(BASE, 'https://evil.example/files/7'))
        self.assertIsNone(reference(BASE, 'javascript:alert(1)'))

    def test_filename_containment(self):
        self.assertNotIn('/', safe_name('../../lecture.pdf'))
        self.assertNotIn('\\', safe_name('C:\\lecture.pdf'))
        self.assertNotEqual(safe_name('CON'), 'CON')
        self.assertEqual(safe_name('..'), 'untitled')

    def test_html_sanitization_and_attachment_rewrite(self):
        body = ('<script><a href="/files/666">bad</a></script>'
                '<a href="/files/7" onclick="alert(1)">PDF</a>'
                '<img src="/files/7" onerror="alert(1)">'
                '<a href="javascript:alert(1)">unsafe</a>'
                '<iframe src="https://example.org/video"></iframe>')
        parser = BodyParser(BASE, {BASE + '/files/7': '7__Lecture.pdf'})
        parser.feed(body)
        rendered = ''.join(parser.parts)
        self.assertIn('href="7__Lecture.pdf"', rendered)
        self.assertNotIn('script', rendered)
        self.assertNotIn('iframe', rendered)
        self.assertNotIn('onclick', rendered)
        self.assertNotIn('javascript:', rendered)
        self.assertNotIn(BASE + '/files/666', parser.links)
        self.assertIn('https://example.org/video', parser.links)

    def test_cookie_isolation_on_download_redirects(self):
        canvas = Canvas(BASE, [{'name': 'canvas_session', 'value': 'test', 'path': '/',
                                'secure': True, 'expires': -1}], delay=0)
        processor = next(h for h in canvas.opener.handlers
                         if isinstance(h, urllib.request.HTTPCookieProcessor))
        for target, expected in [(BASE + '/api/v1/courses', True),
                                 ('https://cdn.example.org/file', False),
                                 ('https://sso.calpoly.edu/login', False),
                                 ('https://sub.canvas.calpoly.edu/file', False)]:
            request = urllib.request.Request(target)
            processor.cookiejar.add_cookie_header(request)
            self.assertEqual(request.has_header('Cookie'), expected, target)

    def test_pagination_and_canvas_json_prefix(self):
        canvas = Canvas(BASE, [], delay=0)
        replies = [Response(b'while(1);[{"id":1}]',
                            {'Link': '<' + BASE + '/api/v1/courses?page=2>; rel="next"'}),
                   Response(b'[{"id":2}]')]
        with patch.object(canvas, 'open', side_effect=replies):
            self.assertEqual(list(canvas.all('/api/v1/courses')), [{'id': 1}, {'id': 2}])

    def test_pagination_refuses_external_and_repeated_urls(self):
        canvas = Canvas(BASE, [], delay=0)
        reply = Response(b'[]', {'Link': '<https://evil.example/api/v1/courses>; rel="next"'})
        with patch.object(canvas, 'open', return_value=reply) as opened:
            with self.assertRaises(DownloadError):
                list(canvas.all('/api/v1/courses'))
            self.assertEqual(opened.call_count, 1)
        with patch.object(canvas, 'api', return_value=([], '/api/v1/courses')):
            with self.assertRaises(DownloadError):
                list(canvas.all('/api/v1/courses'))

    def test_login_html_is_not_treated_as_api_json(self):
        canvas = Canvas(BASE, [], delay=0)
        with patch.object(canvas, 'open', return_value=Response(b'<html>Login</html>')):
            with self.assertRaisesRegex(DownloadError, 'login page'):
                canvas.one('/api/v1/courses')

    def test_cache_skip_and_corruption_repair(self):
        with tempfile.TemporaryDirectory() as root:
            fake = FakeCanvas()
            archive = Archive(fake, Path(root))
            folder = Path(root) / 'module'
            folder.mkdir()
            path = archive.file('1', folder, '7')
            archive.file('1', folder, '7')
            self.assertEqual(fake.fetches, 1)
            path.write_bytes(b'CORRUPT')  # Same size: checksum still detects it.
            archive.file('1', folder, '7')
            self.assertEqual(fake.fetches, 2)
            self.assertEqual(path.read_bytes(), b'lecture')
            archive = Archive(fake, Path(root))  # Cache survives another process.
            archive.file('1', folder, '7')
            self.assertEqual(fake.fetches, 2)

    def test_partial_download_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as root:
            fake = FakeCanvas()
            archive = Archive(fake, Path(root))
            path = archive.file('1', Path(root), '7')
            fake.updated = 'new'
            fake.failure = True
            with self.assertRaises(DownloadError):
                archive.file('1', Path(root), '7')
            self.assertEqual(path.read_bytes(), b'lecture')
            self.assertFalse(list(Path(root).glob('*.part')))

    def test_wrong_download_size_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            fake = FakeCanvas()
            fake.payload = b'short'
            archive = Archive(fake, Path(root))
            with self.assertRaisesRegex(DownloadError, 'size differs'):
                archive.file('1', Path(root), '7')
            self.assertFalse(list(Path(root).glob('*.pdf')))
            self.assertFalse(archive.cache)

    def test_module_cycle_attachment_deduplication_and_reports(self):
        with tempfile.TemporaryDirectory() as root:
            fake = FakeCanvas()
            archive = Archive(fake, Path(root))
            archive.module('1', {'id': 2}, Path(root) / 'module')
            self.assertEqual(fake.fetches, 1)
            pages = list((Path(root) / 'module').glob('*.html'))
            self.assertEqual(len(pages), 2)
            notes = next(p for p in pages if '__Notes' in p.name).read_text()
            self.assertIn('href="7__', notes)
            self.assertIn('page_1_other__More.html', notes)
            self.assertTrue(any(row.get('detail') == 'ExternalTool' for row in archive.report))
            self.assertTrue(any(row.get('url') == 'https://example.org/notes' for row in archive.report))

    def test_unavailable_item_does_not_stop_other_downloads(self):
        with tempfile.TemporaryDirectory() as root:
            fake = FakeCanvas()
            with patch.object(fake, 'all', return_value=iter([
                    {'type': 'File', 'content_id': 99, 'title': 'Locked'},
                    {'type': 'File', 'content_id': 7, 'title': 'Lecture'}])):
                archive = Archive(fake, Path(root))
                archive.module('1', {'id': 2}, Path(root) / 'module')
                self.assertEqual(archive.failed, 1)
                self.assertEqual(archive.downloaded, 1)


if __name__ == '__main__':
    unittest.main()
