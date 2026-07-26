/*
 * Microsoft Rewards QingLong Sync
 * SPDX-License-Identifier: MIT
 */

'use strict';

// tifacfaatcs was used by an older Rewards implementation, but current
// sessions do not consistently issue it. Do not reject a signed-in account
// merely because that legacy anti-forgery cookie is absent.
const REQUIRED_AUTH_COOKIES = ['_U', '.MSA.Auth'];
const SAVED_SETTINGS_KEY = 'qingLongSettings';
const SAVED_SETTING_IDS = [
    'account-name',
    'ql-url',
    'ql-client-id',
    'ql-client-secret'
];
const elements = Object.fromEntries([
    'status', 'rewards-status', 'bing-status', 'refresh-session',
    'copy-status', 'copy-cookie', 'copy-json', 'account-name',
    'start-oauth', 'clear-oauth', 'oauth-status',
    'ql-url', 'ql-client-id', 'ql-client-secret', 'remember-settings',
    'clear-settings', 'sync-ql'
].map(function (id) {
    return [id, document.getElementById(id)];
}));

let cachedRewardsCookieHeader = '';
let cachedBingCookieHeader = '';
let currentCookieFingerprint = '';
let cookieReady = false;
let oauthPoll = null;
let saveTimer = null;

function setMessage(element, text, ok) {
    element.className = 'message ' + (ok ? 'ok' : 'error');
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
        cookieValue(rewardsCookie, '.MSA.Auth'),
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

async function loadCookies() {
    elements['copy-cookie'].disabled = true;
    elements['copy-json'].disabled = true;
    elements['sync-ql'].disabled = true;
    elements['start-oauth'].disabled = true;
    cookieReady = false;
    currentCookieFingerprint = '';
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
        const missing = REQUIRED_AUTH_COOKIES.filter(function (name) { return !names.has(name); });
        const rewardsU = cookieValue(cachedRewardsCookieHeader, '_U');
        const bingU = cookieValue(cachedBingCookieHeader, '_U');
        elements['rewards-status'].className = 'session-line ' + (
            cachedRewardsCookieHeader && !missing.length ? 'ok' : 'error'
        );
        elements['rewards-status'].textContent = cachedRewardsCookieHeader && !missing.length
            ? 'Rewards：已登录，共 ' + rewardsCookies.length + ' 项 Cookie'
            : 'Rewards：缺少 ' + (missing.join('、') || '登录 Cookie');
        elements['bing-status'].className = 'session-line ' + (bingU ? 'ok' : 'error');
        elements['bing-status'].textContent = bingU
            ? 'Bing：已登录，共 ' + bingCookies.length + ' 项 Cookie'
            : 'Bing：缺少 _U，请先登录 www.bing.com';
        if (!cachedRewardsCookieHeader || missing.length || !bingU) {
            setMessage(elements.status, '两个站点尚未全部登录，暂不能同步。', false);
            return;
        }
        if (rewardsU !== bingU) {
            setMessage(
                elements.status,
                'Bing 与 Rewards 的 _U 会话不一致，请切换为同一账号后刷新。',
                false
            );
            elements['bing-status'].className = 'session-line error';
            return;
        }
        currentCookieFingerprint = await fingerprintCookies(
            cachedRewardsCookieHeader,
            cachedBingCookieHeader
        );
        cookieReady = true;
        setMessage(elements.status, '两个站点的 Bing 登录会话一致，可以授权和同步。', true);
        elements['copy-cookie'].disabled = false;
        elements['copy-json'].disabled = false;
        elements['sync-ql'].disabled = false;
        elements['start-oauth'].disabled = false;
    } catch (error) {
        setMessage(elements.status, '读取失败：' + error.message, false);
    }
}

async function getAccountConfig(requireToken) {
    if (!cookieReady) throw new Error('Cookie 尚未就绪');
    const tokenResult = await sendMessage({ type: 'oauth:get-token' });
    if (requireToken && !tokenResult.refreshToken) throw new Error('请先完成 OAuth 授权');
    if (
        tokenResult.refreshToken
        && tokenResult.cookieFingerprint !== currentCookieFingerprint
    ) {
        throw new Error('Cookie 账号已切换，请重新选择账号并完成 OAuth 授权');
    }
    return [{
        name: elements['account-name'].value.trim() || '账号1',
        cookie: cachedRewardsCookieHeader,
        searchCookie: cachedBingCookieHeader,
        refreshToken: tokenResult.refreshToken || ''
    }];
}

async function updateOAuthStatus() {
    try {
        const result = await sendMessage({ type: 'oauth:status' });
        if (result.status === 'ready') {
            if (!currentCookieFingerprint) {
                setMessage(elements['oauth-status'], '请先完成两个站点的登录检查。', false);
            } else if (result.cookieFingerprint !== currentCookieFingerprint) {
                setMessage(
                    elements['oauth-status'],
                    'Cookie 账号已经变化，旧 Token 已失效，请重新选择账号授权。',
                    false
                );
            } else {
                setMessage(
                    elements['oauth-status'],
                    'refreshToken 已获取，并已绑定当前 Cookie 会话。',
                    true
                );
            }
            if (oauthPoll) clearInterval(oauthPoll);
            oauthPoll = null;
        } else if (result.status === 'pending') {
            elements['oauth-status'].className = 'message';
            elements['oauth-status'].textContent = '等待 Microsoft 授权完成…';
        } else if (result.status === 'error') {
            setMessage(elements['oauth-status'], 'OAuth 失败：' + result.error, false);
            if (oauthPoll) clearInterval(oauthPoll);
            oauthPoll = null;
        } else {
            elements['oauth-status'].className = 'message';
            elements['oauth-status'].textContent = '尚未获取 Token。';
        }
    } catch (error) {
        setMessage(elements['oauth-status'], error.message, false);
    }
}

