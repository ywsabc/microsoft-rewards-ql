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
    assert.equal(manifest.version, '2.1.0');
    assert.equal(manifest.minimum_chrome_version, '102');
    assert.deepEqual(manifest.permissions.sort(), ['clipboardWrite', 'cookies', 'storage']);
    assert.deepEqual(
        manifest.host_permissions.sort(),
        ['https://*.bing.com/*', 'https://bing.com/*', 'https://login.live.com/*']
    );
    assert.deepEqual(manifest.optional_host_permissions.sort(), ['http://*/*', 'https://*/*']);
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.equal(manifest.action.default_popup, undefined);
    assert.equal(manifest.content_scripts, undefined);
});

test('browser extension keeps account tokens in session and persists only opted-in panel settings', function () {
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
        /\bchrome\.storage\.sync\b/,
        /\bbrowser\.storage\b/
    ];
    for (const pattern of forbidden) {
        assert.doesNotMatch(popupSource + '\n' + backgroundSource, pattern);
    }
    for (const requiredCookie of ['_U', '.MSA.Auth']) {
        assert.match(popupSource, new RegExp(requiredCookie.replace('.', '\\.')));
    }
    assert.match(
        popupSource,
        /const REQUIRED_AUTH_COOKIES = \['_U', '\.MSA\.Auth'\]/
    );
    assert.match(backgroundSource, /const CLIENT_ID = '0000000040170455'/);
    assert.match(backgroundSource, /chrome\.storage\.session/);
    assert.doesNotMatch(backgroundSource, /chrome\.storage\.local/);
    assert.match(backgroundSource, /chrome\.action\.onClicked/);
    assert.match(popupSource, /chrome\.storage\.local/);
    assert.match(
        popupSource,
        /const SAVED_SETTING_IDS = \[\s*'account-name',\s*'ql-url',\s*'ql-client-id',\s*'ql-client-secret'\s*\]/
    );
    assert.match(backgroundSource, /https:\/\/login\.live\.com\/oauth20_authorize\.srf/);
    assert.match(backgroundSource, /https:\/\/login\.live\.com\/oauth20_token\.srf/);
    assert.match(popupSource, /chrome\.permissions\.request/);
    assert.match(popupSource, /chrome\.permissions\.remove/);
    assert.match(popupSource, /\/open\/auth\/token/);
    assert.match(popupSource, /BING_REWARDS_ACCOUNTS/);
});

test('browser extension page contains every element referenced by popup logic', function () {
    const popupSource = fs.readFileSync(
        path.join(root, 'browser-extension', 'popup.js'),
        'utf8'
    );
    const popupHtml = fs.readFileSync(
        path.join(root, 'browser-extension', 'popup.html'),
        'utf8'
    );
    const ids = new Set(Array.from(popupHtml.matchAll(/\bid="([^"]+)"/g), function (match) {
        return match[1];
    }));
    const list = popupSource.match(/const elements = Object\.fromEntries\(\[([\s\S]*?)\]\.map/);
    assert.ok(list, 'popup element list should be discoverable');
    const referenced = Array.from(list[1].matchAll(/'([^']+)'/g), function (match) {
        return match[1];
    });
    for (const id of referenced) assert.ok(ids.has(id), 'missing popup element #' + id);
});
