/*
 * Microsoft Rewards QingLong Sync
 * SPDX-License-Identifier: MIT
 */

'use strict';

// tifacfaatcs was used by an older Rewards implementation, but current
// sessions do not consistently issue it.
const REQUIRED_SHARED_COOKIES = ['_U'];
const REWARDS_AUTH_COOKIES = ['.MSA.Auth', '_C_Auth'];
const SAVED_SETTINGS_KEY = 'qingLongSettings';
const SAVED_SETTING_IDS = [
    'ql-url',
    'ql-client-id',
    'ql-client-secret'
];
const elements = Object.fromEntries([
    'status', 'rewards-status', 'bing-status', 'refresh-session',
    'account-select', 'account-name', 'add-account', 'replace-account',
    'rename-account', 'remove-account', 'account-status',
    'copy-status', 'copy-cookie', 'copy-json',
    'start-oauth', 'clear-oauth', 'oauth-status',
    'ql-url', 'ql-client-id', 'ql-client-secret', 'remember-settings',
    'clear-settings', 'sync-selected-ql', 'sync-ql'
].map(function (id) {
    return [id, document.getElementById(id)];
}));

let cachedRewardsCookieHeader = '';
let cachedBingCookieHeader = '';
let currentCookieFingerprint = '';
let cookieReady = false;
let accounts = [];
let selectedAccountId = '';
let oauthPoll = null;
let saveTimer = null;

if (!globalThis.BingCkCodec) {
    throw new Error('bing_ck 编解码模块未加载');
}

function setMessage(element, text, ok) {
    element.className = 'message ' + (ok ? 'ok' : 'error');
    element.textContent = text;
}

function setNeutralMessage(element, text) {
    element.className = 'message';
    element.textContent = text;
}

function getCookies(query) {
    return new Promise(function (resolve, reject) {
        chrome.cookies.getAll(query, function (cookies) {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(cookies);
        });
    });
}

function sendMessage(message) {
    return new Promise(function (resolve, reject) {
        chrome.runtime.sendMessage(message, function (response) {
            const error = chrome.runtime.lastError;
            if (error) return reject(new Error(error.message));
            if (!response || !response.ok) {
                return reject(new Error((response && response.error) || '扩展后台无响应'));
            }
            resolve(response);
        });
    });
}

async function restoreSettings() {
    const data = await chrome.storage.local.get([SAVED_SETTINGS_KEY]);
    const saved = data[SAVED_SETTINGS_KEY];
    if (!saved || typeof saved !== 'object') return;
    for (const id of SAVED_SETTING_IDS) {
        if (typeof saved[id] === 'string') elements[id].value = saved[id];
    }
    elements['remember-settings'].checked = true;
}

async function saveSettings() {
    if (!elements['remember-settings'].checked) {
        await chrome.storage.local.remove([SAVED_SETTINGS_KEY]);
        return;
    }
    const saved = {};
    for (const id of SAVED_SETTING_IDS) saved[id] = elements[id].value;
    await chrome.storage.local.set({ [SAVED_SETTINGS_KEY]: saved });
}

function scheduleSettingsSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
        saveSettings().catch(function (error) {
            setMessage(elements['copy-status'], '保存信息失败：' + error.message, false);
        });
    }, 250);
}

async function restoreSyncStatus() {
    const data = await chrome.storage.session.get(['lastSyncStatus']);
    if (!data.lastSyncStatus) return;
    setMessage(
        elements['copy-status'],
        data.lastSyncStatus.text,
        Boolean(data.lastSyncStatus.ok)
    );
}

async function recordSyncStatus(text, ok) {
    setMessage(elements['copy-status'], text, ok);
    await chrome.storage.session.set({
        lastSyncStatus: { text: text, ok: Boolean(ok), time: Date.now() }
    });
}

