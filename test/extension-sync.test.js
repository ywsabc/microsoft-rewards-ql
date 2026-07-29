'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');
const runtime = require('../microsoft_rewards_ql');

const extensionDir = path.join(__dirname, '..', 'browser-extension');

function rewardAccount(id, name, user, ruid) {
    const account = {
        id: id,
        name: name,
        cookie: '_U=' + user + '; .MSA.Auth=auth-' + user
            + '; MUID=rewards-' + user,
        searchCookie: '_U=' + user + '; MUID=search-' + user,
        refreshToken: 'refresh-' + user,
        oauthRuid: ruid
    };
    account.cookieFingerprint = runtime.accountCookieIdentity(
        account.cookie,
        account.searchCookie
    ).fingerprint;
    return account;
}

class FakeElement {
    constructor() {
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.className = '';
        this.textContent = '';
        this.listeners = {};
        this.children = [];
    }

    addEventListener(type, listener) {
        this.listeners[type] = listener;
    }

    appendChild(child) {
        this.children.push(child);
    }
}

function storageArea(state) {
    return {
        async get(keys) {
            const result = {};
            for (const key of keys || []) {
                if (Object.prototype.hasOwnProperty.call(state, key)) {
                    result[key] = state[key];
                }
            }
            return result;
        },
        async set(values) {
            Object.assign(state, values);
        },
        async remove(keys) {
            for (const key of keys) delete state[key];
        }
    };
}

function createPopupHarness(initialAccounts, initialEnvs) {
    const accountState = { value: initialAccounts };
    const envs = initialEnvs.map(function (env, index) {
        return Object.assign({ id: 'env-' + (index + 1), status: 0 }, env);
    });
    let nextEnvId = envs.length + 1;
    const elements = new Map();
    const localStorage = {};
    const sessionStorage = {};

    function element(id) {
        if (!elements.has(id)) elements.set(id, new FakeElement());
        return elements.get(id);
    }

    async function fakeFetch(rawUrl, options) {
        const url = new URL(rawUrl);
        const method = String(options && options.method || 'GET').toUpperCase();
        let data;
        if (url.pathname === '/open/auth/token') {
            data = { token: 'test-openapi-token' };
        } else if (url.pathname === '/open/envs' && method === 'GET') {
            const search = url.searchParams.get('searchValue') || '';
            data = envs.filter(function (env) {
                return env.name.includes(search);
            }).map(function (env) {
                return Object.assign({}, env);
            });
        } else if (url.pathname === '/open/envs' && method === 'POST') {
            const additions = JSON.parse(options.body);
            additions.forEach(function (env) {
                envs.push(Object.assign({
                    id: 'env-' + nextEnvId++,
                    status: 0
                }, env));
            });
            data = additions;
        } else if (url.pathname === '/open/envs' && method === 'PUT') {
            const update = JSON.parse(options.body);
            const current = envs.find(function (env) {
                return env.id === update.id || env._id === update.id;
            });
            if (!current) throw new Error('missing fake env ' + update.id);
            Object.assign(current, update);
            data = current;
        } else if (url.pathname === '/open/envs' && method === 'DELETE') {
            const ids = new Set(JSON.parse(options.body));
            for (let index = envs.length - 1; index >= 0; index--) {
                if (ids.has(envs[index].id || envs[index]._id)) {
                    envs.splice(index, 1);
                }
            }
            data = true;
        } else {
            throw new Error('unexpected fetch ' + method + ' ' + rawUrl);
        }
        return {
            ok: true,
            status: 200,
            async json() {
                return { code: 200, data: data };
            }
        };
    }

    const context = vm.createContext({
        URL: URL,
        URLSearchParams: URLSearchParams,
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        Uint8Array: Uint8Array,
        atob: atob,
        btoa: btoa,
        crypto: crypto.webcrypto,
        fetch: fakeFetch,
        navigator: { clipboard: { async writeText() {} } },
        confirm: function () { return true; },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
        console: console,
        document: {
            getElementById: element,
            createElement: function () { return new FakeElement(); }
        },
        chrome: {
            runtime: {
                lastError: null,
                sendMessage(message, callback) {
                    if (message.type === 'accounts:list') {
                        callback({
                            ok: true,
                            accounts: accountState.value.map(function (item) {
                                return Object.assign({}, item);
                            })
                        });
                    } else if (message.type === 'oauth:status') {
                        callback({ ok: true, status: 'idle' });
                    } else {
                        callback({ ok: false, error: 'unexpected message' });
                    }
                }
            },
            cookies: {
                getAll(query, callback) {
                    callback([]);
                }
            },
            permissions: {
                request(options, callback) {
                    callback(true);
                },
                remove(options, callback) {
                    callback(true);
                }
            },
            storage: {
                local: storageArea(localStorage),
                session: storageArea(sessionStorage)
            }
        }
    });
    vm.runInContext(
        fs.readFileSync(path.join(extensionDir, 'bing-ck.js'), 'utf8'),
        context,
        { filename: 'bing-ck.js' }
    );
    vm.runInContext(
        fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8'),
        context,
        { filename: 'popup.js' }
    );

    return {
        accounts: accountState,
        envs: envs,
        element: element,
        codec: context.BingCkCodec
    };
}

