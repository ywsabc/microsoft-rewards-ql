'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('main script exposes QingLong auto-task metadata', function () {
    const source = fs.readFileSync(
        path.join(root, 'microsoft_rewards_ql.js'),
        'utf8'
    );
    assert.match(source, /^\s*\*\s+name:\s+微软积分商城签到（青龙重构版）\s*$/m);
    assert.match(source, /^\s*\*\s+cron:\s+7,27,47 \* \* \* \*\s*$/m);
    assert.match(source, /path\.join\(__dirname, 'sendNotify\.js'\)/);
    assert.match(source, /path\.join\(__dirname, '\.\.', 'sendNotify\.js'\)/);
});

test('upstream v3.0.2 source retains its published checksum', function () {
    const source = fs.readFileSync(
        path.join(root, 'upstream', 'MicrosoftRewardsAuto-3.0.2.user.js')
    );
    const digest = crypto.createHash('sha256').update(source).digest('hex');
    assert.equal(digest, '12e286fccbac50ce615816582e5f723581076fbbea27877717649bd6b440629f');
});

test('browser extension permissions match OAuth and QingLong sync design', function () {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(root, 'browser-extension', 'manifest.json'), 'utf8')
    );
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, '2.0.0');
    assert.deepEqual(manifest.permissions.sort(), ['clipboardWrite', 'cookies', 'storage']);
    assert.deepEqual(
        manifest.host_permissions.sort(),
        ['https://*.bing.com/*', 'https://bing.com/*', 'https://login.live.com/*']
    );
    assert.deepEqual(manifest.optional_host_permissions.sort(), ['http://*/*', 'https://*/*']);
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.equal(manifest.content_scripts, undefined);
});

test('browser extension restricts OAuth and stores secrets in session only', function () {
    const popupSource = fs.readFileSync(
        path.join(root, 'browser-extension', 'popup.js'),
        'utf8'
    );
    const backgroundSource = fs.readFileSync(
        path.join(root, 'browser-extension', 'background.js'),
        'utf8'
    );
    const forbidden = [
        /\bXMLHttpRequest\b/,
        /\bWebSocket\b/,
        /\bsendBeacon\b/,
        /\bchrome\.storage\.local\b/,
        /\bchrome\.storage\.sync\b/,
        /\bbrowser\.storage\b/
    ];
    for (const pattern of forbidden) {
        assert.doesNotMatch(popupSource + '\n' + backgroundSource, pattern);
    }
    for (const requiredCookie of ['_U', '.MSA.Auth', 'tifacfaatcs']) {
        assert.match(popupSource, new RegExp(requiredCookie.replace('.', '\\.')));
    }
    assert.match(backgroundSource, /const CLIENT_ID = '0000000040170455'/);
    assert.match(backgroundSource, /chrome\.storage\.session/);
    assert.match(backgroundSource, /https:\/\/login\.live\.com\/oauth20_authorize\.srf/);
    assert.match(backgroundSource, /https:\/\/login\.live\.com\/oauth20_token\.srf/);
    assert.match(popupSource, /chrome\.permissions\.request/);
    assert.match(popupSource, /chrome\.permissions\.remove/);
    assert.match(popupSource, /\/open\/auth\/token/);
    assert.match(popupSource, /BING_REWARDS_ACCOUNTS/);
});
