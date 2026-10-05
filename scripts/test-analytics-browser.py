"""Local built-server regression. Requires Python Playwright and Chromium.

Build with MODERATY_ADAPTER=node first. Uses fixture configuration and a local
SQLite file; intercepts GTM so no Google requests leave the browser.
"""
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = 'http://127.0.0.1:4107'
CASES = [
    ('defaults', {}, '127.0.0.1', 0),
    ('enabled', {'ANALYTICS_ENABLED': 'true', 'GTM_ID': 'GTM-RUNTIME456',
                 'GTM_ALLOWED_HOSTNAMES': '127.0.0.1,localhost'}, '127.0.0.1', 1),
    ('allowed-alias', {'ANALYTICS_ENABLED': 'true', 'GTM_ID': 'GTM-RUNTIME456',
                       'GTM_ALLOWED_HOSTNAMES': '127.0.0.1,localhost'}, 'localhost', 1),
    ('denied-host', {'ANALYTICS_ENABLED': 'true', 'GTM_ID': 'GTM-RUNTIME456',
                     'GTM_ALLOWED_HOSTNAMES': '127.0.0.1'}, 'localhost', 0),
    ('disabled-again', {'ANALYTICS_ENABLED': 'false', 'GTM_ID': 'GTM-RUNTIME456',
                        'GTM_ALLOWED_HOSTNAMES': '127.0.0.1'}, '127.0.0.1', 0),
    ('invalid', {'ANALYTICS_ENABLED': 'true', 'GTM_ID': 'invalid',
                 'GTM_ALLOWED_HOSTNAMES': '127.0.0.1'}, '127.0.0.1', 0),
]


def click_route(page, path):
    # A real link handled by the hydrated SvelteKit router, without goto().
    page.evaluate("""path => {
        const link = document.createElement('a');
        link.href = path; link.id = 'fixture-navigation'; link.textContent = 'Fixture';
        document.body.appendChild(link);
    }""", path)
    page.locator('#fixture-navigation').click()
    page.wait_for_url(f'**{path}')
    page.wait_for_load_state('networkidle')


def verify_navigation(page, requests, observed):
    page.goto(f'{ORIGIN}/privacy', wait_until='networkidle')
    marker = page.evaluate('window.fixtureDocument')
    assert page.evaluate('window.fixtureGtmLoaded') is True
    click_route(page, '/login')
    assert page.evaluate('window.fixtureDocument') != marker, 'GTM document survived entry to login'
    assert page.evaluate('typeof window.dataLayer') == 'undefined'
    page.go_back(wait_until='networkidle')
    assert page.url == f'{ORIGIN}/privacy'
    page.go_forward(wait_until='networkidle')
    assert page.url == f'{ORIGIN}/login'
    assert page.evaluate('typeof window.dataLayer') == 'undefined'

    # Referrer stays fixed on SPA navigation; force a new document on entry
    # to public pages so Back cannot expose sensitive same-document history.
    page.goto(f'{ORIGIN}/contact?token=fixture-secret', wait_until='networkidle')
    before = len(requests)
    marker = page.evaluate('window.fixtureDocument')
    click_route(page, '/privacy')
    assert page.evaluate('window.fixtureDocument') != marker, 'Sensitive history survived entry to public page'
    assert len(requests) == before, 'Sensitive referrer exposed to GTM'
    assert page.evaluate('typeof window.dataLayer') == 'undefined'
    page.go_back(wait_until='networkidle')
    assert page.url == f'{ORIGIN}/contact?token=fixture-secret'
    assert page.evaluate('typeof window.dataLayer') == 'undefined'
    assert all('/login' not in url and 'fixture-secret' not in url for url in observed), observed


report = []
with tempfile.TemporaryDirectory(prefix='moderaty-analytics-') as fixture, sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for name, config, hostname, wanted in CASES:
            env = os.environ.copy()
            for key in ['ANALYTICS_ENABLED', 'GTM_ID', 'GTM_ALLOWED_HOSTNAMES', 'TURSO_AUTH_TOKEN']:
                env.pop(key, None)
            env.update({'HOST': '127.0.0.1', 'PORT': '4107', 'ORIGIN': ORIGIN,
                        'TURSO_DATABASE_URL': f'file:{fixture}/fixture.db'})
            env.update(config)
            with open(Path(fixture) / f'{name}.log', 'w') as log:
                server = subprocess.Popen(['node', 'build/index.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 10
                    while True:
                        try:
                            urllib.request.urlopen(f'{ORIGIN}/privacy', timeout=1).close()
                            break
                        except (urllib.error.URLError, ConnectionError):
                            assert server.poll() is None, f'{name}: server exited'
                            assert time.monotonic() < deadline, f'{name}: startup timeout'
                            time.sleep(0.05)
                    context = browser.new_context(service_workers='block')
                    observed, requests = [], []
                    page = context.new_page()
                    page.expose_function('fixtureObserve', lambda url: observed.append(url))
                    page.add_init_script('window.fixtureDocument = crypto.randomUUID();')
                    page.on('request', lambda req: requests.append(req.url) if 'googletagmanager.com' in req.url else None)
                    page.route('https://www.googletagmanager.com/**', lambda route: route.fulfill(
                        content_type='text/javascript', body="""window.fixtureGtmLoaded = true;
                        window.fixtureObserve(location.href);
                        addEventListener('popstate', () => window.fixtureObserve(location.href));"""))
                    page.goto(f'http://{hostname}:4107/privacy', wait_until='networkidle')
                    assert len(requests) == wanted, (name, requests)
                    assert page.locator('iframe[src*="googletagmanager"]').count() == 0
                    assert page.get_by_role('status').count() == (1 if name == 'invalid' else 0)
                    if wanted:
                        assert page.evaluate('window.dataLayer[0].event') == 'gtm.js'
                    else:
                        assert page.evaluate('typeof window.dataLayer') == 'undefined'
                    if name == 'enabled':
                        verify_navigation(page, requests, observed)
                    before = len(requests)
                    for path in ['/login', '/account-deleted', '/invite/fixture-secret',
                                 '/contact/verify?token=fixture-secret', '/consent?state=fixture-secret',
                                 '/privacy?token=fixture-secret']:
                        page.goto(f'http://{hostname}:4107{path}', wait_until='networkidle')
                        assert len(requests) == before, (name, path, requests)
                        assert page.evaluate('typeof window.dataLayer') == 'undefined'
                        assert page.get_by_role('status').count() == 0
                    report.append({'case': name, 'initial_gtm_requests': wanted, 'sensitive_pages': 'passed'})
                    context.close()
                finally:
                    server.terminate()
                    server.wait(timeout=5)
    finally:
        browser.close()
print(json.dumps({'same_build_runtime_cases': report, 'navigation_back_forward': 'passed',
                  'real_google_requests': 0}, indent=2))
