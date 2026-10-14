#!/usr/bin/env python3
"""Run real GPU/llvmpipe rendering regressions in an isolated headless GNOME Shell.

Requires GNOME Shell 50, gsettings, dbus-run-session, Python GI and Pillow.
Run with /usr/bin/python3 tests/rendering.py. No desktop settings are changed.
"""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import time

import gi
from PIL import Image, ImageChops

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--scrolling', action='store_true', help='Measure real Chrome scrolling on the GPU at 120 Hz')
parser.add_argument('--baseline', help='Git revision to compare with --scrolling')
args = parser.parse_args()
OUTPUT = Path(tempfile.mkdtemp(prefix='rwc-render-test-'))
EXTENSION = OUTPUT / 'data/gnome-shell/extensions/rwc-test@local'
EXTENSION.mkdir(parents=True)
subprocess.run([ROOT / 'node_modules/.bin/tsc', '--outDir', EXTENSION], cwd=ROOT, check=True)
shutil.copytree(ROOT / 'resources/schemas', EXTENSION / 'schemas')
shutil.copytree(ROOT / 'src/effect/shader', EXTENSION / 'effect/shader')
fixture = 'scrolling.js' if args.scrolling else 'rendering.js'
shutil.copyfile(ROOT / 'tests' / fixture, EXTENSION / 'rendering.js')
if args.scrolling and args.baseline:
    baseline_source = OUTPUT / 'baseline-source'
    baseline_source.mkdir()
    archive = subprocess.check_output(['git', 'archive', args.baseline, 'src', 'tsconfig.json'], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(baseline_source, filter='data')
    (baseline_source / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    baseline = EXTENSION / 'baseline'
    subprocess.run([ROOT / 'node_modules/.bin/tsc', '--project', baseline_source / 'tsconfig.json', '--outDir', baseline], check=True)
    shutil.copytree(baseline_source / 'src/effect/shader', baseline / 'effect/shader')
    effect = baseline / 'effect/rounded_corners_effect.js'
    effect.write_text(effect.read_text().replace('GObject.registerClass({},', "GObject.registerClass({GTypeName: 'RwcScrollingBaselineEffect'},"))
subprocess.run(['glib-compile-schemas', EXTENSION / 'schemas'], check=True)
(EXTENSION / 'metadata.json').write_text(json.dumps({
    'uuid': 'rwc-test@local', 'name': 'Isolated rendering tests',
    'description': 'Temporary test session', 'shell-version': ['50'],
}))
(EXTENSION / 'extension.js').write_text('''
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {run} from './rendering.js';
export default class Test extends Extension {
    enable() {
        global.context.unsafe_mode = true;
        global.rwcRun = scale => {
            global.rwcDone = '';
            run(scale).then(() => global.rwcDone = 'done')
                .catch(e => { logError(e); global.rwcDone = String(e); });
        };
    }
    disable() { global.context.unsafe_mode = false; }
}
''')
env = dict(os.environ, XDG_DATA_HOME=str(OUTPUT / 'data'),
           XDG_CONFIG_HOME=str(OUTPUT / 'config'), XDG_CACHE_HOME=str(OUTPUT / 'cache'),
           GSETTINGS_BACKEND='keyfile', LIBGL_ALWAYS_SOFTWARE='1',
           RWC_TEST_OUTPUT=str(OUTPUT), GNOME_SHELL_SLOWDOWN_FACTOR='0')
if args.scrolling:
    env.pop('LIBGL_ALWAYS_SOFTWARE', None)
script = '''
set -eu
printf '%s' "$DBUS_SESSION_BUS_ADDRESS" > "$RWC_TEST_OUTPUT/bus"
gsettings set org.gnome.shell enabled-extensions "['rwc-test@local']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '50'
exec gnome-shell --headless --no-x11 --wayland-display "rwc-test-$$" --virtual-monitor 1920x1200
'''
if args.scrolling:
    script = script.replace('1920x1200', '2880x1920@120')
log = (OUTPUT / 'shell.log').open('w')
process = subprocess.Popen(['dbus-run-session', '--', 'bash', '-c', script], env=env,
                           stdout=log, stderr=subprocess.STDOUT)
bus = None
chrome = None
chrome_log = None


def call(service, path, interface, method, params=None):
    return bus.call_sync(service, path, interface, method, params, None,
                         Gio.DBusCallFlags.NONE, 15000, None).unpack()


def evaluate(code):
    ok, result = call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell',
                      'Eval', GLib.Variant('(s)', (code,)))
    if not ok:
        raise RuntimeError(result)
    return json.loads(result) if result else None


def set_scale(scale):
    service = 'org.gnome.Mutter.DisplayConfig'
    path = '/org/gnome/Mutter/DisplayConfig'
    state = call(service, path, service, 'GetCurrentState')
    monitor = state[1][0]
    mode = next(m[0] for m in monitor[1] if m[6].get('is-current'))
    params = GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', (state[0], 1,
        [(0, 0, scale, 0, True, [(monitor[0][0], mode, {})])], {}))
    call(service, path, service, 'ApplyMonitorsConfig', params)


def image(name):
    return Image.open(OUTPUT / f'{name}.png').convert('RGB')


def max_difference(a, b):
    return max(extrema[1] for extrema in ImageChops.difference(a, b).getextrema())


try:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            if bus is None:
                bus = Gio.DBusConnection.new_for_address_sync((OUTPUT / 'bus').read_text(),
                    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
                    Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
            if evaluate('typeof global.rwcRun') == 'function':
                break
        except (OSError, RuntimeError, GLib.Error):
            pass
        time.sleep(0.2)
    else:
        raise RuntimeError(f'Test Shell did not initialize; see {OUTPUT}/shell.log')

    if args.scrolling:
        import re
        wayland = re.search("Using Wayland display name '(.*?)'", (OUTPUT / 'shell.log').read_text())[1]
        page = OUTPUT / 'scrolling.html'
        page.write_text('''<!doctype html><meta charset="utf-8"><title>RWC scrolling benchmark</title>
<style>body{margin:0;background:#f5f5f5;font:24px sans-serif}
section{height:120px;border-bottom:1px solid #888;padding:16px;background:linear-gradient(90deg,#def,#fed)}</style>
<body><script>for(let i=0;i<600;i++){let e=document.createElement('section');e.textContent=`Scrolling test row ${i} — native text and borders`;document.body.append(e)}
let start=performance.now();function tick(t){scrollTo(0,((t-start)*0.5)%60000);requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>''')
        chrome_env = dict(env, WAYLAND_DISPLAY=wayland, DBUS_SESSION_BUS_ADDRESS=(OUTPUT / 'bus').read_text())
        chrome_log = (OUTPUT / 'chrome.log').open('w')
        chrome = subprocess.Popen(['google-chrome', f'--user-data-dir={OUTPUT}/chrome-profile',
            '--ozone-platform=wayland', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-component-update', '--password-store=basic', page.as_uri()],
            env=chrome_env, stdout=chrome_log, stderr=subprocess.STDOUT)
        time.sleep(3)

    for scale in ([2.0, 1.5] if args.scrolling else [1.0, 1.25, 1.5, 2.0]):
        set_scale(scale)
        time.sleep(0.3)
        evaluate(f'global.rwcRun({scale}); "started"')
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            result = evaluate('global.rwcDone')
            if result:
                if result != 'done':
                    raise RuntimeError(result)
                break
            time.sleep(0.2)
        else:
            raise RuntimeError('Rendering test timed out')
        label = f'{scale:g}'
        if args.scrolling:
            print((OUTPUT / f'scrolling-{label}.json').read_text(), flush=True)
            continue
        for position in [40, 41]:
            prefix = f'{label}-{position}'
            rect = tuple(round(v * scale) for v in
                         (position + 16, position + 16, position + 304, position + 224))
            corner = (round((position + 2) * scale), round((position + 2) * scale))
            assert image(f'{prefix}-fixed').getpixel(corner) == (200, 0, 200), (prefix, 'corner not clipped')
            native = image(f'{prefix}-native').crop(rect)
            fixed = image(f'{prefix}-fixed').crop(rect)
            difference = max_difference(native, fixed)
            assert difference <= 1, (prefix, 'native mismatch', difference)
            for suffix in ['redrawn', 'reenabled', 'restored']:
                difference = max_difference(image(f'{prefix}-fixed'), image(f'{prefix}-{suffix}'))
                assert difference <= 1, (prefix, suffix, difference)
            expected_fade = Image.blend(Image.new('RGB', fixed.size, (200, 0, 200)), fixed, 128 / 255)
            difference = max_difference(expected_fade, image(f'{prefix}-faded').crop(rect))
            assert difference <= 2, (prefix, 'opacity fallback', difference)
            updated = image(f'{prefix}-updated')
            for x in [5, 160, 315]:
                assert updated.getpixel((round((position + x) * scale), round((position + 120) * scale))) == (170, 200, 100), \
                    (prefix, 'stale interior or edge', x)
            moved_rect = tuple(round(v * scale) for v in
                               (position + 17, position + 17, position + 305, position + 225))
            difference = max_difference(image(f'{prefix}-moved').crop(moved_rect), image(f'{prefix}-moved-native').crop(moved_rect))
            assert difference <= 1, (prefix, 'moved native mismatch', difference)
            difference = max_difference(image(f'{prefix}-clone'), image(f'{prefix}-clone-redrawn'))
            assert difference <= 1, (prefix, 'clone redraw', difference)
            if scale in [1.25, 1.5]:
                seam = (round((position + 80) * scale), round(position * scale) + round(64 * scale) - 2,
                        round((position + 240) * scale), round(position * scale) + round(64 * scale) + 2)
                assert max_difference(image(f'{prefix}-native').crop(seam), image(f'{prefix}-old').crop(seam)) > 1, \
                    (prefix, 'negative control did not reproduce the original seam')
        opaque = image(f'{label}-opaque')
        assert opaque.getpixel((round(140 * scale), round(40 * scale) + int(50 * scale))) == (0, 0, 0), \
            (scale, 'opaque separator became transparent')
        print(f'PASS {scale * 100:g}%: native pixels, transparency, redraw, opacity, content updates, movement, re-enable, clone, opaque separator', flush=True)
finally:
    if chrome:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.kill()
            chrome.wait()
        chrome_log.close()
    if bus:
        try:
            evaluate('global.context.terminate(); "done"')
        except (RuntimeError, GLib.Error):
            pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=5)
    log.close()
    print(f'Render artifacts: {OUTPUT}', flush=True)
