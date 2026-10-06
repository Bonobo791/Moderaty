"""Real-router Umami regressions; every collector/external request is intercepted."""
import contextlib
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path
from functools import partial
from playwright.sync_api import sync_playwright, expect

ROOT, FIXTURE, NODE, CHROMIUM = sys.argv[1:]
WEBSITE = '11111111-2222-4333-8444-555555555555'
CONFIG = {'umamiUrl': 'https://collector.example', 'websiteId': WEBSITE, 'hostname': 'localhost'}
if not __debug__:
    raise RuntimeError('Browser regressions require assertions; remove PYTHONOPTIMIZE.')

@contextlib.contextmanager
def server(mode, **settings):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    for key in ['ANALYTICS_ENABLED', 'UMAMI_URL', 'UMAMI_WEBSITE_ID', 'ANALYTICS_ALLOWED_HOSTNAMES']:
        env.pop(key, None)
    env.update({'PORT': str(port), 'HOST': '127.0.0.1', 'ORIGIN': f'http://127.0.0.1:{port}',
                'TURSO_DATABASE_URL': 'file:' + str(Path(FIXTURE) / 'fixture.db'), 'TURSO_AUTH_TOKEN': '',
                'ANALYTICS_ENABLED': 'true', 'UMAMI_URL': CONFIG['umamiUrl'], 'UMAMI_WEBSITE_ID': WEBSITE,
                'ANALYTICS_ALLOWED_HOSTNAMES': 'localhost,127.0.0.1'})
    if mode == 'default':
        for key in ['ANALYTICS_ENABLED', 'UMAMI_URL', 'UMAMI_WEBSITE_ID', 'ANALYTICS_ALLOWED_HOSTNAMES']:
            env.pop(key, None)
    env.update(settings)
    log_path = Path(FIXTURE) / (mode + '.log')
    with log_path.open('w') as log:
        process = subprocess.Popen([NODE, str(Path(ROOT) / 'build/index.js')], cwd=ROOT, env=env, stdout=log, stderr=log)
        base = f'http://localhost:{port}'
        try:
            end = time.monotonic() + 15
            while True:
                assert process.poll() is None, log_path.read_text()
                try:
                    urllib.request.urlopen(base + '/api/analytics', timeout=1).close()
                    break
                except urllib.error.HTTPError:
                    break  # Invalid configuration is an expected ready-server 503.
                except urllib.error.URLError:
                    assert time.monotonic() < end, 'server did not start'
                    time.sleep(0.05)
            yield base, log_path
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

@contextlib.contextmanager
def fixture(browser, base, init=None, fail=False):
    context = browser.new_context(viewport={'width': 1400, 'height': 900})
    events, config_requests, reports, google, errors = [], [], [], [], []
    context.route('**/*', lambda route: intercept(route, base, (events, config_requests, reports, google), fail))
    if init:
        context.add_init_script(init)
    page = context.new_page()
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    try:
        yield context, page, events, config_requests, reports, errors
        assert google == [], google
    finally:
        context.close()


def intercept(route, base, observations, fail):
    events, config_requests, reports, google = observations
    request = route.request
    hostname = urlsplit(request.url).hostname or ''
    if 'google' in hostname or hostname.endswith(('doubleclick.net', 'gstatic.com')):
        google.append(request.url)
    if request.url.startswith('https://collector.example/'):
        fulfill_collector(route, events, fail)
        return
    if not request.url.startswith((base, base.replace('localhost', '127.0.0.1'))):
        route.abort()
        return
    if '/api/analytics' in request.url:
        (reports if request.method == 'POST' else config_requests).append(request)
    route.continue_()


def fulfill_collector(route, events, fail):
    request = route.request
    if request.method == 'POST':
        events.append({'payload': request.post_data_json, 'headers': request.all_headers()})
    failed = fail is True or (fail == 'first' and len(events) == 1)
    route.fulfill(status=500 if failed else 200, json={'cache': 'browser-cache'} if not failed else {'private': 'synthetic-private-response'},
                  headers={'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-umami-cache', 'access-control-allow-methods': 'POST,OPTIONS'})


def ready(page):
    page.wait_for_function('document.querySelector(".measurement-preference button")?.disabled === false || document.querySelector(".measurement-preference [role=status]") !== null')