function buildCookieHeader(cookies, hostname) {
    const now = Date.now() / 1000;
    const current = cookies.filter(function (cookie) {
        return cookie.session || !cookie.expirationDate || cookie.expirationDate > now;
    });
    current.sort(function (left, right) {
        if (left.path.length !== right.path.length) return right.path.length - left.path.length;
        const leftDomain = left.domain.replace(/^\./, '');
        const rightDomain = right.domain.replace(/^\./, '');
        const leftExact = left.hostOnly && leftDomain === hostname ? 1 : 0;
        const rightExact = right.hostOnly && rightDomain === hostname ? 1 : 0;
        if (leftExact !== rightExact) return rightExact - leftExact;
        if (leftDomain.length !== rightDomain.length) {
            return rightDomain.length - leftDomain.length;
        }
        return left.name.localeCompare(right.name);
    });
    const values = new Map();
    for (const cookie of current) {
        if (!values.has(cookie.name)) values.set(cookie.name, cookie.value);
    }
    return Array.from(values.entries()).map(function (entry) {
        return entry[0] + '=' + entry[1];
    }).join('; ');
}

function cookieValue(header, name) {
    const prefix = name + '=';
    const part = String(header || '').split(/;\s*/).find(function (item) {
        return item.startsWith(prefix);
    });
    return part ? part.slice(prefix.length) : '';
}

async function fingerprintCookies(rewardsCookie, bingCookie) {
    const stableIdentity = [
        cookieValue(rewardsCookie, '_U'),
        cookieValue(rewardsCookie, '.MSA.Auth')
            || cookieValue(rewardsCookie, '_C_Auth'),
        cookieValue(bingCookie, '_U')
    ].join('\n');
    const bytes = new TextEncoder().encode(stableIdentity);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), function (value) {
        return value.toString(16).padStart(2, '0');
    }).join('');
}

async function copyText(text, successMessage) {
    await navigator.clipboard.writeText(text);
    setMessage(elements['copy-status'], successMessage, true);
}

function selectedAccount() {
    return accounts.find(function (account) {
        return account.id === selectedAccountId;
    }) || null;
}

function accountLabel(account) {
    return account.name + ' · ' + account.cookieFingerprint.slice(0, 6) + (
        account.refreshToken ? ' · Token 已获取' : ' · 待授权'
    );
}

function updateControls() {
    const selected = selectedAccount();
    const browserMatches = Boolean(
        selected
        && cookieReady
        && selected.cookieFingerprint === currentCookieFingerprint
    );
    elements['add-account'].disabled = !cookieReady;
    elements['replace-account'].disabled = !cookieReady || !selected;
    elements['rename-account'].disabled = !selected;
    elements['remove-account'].disabled = !selected;
    elements['copy-cookie'].disabled = !selected;
    elements['copy-json'].disabled = accounts.length === 0;
    elements['start-oauth'].disabled = !browserMatches;
    elements['clear-oauth'].disabled = !selected || !selected.refreshToken;
    elements['sync-selected-ql'].disabled = !selected || !selected.refreshToken;
    elements['sync-ql'].disabled = accounts.length === 0;
}

function renderAccounts() {
    const previous = selectedAccountId;
    elements['account-select'].textContent = '';
    accounts.forEach(function (account) {
        const option = document.createElement('option');
        option.value = account.id;
        option.textContent = accountLabel(account);
        elements['account-select'].appendChild(option);
    });
    if (accounts.some(function (item) { return item.id === previous; })) {
        selectedAccountId = previous;
    } else {
        const browserAccount = accounts.find(function (item) {
            return item.cookieFingerprint === currentCookieFingerprint;
        });
        selectedAccountId = browserAccount
            ? browserAccount.id
            : (accounts[0] ? accounts[0].id : '');
    }
    elements['account-select'].value = selectedAccountId;
    const selected = selectedAccount();
    if (selected) {
        elements['account-name'].value = selected.name;
        const matches = cookieReady
            && selected.cookieFingerprint === currentCookieFingerprint;
        setMessage(
            elements['account-status'],
            '已保存 ' + accounts.length + ' 个账号；所选账号'
                + (matches ? '与当前浏览器一致。' : '不是当前浏览器账号。'),
            matches
        );
    } else {
        setNeutralMessage(elements['account-status'], '尚未保存账号。');
    }
    updateControls();
}

