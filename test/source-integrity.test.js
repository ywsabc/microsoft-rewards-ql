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

test('QingLong guide offers direct and timeout full-repository pulls', function () {
    const guide = fs.readFileSync(
        path.join(root, 'docs', 'QINGLONG.md'),
        'utf8'
    );
    assert.match(
        guide,
        /ql repo "https:\/\/github\.com\/ywsabc\/microsoft-rewards-ql\.git"/
    );
    assert.match(
        guide,
        /ql repo "https:\/\/ghfast\.top\/https:\/\/github\.com\/ywsabc\/microsoft-rewards-ql\.git"/
    );
    assert.equal((guide.match(/ql repo /g) || []).length, 2);
    assert.equal(
        (
            guide.match(
                /\^microsoft_rewards_\(ql\|task_\[a-z_\]\+\)\[\.\]js\$/g
            ) || []
        ).length,
        2
    );
    assert.match(guide, /共享核心和全部 7 个任务入口/);
    assert.match(guide, /不会[\s\S]{0,20}改变任务运行时的出口 IP/);
    assert.match(guide, /不会拉取或安装浏览器插件/);
    assert.match(guide, /github\.com\/ywsabc\/microsoft-rewards-ql\/releases\/latest/);
    assert.doesNotMatch(guide, /jsdelivr|raw_microsoft|MSR_GITHUB_PROXY/);
    assert.match(guide, /每个账号在青龙中对应一条同名环境变量/);
    assert.match(guide, /bing_ck/);
    assert.match(guide, /不依赖备注或排列顺序/);
});

test('jsDelivr workflow purges and verifies every published script', function () {
    const workflow = fs.readFileSync(
        path.join(root, '.github', 'workflows', 'purge-jsdelivr.yml'),
        'utf8'
    );
    assert.match(workflow, /push:\s*\n\s+branches: \[main\]/);
    assert.match(workflow, /purge\.jsdelivr\.net\/gh\/ywsabc\/microsoft-rewards-ql@main/);
    assert.match(workflow, /cdn\.jsdelivr\.net\/gh\/ywsabc\/microsoft-rewards-ql@main/);
    assert.match(workflow, /microsoft_rewards_task_\*\.js/);
    assert.match(workflow, /cmp --silent/);
    assert.match(workflow, /exit 1/);
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
    assert.equal(manifest.version, '3.1.2');
    assert.equal(manifest.minimum_chrome_version, '102');
    assert.deepEqual(
        manifest.permissions.sort(),
        ['clipboardWrite', 'cookies', 'scripting', 'storage']
    );
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
    assert.match(backgroundSource, /inspectRewardsBalanceInPage/);
    assert.match(backgroundSource, /chrome\.scripting\.executeScript/);
    assert.match(backgroundSource, /world:\s*'MAIN'/);
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
    const codecSource = fs.readFileSync(
        path.join(root, 'browser-extension', 'bing-ck.js'),
        'utf8'
    );
    assert.match(codecSource, /const ACCOUNT_MARKER = '__bing_account'/);
    assert.match(codecSource, /fields\.join\('&'\)/);
    assert.match(codecSource, /mergeAccountByIdentity/);
    assert.match(popupSource, /getExactEnvs\(origin, apiToken, 'bing_ck'\)/);
    assert.match(
        popupSource,
        /const SAVED_SETTING_IDS = \[\s*'ql-url',\s*'ql-client-id',\s*'ql-client-secret'\s*\]/
    );
    assert.match(popupSource, /由浏览器扩展同步｜/);
    assert.match(popupSource, /deleteLegacyExtensionEnvs/);
    assert.match(popupSource, /getQingLongAccountState/);
    assert.match(popupSource, /mergeAccountByIdentity/);
    assert.match(popupSource, /syncToQingLong\('selected'\)/);
    assert.match(backgroundSource, /https:\/\/login\.live\.com\/oauth20_authorize\.srf/);
    assert.match(backgroundSource, /https:\/\/login\.live\.com\/oauth20_token\.srf/);
    assert.match(popupSource, /chrome\.permissions\.request/);
    assert.match(popupSource, /chrome\.permissions\.remove/);
    assert.match(popupSource, /\/open\/auth\/token/);
    assert.match(popupSource, /BING_REWARDS_ACCOUNTS/);
    assert.doesNotMatch(popupSource, /'bing_ck_' \+ suffix/);
    assert.doesNotMatch(popupSource, /'bing_search_ck_' \+ suffix/);
    assert.doesNotMatch(popupSource, /'bing_token_' \+ suffix/);
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
    assert.ok(
        popupHtml.indexOf('src="bing-ck.js"')
            < popupHtml.indexOf('src="popup.js"'),
        'bing_ck codec must load before popup logic'
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