def wait(page, condition):
    end = time.monotonic() + 8
    while not condition():
        assert time.monotonic() < end, 'timed out waiting for measurement result'
        page.wait_for_timeout(30)


def quiet(page):
    page.wait_for_timeout(200)


def pageviews(events):
    return [event['payload']['payload'] for event in events if 'name' not in event['payload']['payload']]


def hold_route(routes, route):
    routes.append(route)


def clicks(events):
    return [event['payload']['payload'] for event in events if 'name' in event['payload']['payload']]

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox'])
        try:
            for mode, settings in [('default', {}), ('denied', {'ANALYTICS_ALLOWED_HOSTNAMES': 'unapproved.example'}), ('disabled-again', {'ANALYTICS_ENABLED': 'false'})]:
                with server(mode, **settings) as (base, _), fixture(browser, base) as (_, page, events, config_requests, _, _):
                    page.goto(base + '/'); ready(page); quiet(page)
                    assert events == [] and len(config_requests) == 1, mode
                    print(mode + ': zero collector requests', flush=True)
            with server('enabled') as (base, _):
                with fixture(browser, base) as (context, page, _, _, reports, _):
                    held = []
                    context.route('https://collector.example/**', partial(hold_route, held))
                    page.goto(base + '/'); ready(page); wait(page, lambda: len(held) == 1)
                    page.evaluate('Object.defineProperty(window, "localStorage", { get: () => { throw new Error("synthetic-storage-error"); } }); window.dispatchEvent(new Event("moderaty:analytics-preference"));')
                    wait(page, lambda: len(reports) == 1)
                    held[0].fulfill(json={'cache': 'late-response'}, headers={'access-control-allow-origin': '*'})
                    quiet(page)
                    expect(page.locator('.analytics-status')).to_contain_text('Optional usage measurement is unavailable.')
                    print('late successful pageview cannot clear a newer preference failure', flush=True)
                with fixture(browser, base, fail='first') as (_, page, events, _, reports, _):
                    page.goto(base + '/'); ready(page); wait(page, lambda: len(reports) == 1)
                    expect(page.locator('.analytics-status')).to_contain_text('Optional usage measurement is unavailable.')
                    page.locator('a[data-moderaty-event="pricing_click"][data-moderaty-placement="nav"]').click()
                    page.wait_for_url('**/pricing'); wait(page, lambda: len(pageviews(events)) == 2)
                    expect(page.locator('.analytics-status')).to_have_count(0)
                    print('successful later pageview clears the prior collection failure status', flush=True)
                with fixture(browser, base) as (context, page, events, _, _, _):
                    held = []
                    context.route('**/api/analytics?*', partial(hold_route, held))
                    page.goto(base + '/'); ready(page); wait(page, lambda: len(held) == 1)
                    page.locator('a[data-moderaty-event="pricing_click"][data-moderaty-placement="nav"]').click()
                    page.wait_for_url('**/pricing'); wait(page, lambda: len(held) == 2)
                    held[-1].fulfill(json=CONFIG)
                    wait(page, lambda: len(pageviews(events)) == 1 and len(clicks(events)) == 1)
                    assert pageviews(events)[0]['url'] == '/pricing'
                    assert clicks(events)[0] == {'website': WEBSITE, 'hostname': 'localhost', 'url': '/', 'title': 'Home', 'referrer': '', 'name': 'pricing_click', 'data': {'placement': 'nav'}}
                    print('early public CTA survives canceled configuration with its frozen original page', flush=True)
                for start, destination in [('/', '/#regulars'), ('/', '/?ignored=value'),
                                           ('/?utm_source=google&utm_medium=cpc', '/?utm_medium=cpc&ignored=value&utm_source=google')]:
                    with fixture(browser, base) as (context, page, events, _, _, _):
                        held = []
                        context.route('**/api/analytics?*', partial(hold_route, held))
                        page.goto(base + start); ready(page); wait(page, lambda held=held: len(held) == 1)
                        page.evaluate('(href) => { const link = document.createElement("a"); link.href = href; link.id = "equivalent-page"; link.textContent = "Equivalent page"; document.body.append(link); }', destination)
                        page.locator('#equivalent-page').click(); page.wait_for_url(base + destination); quiet(page)
                        held[0].fulfill(json=CONFIG)
                        wait(page, lambda events=events: len(pageviews(events)) == 1)
                        assert len(held) == 1, 'same-canonical navigation restarted configuration'
                print('pending initial pageview survives hash, ignored query and reordered UTM navigation', flush=True)
                with fixture(browser, base) as (context, page, events, _, _, _):
                    page.goto(base + '/?utm_source=google&utm_medium=cpc&utm_campaign=alice&gclid=secret#section', referer='https://ref.example/private?email=secret')
                    ready(page); wait(page, lambda: len(pageviews(events)) == 1)
                    expected = {'website': WEBSITE, 'hostname': 'localhost', 'url': '/?utm_source=google&utm_medium=cpc', 'title': 'Home', 'referrer': 'https://ref.example'}
                    assert pageviews(events) == [expected], pageviews(events)
                    assert events[0]['headers'].get('referer') is None and events[0]['headers'].get('cookie') is None
                    assert page.evaluate('typeof window.dataLayer') == 'undefined'
                    assert page.locator('script[src*="collector"], script[src*="google"], iframe[src*="google"]').count() == 0
                    page.evaluate('window.documentToken = "same-document"')
                    page.locator('a[href="#regulars"]').click(); quiet(page); assert len(pageviews(events)) == 1
                    page.locator('a[data-moderaty-event="pricing_click"][data-moderaty-placement="nav"]').click()
                    page.wait_for_url('**/pricing'); wait(page, lambda: len(pageviews(events)) == 2 and len(clicks(events)) == 1)
                    assert clicks(events)[0] == {**expected, 'name': 'pricing_click', 'data': {'placement': 'nav'}}
                    assert pageviews(events)[1]['url'] == '/pricing'
                    assert pageviews(events)[1]['referrer'] == ''
                    assert events[-1]['headers']['x-umami-cache'] == 'browser-cache'
                    page.go_back(); wait(page, lambda: len(pageviews(events)) == 3)
                    assert pageviews(events)[2]['referrer'] == ''
                    assert page.evaluate('window.documentToken') == 'same-document'
                    source = page.locator('a[data-moderaty-event="source_click"][data-moderaty-placement="nav"]')
                    source.click(modifiers=['Control']); source.click(button='middle')
                    wait(page, lambda: len([e for e in clicks(events) if e['name'] == 'source_click']) == 2)
                    for popup in context.pages[1:]: popup.close()
                    page.locator('a[data-moderaty-event="pricing_click"][data-moderaty-placement="home_pricing"] span').click()
                    page.wait_for_url('**/pricing'); wait(page, lambda: len(pageviews(events)) == 4)
                    page.go_back(); wait(page, lambda: len(pageviews(events)) == 5)
                    keyboard = page.locator('a[data-moderaty-event="pricing_click"][data-moderaty-placement="nav"]')
                    keyboard.focus(); keyboard.press('Enter'); page.wait_for_url('**/pricing'); wait(page, lambda: len(pageviews(events)) == 6)
                    page.go_back(); wait(page, lambda: len(pageviews(events)) == 7)
                    page.locator('a[data-moderaty-event="connect_click"][data-moderaty-placement="hero"]').click()
                    page.wait_for_url('**/login'); wait(page, lambda: any(e['name'] == 'connect_click' for e in clicks(events)))
                    assert page.evaluate('window.documentToken') == 'same-document', 'private navigation forced a reload'
                    count = len(events); page.go_back(); ready(page); quiet(page)
                    assert len(events) == count, 'Back revived a private-visited document'
                    page.go_forward(); page.wait_for_url('**/login'); page.go_back(); ready(page); quiet(page)
                    assert len(events) == count, 'Forward/Back revived collection'
                    print('public SPA/hash/Back, nested/keyboard/modifier/middle clicks and login keepalive passed', flush=True)
                with fixture(browser, base) as (_, page, events, _, _, _):
                    page.goto(base + '/?%74OKEN=secret'); ready(page); quiet(page); assert events == []
                    page.locator('a[data-moderaty-event="pricing_click"][data-moderaty-placement="nav"]').click()
                    page.wait_for_url('**/pricing'); quiet(page); assert events == []
                    print('credential-started document stays ineligible after real SPA navigation', flush=True)
                with fixture(browser, base) as (context, page, events, _, _, _):
                    second = context.new_page(); page.goto(base + '/'); second.goto(base + '/'); ready(page); ready(second)
                    wait(page, lambda: len(events) == 2)
                    page.get_by_role('button', name='Disable audience measurement').click(); quiet(second)
                    expect(page.get_by_role('button', name='Allow audience measurement')).not_to_have_attribute('aria-pressed')
                    expect(page.get_by_text('Your preference blocks audience measurement.')).to_be_visible()
                    second.locator('a[data-moderaty-event="pricing_click"][data-moderaty-placement="nav"]').click()
                    second.wait_for_url('**/pricing'); quiet(second); assert len(events) == 2
                    page.get_by_role('button', name='Allow audience measurement').click(); ready(page); wait(page, lambda: len(events) == 3)
                    assert 'x-umami-cache' not in events[-1]['headers']
                    assert page.evaluate('Object.keys(localStorage)') == []
                    print('same-tab/cross-tab opt-out, explicit opt-in reload and cache reset passed', flush=True)
                for name, init in [
                    ('DNT', "Object.defineProperty(navigator, 'doNotTrack', {get: () => '1'})"),
                    ('GPC', "Object.defineProperty(navigator, 'globalPrivacyControl', {get: () => true})"),
                    ('stored opt-out', "localStorage.setItem('moderaty.analytics.optOut', '1')"),
                    ('storage failure', "Object.defineProperty(window, 'localStorage', {get: () => {throw new Error('synthetic-private-storage')}})")]:
                    with fixture(browser, base, init=init) as (_, page, events, config_requests, reports, errors):
                        page.goto(base + '/'); ready(page); quiet(page)
                        assert events == [] and config_requests == [], name
                        if name == 'storage failure':
                            wait(page, lambda: len(reports) == 1)
                            assert reports[0].post_data is None and reports[0].all_headers().get('referer') is None
                            expect(page.get_by_role('status').filter(has_text='Optional usage measurement')).to_contain_text('Optional usage measurement is unavailable.')
                            assert not any('synthetic-private-storage' in error for error in errors)
                        else:
                            assert reports == [], name
                        print(name + ': zero configuration/collector requests', flush=True)
                with fixture(browser, base) as (context, page, events, _, _, _):
                    context.route('**/api/analytics?*', lambda route: route.fulfill(json=CONFIG))
                    page.goto(base.replace('localhost', '127.0.0.1') + '/'); ready(page); quiet(page); assert events == []
                    print('copied approved configuration on another hostname rejected', flush=True)
                with fixture(browser, base) as (context, page, events, _, _, _):
                    held = []
                    context.route('**/api/analytics?*', partial(hold_route, held))
                    page.goto(base + '/'); ready(page); wait(page, lambda: len(held) == 1)
                    page.locator('a[data-moderaty-event="connect_click"][data-moderaty-placement="hero"]').click(); page.wait_for_url('**/login')
                    try: held[0].fulfill(json=CONFIG)
                    except Exception: pass  # Browser cancellation can invalidate the held route.
                    page.go_back(); ready(page); quiet(page); assert events == []
                    print('late configuration after private navigation cannot activate collection', flush=True)
                with fixture(browser, base, fail=True) as (_, page, events, _, reports, errors):
                    page.goto(base + '/'); ready(page); wait(page, lambda: len(reports) == 1)
                    expect(page.get_by_role('status')).to_contain_text('Optional usage measurement is unavailable.')
                    report = reports[0]
                    assert report.post_data is None and report.all_headers().get('referer') is None and report.all_headers().get('cookie') is None
                    assert not any('synthetic-private-response' in error for error in errors)
                    assert len(events) == 1
                    print('collector failure: generic status, payload-free diagnostic and no retry passed', flush=True)
            with server('invalid', UMAMI_WEBSITE_ID='invalid') as (base, log), fixture(browser, base) as (_, page, events, _, _, _):
                page.goto(base + '/'); ready(page); expect(page.get_by_role('status')).to_contain_text('Optional usage measurement is unavailable.')
                assert events == [] and 'analytics configuration failed:' in log.read_text()
                print('invalid enabled settings fail closed with a server diagnostic', flush=True)
        finally:
            browser.close()
    print('All Umami browser regressions passed against one unchanged node build.', flush=True)


if __name__ == "__main__":
    main()