async function loadAccounts(preferredId) {
    const response = await sendMessage({ type: 'accounts:list' });
    accounts = Array.isArray(response.accounts) ? response.accounts : [];
    if (preferredId) selectedAccountId = preferredId;
    renderAccounts();
}

async function loadCookies() {
    cookieReady = false;
    currentCookieFingerprint = '';
    cachedRewardsCookieHeader = '';
    cachedBingCookieHeader = '';
    updateControls();
    try {
        const results = await Promise.all([
            getCookies({ url: 'https://rewards.bing.com/' }),
            getCookies({ url: 'https://www.bing.com/' })
        ]);
        const rewardsCookies = results[0];
        const bingCookies = results[1];
        cachedRewardsCookieHeader = buildCookieHeader(
            rewardsCookies,
            'rewards.bing.com'
        );
        cachedBingCookieHeader = buildCookieHeader(bingCookies, 'www.bing.com');
        const names = new Set(rewardsCookies.map(function (cookie) {
            return cookie.name;
        }));
        const missing = REQUIRED_SHARED_COOKIES.filter(function (name) {
            return !names.has(name);
        });
        const rewardsAuthCookie = REWARDS_AUTH_COOKIES.find(function (name) {
            return names.has(name);
        });
        const rewardsU = cookieValue(cachedRewardsCookieHeader, '_U');
        const bingU = cookieValue(cachedBingCookieHeader, '_U');
        const rewardsReady = Boolean(
            cachedRewardsCookieHeader
            && !missing.length
            && rewardsAuthCookie
        );
        elements['rewards-status'].className = 'session-line ' + (
            rewardsReady ? 'ok' : 'error'
        );
        elements['rewards-status'].textContent = rewardsReady
            ? 'Rewards：已登录（' + rewardsAuthCookie + '），共 '
                + rewardsCookies.length + ' 项 Cookie'
            : 'Rewards：缺少 ' + (
                missing.length
                    ? missing.join('、')
                    : '.MSA.Auth 或 _C_Auth'
            );
        elements['bing-status'].className = 'session-line ' + (bingU ? 'ok' : 'error');
        elements['bing-status'].textContent = bingU
            ? 'Bing：已登录，共 ' + bingCookies.length + ' 项 Cookie'
            : 'Bing：缺少 _U，请先登录 www.bing.com';
        if (!rewardsReady || !bingU) {
            setMessage(elements.status, '两个站点尚未全部登录，暂不能保存当前账号。', false);
            renderAccounts();
            return;
        }
        if (rewardsU !== bingU) {
            setMessage(
                elements.status,
                'Bing 与 Rewards 的 _U 会话不一致，请切换为同一账号后刷新。',
                false
            );
            elements['bing-status'].className = 'session-line error';
            renderAccounts();
            return;
        }
        currentCookieFingerprint = await fingerprintCookies(
            cachedRewardsCookieHeader,
            cachedBingCookieHeader
        );
        cookieReady = true;
        const browserAccount = accounts.find(function (item) {
            return item.cookieFingerprint === currentCookieFingerprint;
        });
        if (browserAccount) selectedAccountId = browserAccount.id;
        setMessage(elements.status, '两个站点会话一致，可以添加账号或授权。', true);
        renderAccounts();
    } catch (error) {
        setMessage(elements.status, '读取失败：' + error.message, false);
        renderAccounts();
    }
}

