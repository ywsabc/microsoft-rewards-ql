'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('main script stays unscheduled and exposes the shared runtime', function () {
    const source = fs.readFileSync(
        path.join(root, 'microsoft_rewards_ql.js'),
        'utf8'
    );
    assert.doesNotMatch(source, /^\s*\*\s+cron:/m);
    assert.match(source, /main:\s*main/);
    assert.match(source, /path\.join\(__dirname, 'sendNotify\.js'\)/);
    assert.match(source, /path\.join\(__dirname, '\.\.', 'sendNotify\.js'\)/);
});

test('split QingLong entry files expose independent schedules and modules', function () {
    const expected = {
        sign: { name: '微软积分-01签到', cron: '7 9 * * *', tasks: 'sign' },
        read: { name: '微软积分-02阅读', cron: '23 9 * * *', tasks: 'read' },
        promos: { name: '微软积分-03活动', cron: '11 10 * * *', tasks: 'promos,quiz' },
        search: {
            name: '微软积分-04电脑搜索',
            cron: '47 10,12,14,16,18 * * *',
            tasks: 'search'
        },
        mobile: { name: '微软积分-05移动搜索', cron: '29 11 * * *', tasks: 'mobile' },
        streak: { name: '微软积分-06连签', cron: '43 11 * * *', tasks: 'streak' },
        claim: { name: '微软积分-07领取', cron: '7 12 * * *', tasks: 'claim' }
    };
    for (const [moduleName, metadata] of Object.entries(expected)) {
        const source = fs.readFileSync(
            path.join(root, 'microsoft_rewards_task_' + moduleName + '.js'),
            'utf8'
        );
        assert.match(source, new RegExp(
            '^\\s*\\*\\s+name:\\s+' + metadata.name + '\\s*$',
            'm'
        ));
        assert.match(source, new RegExp(
            '^\\s*\\*\\s+cron:\\s+'
                + metadata.cron.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                + '\\s*$',
            'm'
        ));
        assert.match(
            source,
            new RegExp(
                "process\\.env\\.BING_REWARDS_TASKS = '"
                    + metadata.tasks + "'"
            )
        );
        assert.match(source, /require\('\.\/microsoft_rewards_ql'\)\.main\(\)/);
    }
});

test('QingLong guide documents safe GitHub timeout fallbacks', function () {
    const guide = fs.readFileSync(
        path.join(root, 'docs', 'QINGLONG.md'),
        'utf8'
    );
    assert.match(
        guide,
        /github\.com\/ywsabc\/microsoft-rewards-ql\/raw\/refs\/heads\/main\/microsoft_rewards_ql\.js/
    );
    assert.match(guide, /MSR_GITHUB_PROXY/);
    assert.match(guide, /标准 HTTP\/HTTPS 代理地址/);
    assert.match(guide, /容器里的这个地址\s*指向容器自身/);
    assert.match(guide, /qinglong-mixed/);
    assert.match(guide, /分支可缓存 12 小时/);
    assert.match(
        guide,
        /公开镜像能够修改下载到的可执行\s*脚本/
    );
    assert.doesNotMatch(
        guide,
        /共享核心单文件地址：[\s\S]{0,100}raw\.githubusercontent\.com/
    );
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
    assert.equal(manifest.version, '3.0.2');
    assert.equal(manifest.minimum_chrome_version, '102');
    assert.deepEqual(manifest.permissions.sort(), ['clipboardWrite', 'cookies', 'storage']);
    assert.deepEqual(
        manifest.host_permissions.sort(),
        [
            'https://*.bing.com/*',
            'https://bing.com/*',
            'https://login.live.com/*',
            'https://prod.rewardsplatform.microsoft.com/*'
        ]
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
        /\bnew\s+XMLHttpRequest\b/,
        /\bWebSocket\b/,
        /\bsendBeacon\b/,
        /\bchrome\.storage\.sync\b/,
        /\bbrowser\.storage\b/
    ];
    for (const pattern of forbidden) {
        assert.doesNotMatch(popupSource + '\n' + backgroundSource, pattern);
    }
    for (const requiredCookie of ['_U', '.MSA.Auth', '_C_Auth']) {
        assert.match(popupSource, new RegExp(requiredCookie.replace('.', '\\.')));
    }
    assert.match(
        popupSource,
        /const REQUIRED_SHARED_COOKIES = \['_U'\]/
    );
    assert.match(
        popupSource,
        /const REWARDS_AUTH_COOKIES = \['\.MSA\.Auth', '_C_Auth'\]/
    );
    assert.match(backgroundSource, /const CLIENT_ID = '0000000040170455'/);
    assert.match(backgroundSource, /chrome\.storage\.session/);
    assert.doesNotMatch(backgroundSource, /chrome\.storage\.local/);
    assert.match(backgroundSource, /chrome\.action\.onClicked/);
    assert.match(backgroundSource, /chrome\.windows\.create/);
    assert.match(backgroundSource, /type:\s*'popup'/);
    assert.match(backgroundSource, /width:\s*500/);
    assert.match(backgroundSource, /height:\s*800/);
    assert.match(backgroundSource, /prompt:\s*'select_account'/);
    assert.match(backgroundSource, /oauthCookieFingerprint/);
    assert.match(backgroundSource, /const ACCOUNT_STORAGE_KEY = 'rewardAccounts'/);
    assert.match(backgroundSource, /const MAX_ACCOUNTS = 20/);
    assert.match(backgroundSource, /oauthAccountId/);
    assert.match(backgroundSource, /inspectOAuthToken/);
    assert.match(backgroundSource, /oauthRuid/);
    assert.match(backgroundSource, /accounts:capture/);
    assert.match(backgroundSource, /accounts:rename/);
    assert.match(backgroundSource, /accounts:remove/);
    assert.match(backgroundSource, /chrome\.tabs\.create\(\{ url: 'about:blank'/);
    assert.match(backgroundSource, /chrome\.tabs\.update\(tab\.id/);
    assert.match(popupSource, /chrome\.storage\.local/);
    assert.match(popupSource, /searchCookie:\s*cachedBingCookieHeader/);
    assert.match(popupSource, /fingerprintCookies/);
    assert.match(popupSource, /https:\/\/www\.bing\.com\//);
    assert.match(popupSource, /'bing_search_ck_' \+ suffix/);
    assert.match(
        popupSource,
        /const SAVED_SETTING_IDS = \[\s*'ql-url',\s*'ql-client-id',\s*'ql-client-secret'\s*\]/
    );
    assert.match(popupSource, /bing_token_' \+ suffix/);
    assert.match(popupSource, /由浏览器扩展同步｜/);
    assert.match(popupSource, /deleteStaleIndexedEnvs/);
    assert.match(popupSource, /getQingLongAccounts/);
    assert.match(popupSource, /mergeAccountByRemark/);
    assert.match(popupSource, /syncToQingLong\('selected'\)/);
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