async function waitFor(predicate, description) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }
    throw new Error('timed out waiting for ' + description);
}

async function triggerSync(harness, elementId) {
    await waitFor(function () {
        return Boolean(harness.element(elementId).listeners.click);
    }, elementId + ' listener');
    harness.element('ql-url').value = 'http://127.0.0.1:5700';
    harness.element('ql-client-id').value = 'client-id';
    harness.element('ql-client-secret').value = 'client-secret';
    harness.element(elementId).listeners.click();
    await waitFor(function () {
        return /同步成功/.test(harness.element('copy-status').textContent);
    }, elementId + ' completion');
}

test('extension migrates legacy arrays into one same-name bing_ck row per account', async function () {
    const first = rewardAccount('account-a', '同名', 'user-a', 'ruid-a');
    const second = rewardAccount('account-b', '同名', 'user-b', 'ruid-b');
    const harness = createPopupHarness(
        [first, second],
        [
            {
                name: 'BING_REWARDS_ACCOUNTS',
                value: JSON.stringify([first]),
                remarks: '由浏览器扩展同步'
            },
            {
                name: 'bing_ck_1',
                value: first.cookie,
                remarks: '由浏览器扩展同步｜旧账号'
            },
            {
                name: 'bing_token_1',
                value: first.refreshToken,
                remarks: '由浏览器扩展同步｜旧账号'
            }
        ]
    );

    await triggerSync(harness, 'sync-ql');

    const rows = harness.envs.filter(function (env) {
        return env.name === 'bing_ck';
    });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(function (row) {
        return harness.codec.decodeAccounts(row.value).length === 1;
    }));
    assert.equal(
        harness.envs.some(function (env) {
            return env.name === 'BING_REWARDS_ACCOUNTS'
                || /^bing_(?:ck|search_ck|token)_\d+$/.test(env.name);
        }),
        false
    );

    const qingLongJoinedValue = rows.map(function (row) {
        return row.value;
    }).join('&');
    const runtimeAccounts = runtime.decodeBingCkAccounts(qingLongJoinedValue);
    assert.equal(runtimeAccounts.length, 2);
    assert.deepEqual(new Set(runtimeAccounts.map(function (account) {
        return account.oauthRuid;
    })), new Set(['ruid-a', 'ruid-b']));
});

test('selected sync updates a rotated Cookie by OAuth identity without changing row count', async function () {
    const first = rewardAccount('account-a', '任意备注', 'user-a', 'ruid-a');
    const second = rewardAccount('account-b', '任意备注', 'user-b', 'ruid-b');
    const initialHarness = createPopupHarness([first, second], []);
    await triggerSync(initialHarness, 'sync-ql');

    const rotated = rewardAccount(
        'account-a',
        '备注已修改',
        'user-a-rotated',
        'ruid-a'
    );
    initialHarness.accounts.value = [rotated, second];
    initialHarness.element('copy-status').textContent = '';
    await triggerSync(initialHarness, 'sync-selected-ql');

    const rows = initialHarness.envs.filter(function (env) {
        return env.name === 'bing_ck';
    });
    assert.equal(rows.length, 2);
    const decoded = rows.map(function (row) {
        return initialHarness.codec.decodeAccounts(row.value)[0];
    });
    const updated = decoded.find(function (account) {
        return account.oauthRuid === 'ruid-a';
    });
    assert.equal(updated.name, '备注已修改');
    assert.equal(updated.cookieFingerprint, rotated.cookieFingerprint);
});