async function captureCurrentAccount(mode) {
    if (!cookieReady || !currentCookieFingerprint) {
        throw new Error('请先让 Bing 与 Rewards 登录同一账号');
    }
    if (mode === 'replace' && !selectedAccount()) {
        throw new Error('请先选择要更新的账号');
    }
    const response = await sendMessage({
        type: 'accounts:capture',
        mode: mode,
        accountId: mode === 'replace' ? selectedAccountId : '',
        name: elements['account-name'].value.trim()
            || ('Bing-' + currentCookieFingerprint.slice(0, 8)),
        cookie: cachedRewardsCookieHeader,
        searchCookie: cachedBingCookieHeader,
        cookieFingerprint: currentCookieFingerprint
    });
    selectedAccountId = response.account.id;
    await loadAccounts(selectedAccountId);
    setMessage(
        elements['account-status'],
        mode === 'replace'
            ? '所选账号会话已更新；会话变化时需要重新授权。'
            : '当前浏览器账号已加入列表。',
        true
    );
    await updateOAuthStatus();
}

function exportAccounts(requireTokens) {
    if (!accounts.length) throw new Error('账号列表为空');
    const missing = accounts.filter(function (account) {
        return !account.refreshToken;
    });
    if (requireTokens && missing.length) {
        throw new Error(
            '以下账号尚未获取 Token：'
            + missing.map(function (item) { return item.name; }).join('、')
        );
    }
    return accounts.map(function (account) {
        return {
            name: account.name,
            cookie: account.cookie,
            searchCookie: account.searchCookie,
            cookieFingerprint: account.cookieFingerprint,
            refreshToken: account.refreshToken || '',
            oauthRuid: account.oauthRuid || ''
        };
    });
}

async function updateOAuthStatus() {
    const selected = selectedAccount();
    if (!selected) {
        setNeutralMessage(elements['oauth-status'], '请先添加并选择账号。');
        updateControls();
        return;
    }
    try {
        const result = await sendMessage({
            type: 'oauth:status',
            accountId: selected.id
        });
        if (result.status === 'ready') {
            await loadAccounts(selected.id);
            const matches = cookieReady
                && selectedAccount().cookieFingerprint === currentCookieFingerprint;
            setMessage(
                elements['oauth-status'],
                'refreshToken 已获取并绑定“' + selectedAccount().name + '”'
                    + (matches ? '。' : '；当前浏览器已切换到其他账号。'),
                true
            );
            if (oauthPoll) clearInterval(oauthPoll);
            oauthPoll = null;
        } else if (result.status === 'pending') {
            setNeutralMessage(
                elements['oauth-status'],
                '正在等待“' + selected.name + '”完成 Microsoft 授权…'
            );
        } else if (result.status === 'error') {
            setMessage(elements['oauth-status'], 'OAuth 失败：' + result.error, false);
            if (oauthPoll) clearInterval(oauthPoll);
            oauthPoll = null;
        } else {
            setNeutralMessage(
                elements['oauth-status'],
                '“' + selected.name + '”尚未获取 Token。'
            );
        }
    } catch (error) {
        setMessage(elements['oauth-status'], error.message, false);
    }
    updateControls();
}

function normalizePanelUrl(value) {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('青龙地址必须是 HTTP 或 HTTPS');
    }
    return url.origin;
}

function requestOriginPermission(origin) {
    return new Promise(function (resolve, reject) {
        chrome.permissions.request({ origins: [origin + '/*'] }, function (granted) {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else if (!granted) reject(new Error('未授予青龙地址访问权限'));
            else resolve();
        });
    });
}

function removeOriginPermission(origin) {
    return new Promise(function (resolve) {
        chrome.permissions.remove({ origins: [origin + '/*'] }, function () {
            resolve();
        });
    });
}

async function qlRequest(origin, path, token, options) {
    const headers = Object.assign({}, (options && options.headers) || {});
    if (token) headers.authorization = 'Bearer ' + token;
    const response = await fetch(
        origin + path,
        Object.assign({}, options || {}, { headers: headers })
    );
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.code !== 200) {
        throw new Error(data.message || ('青龙 HTTP ' + response.status));
    }
    return data.data;
}

