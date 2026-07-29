'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const root = path.join(__dirname, '..');

function createBackgroundHarness() {
    const session = {};
    const listeners = {};
    const tabUpdates = [];
    let nextTabId = 40;
    let currentSuffix = '1';
    const balanceForSuffix = function (suffix) {
        return Number(suffix) * 1000;
    };
    const fingerprintForSuffix = function (suffix) {
        return crypto.createHash('sha256').update([
            'u-' + suffix,
            'auth-' + suffix,
            'u-' + suffix
        ].join('\n')).digest('hex');
    };
    const cookie = function (name, value, domain, hostOnly) {
        return {
            name: name,
            value: value,
            domain: domain,
            hostOnly: Boolean(hostOnly),
            path: '/',
            secure: true,
            session: true
        };
    };
    const filterKeys = function (keys) {
        if (!Array.isArray(keys)) return Object.assign({}, session);
        return Object.fromEntries(keys
            .filter(function (key) { return Object.hasOwn(session, key); })
            .map(function (key) { return [key, session[key]]; }));
    };
    const chrome = {
        action: {
            onClicked: { addListener: function (listener) { listeners.action = listener; } }
        },
        windows: {
            get: async function () { throw new Error('missing'); },
            update: async function () {},
            create: async function () { return { id: 9 }; },
            onRemoved: { addListener: function (listener) { listeners.windowRemoved = listener; } }
        },
        tabs: {
            create: async function (options) {
                nextTabId++;
                tabUpdates.push({ id: nextTabId, options: options });
                return { id: nextTabId };
            },
            update: async function (id, options) {
                tabUpdates.push({ id: id, options: options });
                return { id: id };
            },
            remove: async function () {},
            onUpdated: { addListener: function (listener) { listeners.tabUpdated = listener; } }
        },
        storage: {
            session: {
                get: async function (keys) { return filterKeys(keys); },
                set: async function (values) { Object.assign(session, values); },
                remove: async function (keys) {
                    for (const key of keys) delete session[key];
                }
            }
        },
        cookies: {
            getAll: function (query, callback) {
                if (String(query.url).includes('rewards.bing.com')) {
                    callback([
                        cookie('_U', 'u-' + currentSuffix, '.bing.com', false),
                        cookie(
                            '.MSA.Auth',
                            'auth-' + currentSuffix,
                            'rewards.bing.com',
                            true
                        )
                    ]);
                    return;
                }
                callback([
                    cookie('_U', 'u-' + currentSuffix, '.bing.com', false)
                ]);
            }
        },
        runtime: {
            lastError: null,
            getURL: function (file) { return 'chrome-extension://test/' + file; },
            onMessage: { addListener: function (listener) { listeners.message = listener; } }
        }
    };
    const source = fs.readFileSync(
        path.join(root, 'browser-extension', 'background.js'),
        'utf8'
    );
    vm.runInNewContext(source, {
        URL: URL,
        URLSearchParams: URLSearchParams,
        chrome: chrome,
        console: console,
        crypto: crypto.webcrypto,
        TextEncoder: TextEncoder,
        fetch: async function (url, options) {
            if (String(url).startsWith(
                'https://rewards.bing.com/api/getuserinfo'
            )) {
                return {
                    ok: true,
                    status: 200,
                    json: async function () {
                        return {
                            dashboard: {
                                userStatus: {
                                    availablePoints:
                                        balanceForSuffix(currentSuffix)
                                }
                            }
                        };
                    }
                };
            }
            if (String(url).startsWith(
                'https://prod.rewardsplatform.microsoft.com/dapi/me'
            )) {
                const accessToken = String(options.headers.authorization || '')
                    .replace(/^Bearer\s+/, '');
                const code = accessToken.replace(/^access-/, '');
                const suffix = code === 'duplicate-account-2'
                    ? '2'
                    : code.replace(/^authorization-code-/, '');
                const ruidSuffix = code === 'duplicate-account-2'
                    ? '1'
                    : suffix;
                return {
                    ok: true,
                    status: 200,
                    json: async function () {
                        return {
                            response: {
                                profile: {
                                    ruid: 'rewards-user-' + ruidSuffix
                                },
                                balance: balanceForSuffix(suffix)
                            }
                        };
                    }
                };
            }
            const code = new URLSearchParams(options.body).get('code');
            return {
                ok: true,
                status: 200,
                json: async function () {
                    return {
                        access_token: 'access-' + code,
                        refresh_token: 'refresh-' + code
                    };
                }
            };
        }
    });
    const send = function (message) {
        return new Promise(function (resolve, reject) {
            const keepAlive = listeners.message(message, {}, function (response) {
                if (response && response.ok) resolve(response);
                else reject(new Error((response && response.error) || 'no response'));
            });
            assert.equal(keepAlive, true);
        });
    };
    const finishOAuth = async function (code) {
        const callback = new URL('https://login.live.com/oauth20_desktop.srf');
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', session.oauthState);
        await listeners.tabUpdated(session.oauthTabId, { url: callback.toString() });
    };
    return {
        finishOAuth: finishOAuth,
        fingerprint: fingerprintForSuffix,
        send: send,
        session: session,
        tabUpdates: tabUpdates,
        useAccount: function (suffix) {
            currentSuffix = String(suffix);
        }
    };
}

