/*
 * Microsoft Rewards QingLong Sync
 * SPDX-License-Identifier: MIT
 */

'use strict';

const REQUIRED_AUTH_COOKIES = ['_U', '.MSA.Auth', 'tifacfaatcs'];
const elements = Object.fromEntries([
    'status', 'copy-status', 'copy-cookie', 'copy-json', 'account-name',
    'start-oauth', 'clear-oauth', 'oauth-status',
    'ql-url', 'ql-client-id', 'ql-client-secret', 'sync-ql'
].map(function (id) {
    return [id, document.getElementById(id)];
}));

let cachedCookieHeader = '';
let cookieReady = false;
let oauthPoll = null;

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

function buildCookieHeader(cookies) {
    const now = Date.now() / 1000;
    const current = cookies.filter(function (cookie) {
        return cookie.session || !cookie.expirationDate || cookie.expirationDate > now;
    });
    current.sort(function (left, right) {
        if (left.path.length !== right.path.length) return right.path.length - left.path.length;
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

async function copyText(text, successMessage) {
    await navigator.clipboard.writeText(text);
    setMessage(elements['copy-status'], successMessage, true);
}

async function loadCookies() {
    elements['copy-cookie'].disabled = true;
    elements['copy-json'].disabled = true;
    elements['sync-ql'].disabled = true;
    cookieReady = false;
    try {
        const cookies = await getCookies({ url: 'https://rewards.bing.com/' });
        cachedCookieHeader = buildCookieHeader(cookies);
        const names = new Set(cookies.map(function (cookie) { return cookie.name; }));
        const missing = REQUIRED_AUTH_COOKIES.filter(function (name) { return !names.has(name); });
        if (!cachedCookieHeader || missing.length) {
            elements.status.className = 'error';
            elements.status.textContent = missing.length
                ? 'Cookie 不完整，缺少 ' + missing.join('、') + '。请先打开积分仪表板。'
                : '未读取到 Cookie，请先登录 Microsoft Rewards。';
            return;
        }
        cookieReady = true;
        elements.status.className = 'ok';
        elements.status.textContent = '已检测到完整登录 Cookie（共 ' + cookies.length + ' 项）。';
        elements['copy-cookie'].disabled = false;
        elements['copy-json'].disabled = false;
        elements['sync-ql'].disabled = false;
    } catch (error) {
        elements.status.className = 'error';
        elements.status.textContent = '读取失败：' + error.message;
    }
}

async function getAccountConfig(requireToken) {
    if (!cookieReady) throw new Error('Cookie 尚未就绪');
    const tokenResult = await sendMessage({ type: 'oauth:get-token' });
    if (requireToken && !tokenResult.refreshToken) throw new Error('请先完成 OAuth 授权');
    return [{
        name: elements['account-name'].value.trim() || '账号1',
        cookie: cachedCookieHeader,
        refreshToken: tokenResult.refreshToken || ''
    }];
}

async function updateOAuthStatus() {
    try {
        const result = await sendMessage({ type: 'oauth:status' });
        if (result.status === 'ready') {
            setMessage(elements['oauth-status'], 'refreshToken 已获取，当前浏览器会话内有效。', true);
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
    // permissions.request 必须直接源自用户点击，放在其他异步操作之前。
    await requestOriginPermission(origin);
    try {
        const accounts = await getAccountConfig(true);
        const query = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
        const tokenData = await qlRequest(origin, '/open/auth/token?' + query.toString(), '');
        const apiToken = tokenData.token;
        await upsertEnv(origin, apiToken, 'BING_REWARDS_ACCOUNTS', JSON.stringify(accounts), '由浏览器扩展同步');
        await upsertEnv(origin, apiToken, 'bing_ck_1', accounts[0].cookie, '由浏览器扩展同步');
        await upsertEnv(origin, apiToken, 'bing_token_1', accounts[0].refreshToken, '由浏览器扩展同步');
        setMessage(elements['copy-status'], '已同步 BING_REWARDS_ACCOUNTS、bing_ck_1、bing_token_1。', true);
    } finally {
        await removeOriginPermission(origin);
    }
}

elements['copy-cookie'].addEventListener('click', function () {
    if (cachedCookieHeader) copyText(cachedCookieHeader, 'Cookie 已复制。').catch(function (error) {
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
    sendMessage({ type: 'oauth:start' }).then(function () {
        updateOAuthStatus();
        if (oauthPoll) clearInterval(oauthPoll);
        oauthPoll = setInterval(updateOAuthStatus, 1000);
    }).catch(function (error) {
        setMessage(elements['oauth-status'], error.message, false);
    });
});

elements['clear-oauth'].addEventListener('click', function () {
    sendMessage({ type: 'oauth:clear' }).then(updateOAuthStatus).catch(function (error) {
        setMessage(elements['oauth-status'], error.message, false);
    });
});

elements['sync-ql'].addEventListener('click', function () {
    elements['sync-ql'].disabled = true;
    syncToQingLong().catch(function (error) {
        setMessage(elements['copy-status'], '同步失败：' + error.message, false);
    }).finally(function () {
        elements['sync-ql'].disabled = !cookieReady;
    });
});

loadCookies();
updateOAuthStatus();