async function getExactEnvs(origin, apiToken, name) {
    const matches = await qlRequest(
        origin,
        '/open/envs?searchValue=' + encodeURIComponent(name),
        apiToken
    );
    return (Array.isArray(matches) ? matches : []).filter(function (item) {
        return item.name === name;
    });
}

async function createEnvs(origin, apiToken, envs) {
    if (!envs.length) return;
    await qlRequest(origin, '/open/envs', apiToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envs)
    });
}

async function updateEnv(origin, apiToken, env, name, value, remarks) {
    const id = env && (env.id || env._id);
    if (!id) throw new Error('青龙环境变量缺少 ID');
    await qlRequest(origin, '/open/envs', apiToken, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            id: id,
            name: name,
            value: value,
            remarks: remarks
        })
    });
}

async function deleteEnvIds(origin, apiToken, ids) {
    const validIds = ids.filter(Boolean);
    if (!validIds.length) return 0;
    await qlRequest(origin, '/open/envs', apiToken, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validIds)
    });
    return validIds.length;
}

function normalizeLegacyAccount(item) {
    if (!item || typeof item !== 'object' || !item.cookie) return null;
    return {
        name: String(item.name || ''),
        cookie: String(item.cookie),
        searchCookie: String(item.searchCookie || item.cookie),
        cookieFingerprint: String(
            item.cookieFingerprint || item.cookie_fingerprint || ''
        ),
        refreshToken: String(item.refreshToken || item.refresh_token || ''),
        oauthRuid: String(item.oauthRuid || item.oauth_ruid || '')
    };
}

async function completeAccountIdentity(account) {
    const computed = await fingerprintCookies(
        account.cookie,
        account.searchCookie || account.cookie
    );
    if (
        account.cookieFingerprint
        && account.cookieFingerprint !== computed
    ) {
        throw new Error(
            '青龙账号“' + (account.name || computed.slice(0, 8))
                + '”的 Cookie 指纹校验失败'
        );
    }
    account.cookieFingerprint = computed;
    if (!account.name) account.name = 'Bing-' + computed.slice(0, 8);
    return account;
}

function sameAccountIdentity(left, right) {
    if (
        left.oauthRuid
        && right.oauthRuid
        && left.oauthRuid === right.oauthRuid
    ) {
        return true;
    }
    return Boolean(
        left.cookieFingerprint
        && right.cookieFingerprint
        && left.cookieFingerprint === right.cookieFingerprint
    );
}

function assertDistinctAccountIdentities(list) {
    for (let left = 0; left < list.length; left++) {
        for (let right = left + 1; right < list.length; right++) {
            if (sameAccountIdentity(list[left], list[right])) {
                throw new Error(
                    '账号“' + list[left].name + '”与“'
                        + list[right].name + '”身份重复'
                );
            }
        }
    }
}

async function getQingLongAccountState(origin, apiToken) {
    const bingEnvs = await getExactEnvs(origin, apiToken, 'bing_ck');
    const records = [];
    for (const env of bingEnvs) {
        const decoded = globalThis.BingCkCodec.decodeAccounts(env.value);
        if (decoded.length !== 1) {
            throw new Error('青龙每条 bing_ck 必须只对应一个账号');
        }
        records.push({
            env: env,
            account: await completeAccountIdentity(decoded[0])
        });
    }

    const legacyEnvs = await getExactEnvs(
        origin,
        apiToken,
        'BING_REWARDS_ACCOUNTS'
    );
    for (const env of legacyEnvs) {
        if (!String(env.value || '').trim()) continue;
        let parsed;
        try {
            parsed = JSON.parse(env.value);
        } catch (_) {
            throw new Error('青龙现有 BING_REWARDS_ACCOUNTS 不是有效 JSON');
        }
        if (!Array.isArray(parsed)) {
            throw new Error('青龙现有 BING_REWARDS_ACCOUNTS 不是数组');
        }
        for (const item of parsed) {
            const normalized = normalizeLegacyAccount(item);
            if (!normalized) continue;
            const account = await completeAccountIdentity(normalized);
            if (!records.some(function (record) {
                return sameAccountIdentity(record.account, account);
            })) {
                records.push({ env: null, account: account });
            }
        }
    }
    assertDistinctAccountIdentities(records.map(function (record) {
        return record.account;
    }));
    return {
        records: records,
        bingEnvs: bingEnvs,
        legacyEnvs: legacyEnvs
    };
}

