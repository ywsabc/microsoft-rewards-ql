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
                tabUpdates.push({ id: 41, options: options });
                return { id: 41 };
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
        runtime: {
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
        fetch: async function () {
            return {
                ok: true,
                status: 200,
                json: async function () {
                    return { access_token: 'access-test', refresh_token: 'refresh-test' };
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
    return {
        listeners: listeners,
        send: send,
        session: session,
        tabUpdates: tabUpdates
    };
}

test('OAuth callback retains and reports the selected Cookie fingerprint', async function () {
    const harness = createBackgroundHarness();
    await harness.send({ type: 'oauth:start', cookieFingerprint: 'account-fingerprint' });

    assert.equal(harness.tabUpdates[0].options.url, 'about:blank');
    assert.equal(harness.session.oauthStatus, 'pending');
    assert.equal(harness.session.oauthTabId, 41);
    assert.equal(harness.session.oauthCookieFingerprint, 'account-fingerprint');
    assert.match(harness.tabUpdates[1].options.url, /oauth20_authorize\.srf/);

    const callback = new URL('https://login.live.com/oauth20_desktop.srf');
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', harness.session.oauthState);
    await harness.listeners.tabUpdated(41, { url: callback.toString() });

    const status = await harness.send({ type: 'oauth:status' });
    const token = await harness.send({ type: 'oauth:get-token' });
    assert.equal(status.status, 'ready');
    assert.equal(status.hasRefreshToken, true);
    assert.equal(status.cookieFingerprint, 'account-fingerprint');
    assert.equal(token.refreshToken, 'refresh-test');
    assert.equal(token.cookieFingerprint, 'account-fingerprint');
});