function normalizePanelUrl(value) {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('青龙地址必须是 HTTP 或 HTTPS');
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
    const response = await fetch(origin + path, Object.assign({}, options || {}, { headers: headers }));
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.code !== 200) {
        throw new Error(data.message || ('青龙 HTTP ' + response.status));
    }
    return data.data;
}

async function upsertEnv(origin, apiToken, name, value, remarks) {
    const matches = await qlRequest(
        origin,
        '/open/envs?searchValue=' + encodeURIComponent(name),
        apiToken
    );
    const current = (Array.isArray(matches) ? matches : []).find(function (item) {
        return item.name === name;
    });
    const body = current
        ? { id: current.id, name: name, value: value, remarks: remarks }
        : [{ name: name, value: value, remarks: remarks }];
    await qlRequest(origin, '/open/envs', apiToken, {
        method: current ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function syncToQingLong() {
    const origin = normalizePanelUrl(elements['ql-url'].value);
    const clientId = elements['ql-client-id'].value.trim();
    const clientSecret = elements['ql-client-secret'].value;
    if (!clientId || !clientSecret) throw new Error('请填写青龙 OpenAPI Client ID 和 Secret');
    const pendingText = '正在申请青龙地址权限并开始同步…';
    setMessage(elements['copy-status'], pendingText, true);
    chrome.storage.session.set({
        lastSyncStatus: { text: pendingText, ok: true, time: Date.now() }
    }).catch(function () {});
    // 独立扩展小窗不会像 action 临时弹层一样在权限确认时被销毁。
    // permissions.request 保持为本次点击后的第一个异步等待。
    await requestOriginPermission(origin);
    await saveSettings();
    const accounts = await getAccountConfig(true);
    const query = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
    const tokenData = await qlRequest(origin, '/open/auth/token?' + query.toString(), '');
    const apiToken = tokenData.token;
    await upsertEnv(origin, apiToken, 'BING_REWARDS_ACCOUNTS', JSON.stringify(accounts), '由浏览器扩展同步');
    await upsertEnv(origin, apiToken, 'bing_ck_1', accounts[0].cookie, '由浏览器扩展同步');
    await upsertEnv(origin, apiToken, 'bing_search_ck_1', accounts[0].searchCookie, '由浏览器扩展同步');
    await upsertEnv(origin, apiToken, 'bing_token_1', accounts[0].refreshToken, '由浏览器扩展同步');
    await recordSyncStatus('同步成功：Rewards Cookie、Bing Cookie 和 Token 均已写入青龙。', true);
}

elements['copy-cookie'].addEventListener('click', function () {
    if (cachedRewardsCookieHeader) copyText(
        cachedRewardsCookieHeader,
        'Rewards Cookie 已复制；完整配置请复制账号 JSON。'
    ).catch(function (error) {
        setMessage(elements['copy-status'], error.message, false);
    });
});

elements['copy-json'].addEventListener('click', function () {
    getAccountConfig(false).then(function (config) {
        return copyText(JSON.stringify(config, null, 2), '账号 JSON 已复制。');
    }).catch(function (error) {
        setMessage(elements['copy-status'], error.message, false);
    });
});

elements['start-oauth'].addEventListener('click', function () {
    if (!cookieReady || !currentCookieFingerprint) {
        setMessage(elements['oauth-status'], '请先让 Bing 与 Rewards 登录同一账号。', false);
        return;
    }
    sendMessage({
        type: 'oauth:start',
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
    loadCookies().then(updateOAuthStatus).finally(function () {
        elements['refresh-session'].disabled = false;
    });
});

elements['clear-oauth'].addEventListener('click', function () {
    sendMessage({ type: 'oauth:clear' }).then(updateOAuthStatus).catch(function (error) {
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
        for (const id of SAVED_SETTING_IDS) elements[id].value = id === 'account-name' ? '账号1' : '';
        elements['remember-settings'].checked = false;
        await recordSyncStatus('已清除保存的青龙连接信息。', true);
    }).catch(function (error) {
        setMessage(elements['copy-status'], '清除失败：' + error.message, false);
    });
});

elements['sync-ql'].addEventListener('click', function () {
    elements['sync-ql'].disabled = true;
    syncToQingLong().catch(function (error) {
        recordSyncStatus('同步失败：' + error.message, false).catch(function () {});
    }).finally(function () {
        elements['sync-ql'].disabled = !cookieReady;
    });
});

async function initialize() {
    try {
        await restoreSettings();
    } catch (error) {
        setMessage(elements['copy-status'], '读取保存信息失败：' + error.message, false);
    }
    await restoreSyncStatus().catch(function () {});
    await loadCookies();
    await updateOAuthStatus();
}

initialize();