async function reconcileBingCkEnvs(
    origin,
    apiToken,
    desiredAccounts,
    existingEnvs,
    removeAllStale
) {
    assertDistinctAccountIdentities(desiredAccounts);
    const existing = [];
    for (const env of existingEnvs) {
        const decoded = globalThis.BingCkCodec.decodeAccounts(env.value);
        if (decoded.length !== 1) {
            throw new Error('青龙每条 bing_ck 必须只对应一个账号');
        }
        existing.push({
            env: env,
            account: await completeAccountIdentity(decoded[0]),
            used: false
        });
    }
    const creations = [];
    for (const account of desiredAccounts) {
        const matches = existing.filter(function (record) {
            return sameAccountIdentity(record.account, account);
        });
        if (matches.length > 1) {
            throw new Error('青龙存在重复 bing_ck 身份，已拒绝覆盖');
        }
        const value = globalThis.BingCkCodec.encodeAccount(account);
        const remarks = '由浏览器扩展同步｜' + account.name;
        if (matches.length) {
            matches[0].used = true;
            await updateEnv(
                origin,
                apiToken,
                matches[0].env,
                'bing_ck',
                value,
                remarks
            );
        } else {
            creations.push({
                name: 'bing_ck',
                value: value,
                remarks: remarks
            });
        }
    }
    await createEnvs(origin, apiToken, creations);
    const staleIds = existing.filter(function (record) {
        return !record.used && (
            removeAllStale
            || String(record.env.remarks || '').startsWith('由浏览器扩展同步')
        );
    }).map(function (record) {
        return record.env.id || record.env._id;
    });
    return deleteEnvIds(origin, apiToken, staleIds);
}

async function deleteLegacyExtensionEnvs(origin, apiToken) {
    const searches = await Promise.all([
        getExactEnvs(origin, apiToken, 'BING_REWARDS_ACCOUNTS'),
        qlRequest(
            origin,
            '/open/envs?searchValue=' + encodeURIComponent('bing_'),
            apiToken
        )
    ]);
    const candidates = searches[0].concat(
        Array.isArray(searches[1]) ? searches[1] : []
    );
    const ids = candidates.filter(function (item) {
        return (
            item.name === 'BING_REWARDS_ACCOUNTS'
            || /^bing_(?:ck|search_ck|token)_\d+$/.test(
                String(item.name || '')
            )
        ) && String(item.remarks || '').startsWith('由浏览器扩展同步');
    }).map(function (item) {
        return item.id || item._id;
    });
    return deleteEnvIds(origin, apiToken, Array.from(new Set(ids)));
}

function mergeAccountByIdentity(existing, incoming) {
    return globalThis.BingCkCodec.mergeAccountByIdentity(
        existing,
        incoming
    );
}