async function capture(harness, name, suffix, options) {
    const selectedSuffix = String(suffix);
    const captureOptions = options || {};
    harness.useAccount(selectedSuffix);
    return harness.send({
        type: 'accounts:capture',
        mode: captureOptions.mode || 'new',
        accountId: captureOptions.accountId || '',
        name: name,
        cookieFingerprint: harness.fingerprint(selectedSuffix),
        cookie: '_U=u-' + selectedSuffix
            + '; .MSA.Auth=auth-' + selectedSuffix,
        searchCookie: '_U=u-' + selectedSuffix
    });
}

test('OAuth flow stores a separate refreshToken for every account', async function () {
    const harness = createBackgroundHarness();
    const first = await capture(harness, '账号1', 1);
    const second = await capture(harness, '账号2', 2);

    harness.useAccount(1);
    await harness.send({
        type: 'oauth:start',
        accountId: first.account.id,
        cookieFingerprint: first.account.cookieFingerprint
    });
    assert.equal(harness.tabUpdates[0].options.url, 'about:blank');
    assert.equal(harness.session.oauthAccountId, first.account.id);
    await harness.finishOAuth('authorization-code-1');

    harness.useAccount(2);
    await harness.send({
        type: 'oauth:start',
        accountId: second.account.id,
        cookieFingerprint: second.account.cookieFingerprint
    });
    await harness.finishOAuth('authorization-code-2');

    const list = await harness.send({ type: 'accounts:list' });
    assert.equal(list.accounts.length, 2);
    assert.equal(list.accounts[0].refreshToken, 'refresh-authorization-code-1');
    assert.equal(list.accounts[1].refreshToken, 'refresh-authorization-code-2');
    assert.equal(list.accounts[0].oauthRuid, 'rewards-user-1');
    assert.equal(list.accounts[1].oauthRuid, 'rewards-user-2');

    const firstStatus = await harness.send({
        type: 'oauth:status',
        accountId: first.account.id
    });
    const secondToken = await harness.send({
        type: 'oauth:get-token',
        accountId: second.account.id
    });
    assert.equal(firstStatus.status, 'ready');
    assert.equal(
        firstStatus.cookieFingerprint,
        harness.fingerprint(1)
    );
    assert.equal(secondToken.refreshToken, 'refresh-authorization-code-2');
    assert.equal(secondToken.oauthRuid, 'rewards-user-2');
});

