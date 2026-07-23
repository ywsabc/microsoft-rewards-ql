'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('upstream v3.0.2 source retains its published checksum', function () {
    const source = fs.readFileSync(
        path.join(root, 'upstream', 'MicrosoftRewardsAuto-3.0.2.user.js')
    );
    const digest = crypto.createHash('sha256').update(source).digest('hex');
    assert.equal(digest, '12e286fccbac50ce615816582e5f723581076fbbea27877717649bd6b440629f');
});

test('browser extension permissions remain Bing-only and minimal', function () {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(root, 'browser-extension', 'manifest.json'), 'utf8')
    );
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions.sort(), ['clipboardWrite', 'cookies']);
    assert.deepEqual(
        manifest.host_permissions.sort(),
        ['https://*.bing.com/*', 'https://bing.com/*']
    );
    assert.equal(manifest.background, undefined);
    assert.equal(manifest.content_scripts, undefined);
});

test('browser extension contains no outbound network or persistent storage API', function () {
    const source = fs.readFileSync(
        path.join(root, 'browser-extension', 'popup.js'),
        'utf8'
    );
    const forbidden = [
        /\bfetch\s*\(/,
        /\bXMLHttpRequest\b/,
        /\bWebSocket\b/,
        /\bsendBeacon\b/,
        /\bchrome\.storage\b/,
        /\bbrowser\.storage\b/
    ];
    for (const pattern of forbidden) {
        assert.doesNotMatch(source, pattern);
    }
});