async function syncToQingLong(mode) {
    const origin = normalizePanelUrl(elements['ql-url'].value);
    const clientId = elements['ql-client-id'].value.trim();
    const clientSecret = elements['ql-client-secret'].value;
    if (!clientId || !clientSecret) {
        throw new Error('请填写青龙 OpenAPI Client ID 和 Secret');
    }
    await loadAccounts(selectedAccountId);
    let syncAccounts;
    if (mode === 'selected') {
        const selected = selectedAccount();
        if (!selected || !selected.refreshToken) {
            throw new Error('所选账号尚未获取 Token');
        }
        syncAccounts = [{
            name: selected.name,
            cookie: selected.cookie,
            searchCookie: selected.searchCookie,
            cookieFingerprint: selected.cookieFingerprint,
            refreshToken: selected.refreshToken,
            oauthRuid: selected.oauthRuid || ''
        }];
    } else {
        syncAccounts = exportAccounts(true);
    }
    const pendingText = mode === 'selected'
        ? '正在按身份同步所选账号“' + syncAccounts[0].name + '”…'
        : '正在覆盖同步 ' + syncAccounts.length + ' 个账号到青龙…';
    setMessage(elements['copy-status'], pendingText, true);
    chrome.storage.session.set({
        lastSyncStatus: { text: pendingText, ok: true, time: Date.now() }
    }).catch(function () {});
    await requestOriginPermission(origin);
    await saveSettings();
    const query = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret
    });
    const tokenData = await qlRequest(
        origin,
        '/open/auth/token?' + query.toString(),
        ''
    );
    const apiToken = tokenData.token;
    const state = await getQingLongAccountState(origin, apiToken);
    if (mode === 'selected') {
        const existing = state.records.map(function (record) {
            return record.account;
        });
        syncAccounts = mergeAccountByIdentity(existing, syncAccounts[0]);
    }
    const removed = await reconcileBingCkEnvs(
        origin,
        apiToken,
        syncAccounts,
        state.bingEnvs,
        mode === 'all'
    );
    const legacyRemoved = await deleteLegacyExtensionEnvs(origin, apiToken);
    await recordSyncStatus(
        '同步成功：写入 ' + syncAccounts.length + ' 条同名 bing_ck'
            + (removed + legacyRemoved
                ? '，清理 ' + (removed + legacyRemoved) + ' 条旧变量。'
                : '。'),
        true
    );
}

elements['account-select'].addEventListener('change', function () {
    selectedAccountId = elements['account-select'].value;
    renderAccounts();
    updateOAuthStatus();
});

elements['add-account'].addEventListener('click', function () {
    elements['add-account'].disabled = true;
    captureCurrentAccount('new').catch(function (error) {
        setMessage(elements['account-status'], error.message, false);
    }).finally(updateControls);
});

elements['replace-account'].addEventListener('click', function () {
    elements['replace-account'].disabled = true;
    captureCurrentAccount('replace').catch(function (error) {
        setMessage(elements['account-status'], error.message, false);
    }).finally(updateControls);
});

elements['rename-account'].addEventListener('click', function () {
    const selected = selectedAccount();
    if (!selected) return;
    sendMessage({
        type: 'accounts:rename',
        accountId: selected.id,
        name: elements['account-name'].value
    }).then(function (response) {
        return loadAccounts(response.account.id);
    }).then(function () {
        setMessage(elements['account-status'], '账号备注已保存。', true);
    }).catch(function (error) {
        setMessage(elements['account-status'], error.message, false);
    });
});

elements['remove-account'].addEventListener('click', function () {
    const selected = selectedAccount();
    if (!selected) return;
    if (!confirm('删除“' + selected.name + '”及其临时 Cookie/Token？')) return;
    sendMessage({
        type: 'accounts:remove',
        accountId: selected.id
    }).then(function () {
        selectedAccountId = '';
        return loadAccounts();
    }).then(updateOAuthStatus).catch(function (error) {
        setMessage(elements['account-status'], error.message, false);
    });
});

elements['copy-cookie'].addEventListener('click', function () {
    const selected = selectedAccount();
    if (!selected) return;
    copyText(
        globalThis.BingCkCodec.encodeAccount(selected),
        '“' + selected.name + '”的 bing_ck 已复制。'
    ).catch(function (error) {
        setMessage(elements['copy-status'], error.message, false);
    });
});