test('OAuth flow rejects a Microsoft account already bound to another remark', async function () {
    const harness = createBackgroundHarness();
    const first = await capture(harness, '账号1', 1);
    const second = await capture(harness, '账号2', 2);

    harness.useAccount(1);
    await harness.send({
        type: 'oauth:start',
        accountId: first.account.id,
        cookieFingerprint: first.account.cookieFingerprint
    });
    await harness.finishOAuth('authorization-code-1');

    harness.useAccount(2);
    await harness.send({
        type: 'oauth:start',
        accountId: second.account.id,
        cookieFingerprint: second.account.cookieFingerprint
    });
    await harness.finishOAuth('duplicate-account-2');

    const status = await harness.send({
        type: 'oauth:status',
        accountId: second.account.id
    });
    assert.equal(status.status, 'error');
    assert.match(status.error, /已绑定“账号1”的同一 Microsoft 账号/);

    const list = await harness.send({ type: 'accounts:list' });
    assert.equal(list.accounts[1].refreshToken, '');
    assert.equal(list.accounts[1].oauthRuid, '');
});

test('account remark is display-only while Cookie identity controls updates', async function () {
    const harness = createBackgroundHarness();
    const first = await capture(harness, '主账号', 1);
    const second = await capture(harness, '备用账号', 2);

    harness.useAccount(1);
    await harness.send({
        type: 'oauth:start',
        accountId: first.account.id,
        cookieFingerprint: first.account.cookieFingerprint
    });
    await harness.finishOAuth('authorization-code-1');

    const sameCookie = await capture(harness, '新备注', 1);
    assert.equal(sameCookie.account.id, first.account.id);
    assert.match(sameCookie.account.refreshToken, /^refresh-/);

    const renamed = await harness.send({
        type: 'accounts:rename',
        accountId: second.account.id,
        name: '新备注'
    });
    assert.equal(renamed.account.name, '新备注');

    const third = await capture(harness, '新备注', 3);
    assert.notEqual(third.account.id, first.account.id);
    assert.notEqual(third.account.id, second.account.id);

    const rebound = await capture(harness, '新备注', 4, {
        mode: 'replace',
        accountId: first.account.id
    });
    assert.equal(rebound.account.id, first.account.id);
    assert.equal(
        rebound.account.cookieFingerprint,
        harness.fingerprint(4)
    );
    assert.equal(rebound.account.refreshToken, '');
    assert.equal(rebound.account.oauthRuid, '');

    await harness.send({ type: 'accounts:remove', accountId: first.account.id });
    const list = await harness.send({ type: 'accounts:list' });
    assert.equal(list.accounts.length, 2);
    assert.ok(list.accounts.every(function (account) {
        return account.name === '新备注';
    }));
});

test('OAuth callback rejects a browser account switch during authorization', async function () {
    const harness = createBackgroundHarness();
    const first = await capture(harness, '账号1', 1);
    await capture(harness, '账号2', 2);

    harness.useAccount(1);
    await harness.send({
        type: 'oauth:start',
        accountId: first.account.id,
        cookieFingerprint: first.account.cookieFingerprint
    });
    harness.useAccount(2);
    await harness.finishOAuth('authorization-code-1');

    const status = await harness.send({
        type: 'oauth:status',
        accountId: first.account.id
    });
    assert.equal(status.status, 'error');
    assert.match(status.error, /回调时浏览器已切换/);
});

test('OAuth callback rejects a different account even when the browser cookie stayed put', async function () {
    const harness = createBackgroundHarness();
    const first = await capture(harness, '账号1', 1);

    harness.useAccount(1);
    await harness.send({
        type: 'oauth:start',
        accountId: first.account.id,
        cookieFingerprint: first.account.cookieFingerprint
    });
    await harness.finishOAuth('authorization-code-2');

    const status = await harness.send({
        type: 'oauth:status',
        accountId: first.account.id
    });
    assert.equal(status.status, 'error');
    assert.match(status.error, /余额.*不一致.*串号/);
});