elements['copy-json'].addEventListener('click', function () {
    try {
        const values = exportAccounts(false).map(function (account) {
            return 'bing_ck='
                + globalThis.BingCkCodec.encodeAccount(account);
        });
        copyText(
            values.join('\n\n'),
            accounts.length + ' 条独立 bing_ck 已复制。'
        ).catch(function (error) {
            setMessage(elements['copy-status'], error.message, false);
        });
    } catch (error) {
        setMessage(elements['copy-status'], error.message, false);
    }
});

elements['start-oauth'].addEventListener('click', function () {
    const selected = selectedAccount();
    if (!selected || !cookieReady) {
        setMessage(elements['oauth-status'], '请先添加并选择当前浏览器账号。', false);
        return;
    }
    if (selected.cookieFingerprint !== currentCookieFingerprint) {
        setMessage(
            elements['oauth-status'],
            '浏览器当前账号与所选账号不一致，请切换账号或更新所选会话。',
            false
        );
        return;
    }
    sendMessage({
        type: 'oauth:start',
        accountId: selected.id,
        cookieFingerprint: currentCookieFingerprint
    }).then(function () {
        updateOAuthStatus();
        if (oauthPoll) clearInterval(oauthPoll);
        oauthPoll = setInterval(updateOAuthStatus, 1000);
    }).catch(function (error) {
        setMessage(elements['oauth-status'], error.message, false);
    });
});

elements['refresh-session'].addEventListener('click', function () {
    elements['refresh-session'].disabled = true;
    loadAccounts(selectedAccountId).then(loadCookies).then(updateOAuthStatus).finally(function () {
        elements['refresh-session'].disabled = false;
    });
});

elements['clear-oauth'].addEventListener('click', function () {
    const selected = selectedAccount();
    if (!selected) return;
    sendMessage({
        type: 'oauth:clear',
        accountId: selected.id
    }).then(function () {
        return loadAccounts(selected.id);
    }).then(updateOAuthStatus).catch(function (error) {
        setMessage(elements['oauth-status'], error.message, false);
    });
});

for (const id of SAVED_SETTING_IDS) {
    elements[id].addEventListener('input', scheduleSettingsSave);
}

elements['remember-settings'].addEventListener('change', function () {
    saveSettings().catch(function (error) {
        setMessage(elements['copy-status'], '保存设置失败：' + error.message, false);
    });
});

elements['clear-settings'].addEventListener('click', function () {
    const savedOrigin = elements['ql-url'].value;
    chrome.storage.local.remove([SAVED_SETTINGS_KEY]).then(async function () {
        try {
            if (savedOrigin) await removeOriginPermission(normalizePanelUrl(savedOrigin));
        } catch (_) {}
        for (const id of SAVED_SETTING_IDS) elements[id].value = '';
        elements['remember-settings'].checked = false;
        await recordSyncStatus('已清除保存的青龙连接信息。', true);
    }).catch(function (error) {
        setMessage(elements['copy-status'], '清除失败：' + error.message, false);
    });
});

elements['sync-ql'].addEventListener('click', function () {
    elements['sync-ql'].disabled = true;
    syncToQingLong('all').catch(function (error) {
        recordSyncStatus('同步失败：' + error.message, false).catch(function () {});
    }).finally(updateControls);
});

elements['sync-selected-ql'].addEventListener('click', function () {
    elements['sync-selected-ql'].disabled = true;
    syncToQingLong('selected').catch(function (error) {
        recordSyncStatus('同步失败：' + error.message, false).catch(function () {});
    }).finally(updateControls);
});

async function initialize() {
    try {
        await restoreSettings();
    } catch (error) {
        setMessage(elements['copy-status'], '读取保存信息失败：' + error.message, false);
    }
    await restoreSyncStatus().catch(function () {});
    await loadAccounts();
    await loadCookies();
    await updateOAuthStatus();
}

initialize();
