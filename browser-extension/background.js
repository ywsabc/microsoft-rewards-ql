/*
 * Microsoft Rewards QingLong Sync - OAuth background worker
 * SPDX-License-Identifier: MIT
 */

'use strict';

const AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const REWARDS_SCOPE = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL';
const CLIENT_ID = '0000000040170455';
const REWARDS_DAPI_ME = 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=105';
const REWARDS_USERINFO = 'https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest';
const REWARDS_APP_ID = 'SAAndroid/32.6.2110003560';
const DASHBOARD_PAGE = 'popup.html';
const ACCOUNT_STORAGE_KEY = 'rewardAccounts';
const MAX_ACCOUNTS = 20;
const OAUTH_SESSION_KEYS = [
    'oauthState',
    'oauthTabId',
    'oauthStatus',
    'oauthError',
    'oauthAccountId',
    'oauthCookieFingerprint'
];

async function openDashboard() {
    const pageUrl = chrome.runtime.getURL(DASHBOARD_PAGE);
    const saved = await chrome.storage.session.get(['dashboardWindowId']);
    if (saved.dashboardWindowId) {
        try {
            await chrome.windows.get(saved.dashboardWindowId);
            await chrome.windows.update(saved.dashboardWindowId, {
                focused: true,
                state: 'normal'
            });
            return;
        } catch (_) {
            await chrome.storage.session.remove(['dashboardWindowId']);
        }
    }
    const windowInfo = await chrome.windows.create({
        url: pageUrl,
        type: 'popup',
        focused: true,
        width: 500,
        height: 800
    });
    if (!windowInfo || !windowInfo.id) throw new Error('浏览器未返回小窗 ID');
    await chrome.storage.session.set({ dashboardWindowId: windowInfo.id });
}

chrome.action.onClicked.addListener(function () {
    openDashboard().catch(function (error) {
        console.error('打开同步页面失败:', error);
    });
});

chrome.windows.onRemoved.addListener(async function (windowId) {
    const saved = await chrome.storage.session.get(['dashboardWindowId']);
    if (saved.dashboardWindowId === windowId) {
        await chrome.storage.session.remove(['dashboardWindowId']);
    }
});

function randomState() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return Array.from(bytes, function (value) {
        return value.toString(16).padStart(2, '0');
    }).join('');
}

function randomAccountId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'account-' + randomState();
}

function normalizeAccountName(value, fallback) {
    return String(value || fallback || 'Bing账号').trim().slice(0, 60)
        || 'Bing账号';
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

function buildCookieHeader(cookies, hostname) {
    const current = cookies.slice().sort(function (left, right) {
        if (left.path.length !== right.path.length) {
            return right.path.length - left.path.length;
        }
        const leftDomain = left.domain.replace(/^\./, '');
        const rightDomain = right.domain.replace(/^\./, '');
        const leftExact = left.hostOnly && leftDomain === hostname ? 1 : 0;
        const rightExact = right.hostOnly && rightDomain === hostname ? 1 : 0;
        if (leftExact !== rightExact) return rightExact - leftExact;
        return rightDomain.length - leftDomain.length;
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

async function inspectBrowserRewardsSession() {
    const lists = await Promise.all([
        getCookies({ url: 'https://rewards.bing.com/' }),
        getCookies({ url: 'https://www.bing.com/' })
    ]);
    const rewardsCookie = buildCookieHeader(
        lists[0],
        'rewards.bing.com'
    );
    const bingCookie = buildCookieHeader(lists[1], 'www.bing.com');
    const rewardsU = cookieValue(rewardsCookie, '_U');
    const bingU = cookieValue(bingCookie, '_U');
    const rewardsAuth = cookieValue(rewardsCookie, '.MSA.Auth')
        || cookieValue(rewardsCookie, '_C_Auth');
    if (!rewardsU || !bingU || !rewardsAuth || rewardsU !== bingU) {
        throw new Error('当前 Bing 与 Rewards 浏览器会话不一致');
    }
    const response = await fetch(REWARDS_USERINFO, {
        credentials: 'include',
        headers: {
            accept: 'application/json',
            'x-requested-with': 'XMLHttpRequest'
        }
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
        throw new Error('Rewards Cookie 身份校验 HTTP ' + response.status);
    }
    const dashboard = data.dashboard || data;
    const userStatus = dashboard.userStatus || {};
    const rawBalance = userStatus.availablePoints
        ?? dashboard.availablePoints
        ?? dashboard.balance;
    const balance = Number(rawBalance);
    if (!Number.isFinite(balance)) {
        throw new Error('Rewards Cookie 身份校验缺少余额');
    }
    return {
        cookieFingerprint: await fingerprintCookies(
            rewardsCookie,
            bingCookie
        ),
        balance: balance
    };
}

function normalizeAccount(input, index) {
    if (!input || typeof input !== 'object') return null;
    const cookieFingerprint = String(input.cookieFingerprint || '');
    const cookie = String(input.cookie || '');
    const searchCookie = String(input.searchCookie || '');
    if (!cookieFingerprint || !cookie || !searchCookie) return null;
    return {
        id: String(input.id || randomAccountId()),
        name: normalizeAccountName(
            input.name,
            'Bing-' + cookieFingerprint.slice(0, 8)
        ),
        cookieFingerprint: cookieFingerprint,
        cookie: cookie,
        searchCookie: searchCookie,
        refreshToken: String(input.refreshToken || ''),
        oauthRuid: String(input.oauthRuid || ''),
        capturedAt: Number(input.capturedAt || Date.now()),
        tokenAt: Number(input.tokenAt || 0),
        oauthError: String(input.oauthError || '')
    };
}

async function getAccounts() {
    const saved = await chrome.storage.session.get([ACCOUNT_STORAGE_KEY]);
    const raw = Array.isArray(saved[ACCOUNT_STORAGE_KEY])
        ? saved[ACCOUNT_STORAGE_KEY]
        : [];
    return raw.map(normalizeAccount).filter(Boolean).slice(0, MAX_ACCOUNTS);
}

async function saveAccounts(accounts) {
    await chrome.storage.session.set({
        [ACCOUNT_STORAGE_KEY]: accounts.slice(0, MAX_ACCOUNTS)
    });
}

async function captureAccount(input) {
    const fingerprint = String(input.cookieFingerprint || '');
    const cookie = String(input.cookie || '');
    const searchCookie = String(input.searchCookie || '');
    if (!fingerprint || !cookie || !searchCookie) {
        throw new Error('当前浏览器账号的 Cookie 尚未就绪');
    }
    const accounts = await getAccounts();
    const mode = input.mode === 'replace' ? 'replace' : 'new';
    const requestedName = normalizeAccountName(
        input.name,
        'Bing-' + fingerprint.slice(0, 8)
    );
    let account = null;
    if (mode === 'replace') {
        account = accounts.find(function (item) {
            return item.id === String(input.accountId || '');
        });
        if (!account) throw new Error('所选账号不存在');
        const duplicateCookie = accounts.find(function (item) {
            return item.id !== account.id
                && item.cookieFingerprint === fingerprint;
        });
        if (duplicateCookie) {
            throw new Error(
                '当前浏览器会话已属于“' + duplicateCookie.name + '”'
            );
        }
    } else {
        const sameCookie = accounts.find(function (item) {
            return item.cookieFingerprint === fingerprint;
        });
        account = sameCookie || null;
    }
    if (!account) {
        if (accounts.length >= MAX_ACCOUNTS) {
            throw new Error('最多保存 ' + MAX_ACCOUNTS + ' 个账号');
        }
        account = {
            id: randomAccountId(),
            refreshToken: '',
            oauthRuid: '',
            tokenAt: 0,
            oauthError: ''
        };
        accounts.push(account);
    }
    const fingerprintChanged = account.cookieFingerprint
        && account.cookieFingerprint !== fingerprint;
    account.name = requestedName;
    account.cookieFingerprint = fingerprint;
    account.cookie = cookie;
    account.searchCookie = searchCookie;
    account.capturedAt = Date.now();
    if (fingerprintChanged) {
        account.refreshToken = '';
        account.oauthRuid = '';
        account.tokenAt = 0;
        account.oauthError = '浏览器会话已更新，请重新授权';
    }
    await saveAccounts(accounts);
    return account;
}

async function renameAccount(accountId, name) {
    const accounts = await getAccounts();
    const account = accounts.find(function (item) {
        return item.id === String(accountId || '');
    });
    if (!account) throw new Error('所选账号不存在');
    const requestedName = normalizeAccountName(name, account.name);
    account.name = requestedName;
    await saveAccounts(accounts);
    return account;
}

async function removeAccount(accountId) {
    const id = String(accountId || '');
    const accounts = await getAccounts();
    const remaining = accounts.filter(function (item) { return item.id !== id; });
    if (remaining.length === accounts.length) throw new Error('所选账号不存在');
    await saveAccounts(remaining);
    const oauth = await chrome.storage.session.get(['oauthAccountId', 'oauthTabId']);
    if (oauth.oauthAccountId === id) {
        if (oauth.oauthTabId) {
            try { await chrome.tabs.remove(oauth.oauthTabId); } catch (_) {}
        }
        await chrome.storage.session.remove(OAUTH_SESSION_KEYS);
    }
}

function parseCallback(url) {
    const parsed = new URL(url);
    const query = parsed.searchParams;
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    return {
        code: query.get('code') || hash.get('code') || '',
        state: query.get('state') || hash.get('state') || '',
        error: query.get('error_description') || query.get('error')
            || hash.get('error_description') || hash.get('error') || ''
    };
}

async function setFailure(message, oauthSession) {
    const errorText = String(message || 'OAuth 失败');
    await chrome.storage.session.set({
        oauthStatus: 'error',
        oauthError: errorText
    });
    const accountId = oauthSession && oauthSession.oauthAccountId;
    if (!accountId) return;
    const accounts = await getAccounts();
    const account = accounts.find(function (item) { return item.id === accountId; });
    if (!account) return;
    account.oauthError = errorText;
    await saveAccounts(accounts);
}

async function inspectOAuthToken(accessToken) {
    const response = await fetch(REWARDS_DAPI_ME, {
        headers: {
            authorization: 'Bearer ' + accessToken,
            'content-type': 'application/json; charset=UTF-8',
            'x-rewards-appid': REWARDS_APP_ID,
            'x-rewards-ismobile': 'true',
            'x-rewards-country': 'cn',
            'x-rewards-language': 'zh'
        }
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
        const error = new Error(
            (data.response && data.response.message)
            || data.message
            || ('Rewards 身份校验 HTTP ' + response.status)
        );
        error.httpStatus = response.status;
        throw error;
    }
    const profile = data.response && data.response.profile;
    const ruid = String(profile && profile.ruid || '');
    if (!ruid) throw new Error('Rewards 身份校验缺少 ruid');
    const rawBalance = data.response && data.response.balance;
    return {
        ruid: ruid,
        balance: Number.isFinite(Number(rawBalance)) ? Number(rawBalance) : null
    };
}

async function requestOAuthToken(parameters) {
    const body = new URLSearchParams(parameters);
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || ('Token HTTP ' + response.status));
    }
    return data;
}

async function refreshOAuthAccessToken(refreshToken) {
    if (!refreshToken) throw new Error('Token 响应缺少 refresh_token');
    return requestOAuthToken({
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
        scope: REWARDS_SCOPE,
        grant_type: 'refresh_token'
    });
}

async function exchangeCode(code, oauthSession) {
    let tokenData = await requestOAuthToken({
        client_id: CLIENT_ID,
        code: code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
    });
    if (!tokenData.refresh_token) {
        throw new Error('Token 响应缺少 refresh_token');
    }
    let oauthIdentity;
    try {
        oauthIdentity = await inspectOAuthToken(tokenData.access_token);
    } catch (error) {
        if (error.httpStatus !== 401) throw error;
        const refreshed = await refreshOAuthAccessToken(
            tokenData.refresh_token
        );
        tokenData = {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token
                || tokenData.refresh_token
        };
        try {
            oauthIdentity = await inspectOAuthToken(
                tokenData.access_token
            );
        } catch (retryError) {
            if (retryError.httpStatus === 401) {
                throw new Error(
                    'Rewards 身份校验 HTTP 401（刷新 Token 后仍无效，'
                    + '请确认该账号能正常打开 Rewards 页面后重新授权）'
                );
            }
            throw retryError;
        }
    }
    const browserIdentity = await inspectBrowserRewardsSession();
    const accounts = await getAccounts();
    const account = accounts.find(function (item) {
        return item.id === oauthSession.oauthAccountId;
    });
    if (!account) throw new Error('授权对应的账号已经被删除');
    if (account.cookieFingerprint !== oauthSession.oauthCookieFingerprint) {
        throw new Error('账号 Cookie 会话在授权期间发生变化');
    }
    if (
        browserIdentity.cookieFingerprint
            !== oauthSession.oauthCookieFingerprint
    ) {
        throw new Error('OAuth 回调时浏览器已切换到其他 Rewards 账号');
    }
    if (
        !Number.isFinite(Number(oauthIdentity.balance))
        || Number(oauthIdentity.balance) !== Number(browserIdentity.balance)
    ) {
        throw new Error(
            'OAuth 账号余额与当前 Rewards Cookie 不一致，已阻止串号'
        );
    }
    const duplicate = accounts.find(function (item) {
        return item.id !== account.id
            && item.oauthRuid
            && item.oauthRuid === oauthIdentity.ruid;
    });
    if (duplicate) {
        throw new Error(
            'OAuth 选择的是已绑定“' + duplicate.name
            + '”的同一 Microsoft 账号，请切换账号后重新授权'
        );
    }
    account.refreshToken = tokenData.refresh_token;
    account.oauthRuid = oauthIdentity.ruid;
    account.tokenAt = Date.now();
    account.oauthError = '';
    await saveAccounts(accounts);
    await chrome.storage.session.set({
        oauthStatus: 'ready',
        oauthError: ''
    });
}

async function startOAuth(accountId, cookieFingerprint) {
    const accounts = await getAccounts();
    const account = accounts.find(function (item) {
        return item.id === String(accountId || '');
    });
    if (!account) throw new Error('请先保存并选择当前账号');
    if (account.cookieFingerprint !== String(cookieFingerprint || '')) {
        throw new Error('浏览器当前账号与所选账号不一致');
    }
    const browserIdentity = await inspectBrowserRewardsSession();
    if (browserIdentity.cookieFingerprint !== account.cookieFingerprint) {
        throw new Error('当前浏览器会话与所选账号不一致');
    }
    const previous = await chrome.storage.session.get(['oauthTabId']);
    if (previous.oauthTabId) {
        try { await chrome.tabs.remove(previous.oauthTabId); } catch (_) {}
    }
    await chrome.storage.session.remove(OAUTH_SESSION_KEYS);
    const state = randomState();
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
        client_id: CLIENT_ID,
        scope: REWARDS_SCOPE,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        state: state,
        prompt: 'select_account'
    }).toString();
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    await chrome.storage.session.set({
        oauthState: state,
        oauthTabId: tab.id,
        oauthStatus: 'pending',
        oauthError: '',
        oauthAccountId: account.id,
        oauthCookieFingerprint: account.cookieFingerprint
    });
    await chrome.tabs.update(tab.id, { url: url.toString(), active: true });
}

chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo) {
    const url = changeInfo.url || '';
    if (!url.startsWith(REDIRECT_URI)) return;
    const session = await chrome.storage.session.get(OAUTH_SESSION_KEYS);
    if (session.oauthTabId !== tabId || session.oauthStatus !== 'pending') return;
    try {
        const callback = parseCallback(url);
        if (callback.error) throw new Error(callback.error);
        if (!callback.code) throw new Error('OAuth 回调缺少 code');
        if (!callback.state || callback.state !== session.oauthState) {
            throw new Error('OAuth state 校验失败');
        }
        await exchangeCode(callback.code, session);
    } catch (error) {
        await setFailure(error.message, session);
    } finally {
        chrome.tabs.remove(tabId).catch(function () {});
        await chrome.storage.session.remove(['oauthState', 'oauthTabId']);
    }
});

async function accountStatus(accountId) {
    const id = String(accountId || '');
    const accounts = await getAccounts();
    const account = accounts.find(function (item) { return item.id === id; });
    if (!account) {
        return {
            status: 'empty',
            error: '',
            hasRefreshToken: false,
            cookieFingerprint: ''
        };
    }
    const oauth = await chrome.storage.session.get(OAUTH_SESSION_KEYS);
    if (oauth.oauthAccountId === id && oauth.oauthStatus === 'pending') {
        return {
            status: 'pending',
            error: '',
            hasRefreshToken: Boolean(account.refreshToken),
            cookieFingerprint: account.cookieFingerprint
        };
    }
    if (oauth.oauthAccountId === id && oauth.oauthStatus === 'error') {
        return {
            status: 'error',
            error: oauth.oauthError || account.oauthError || 'OAuth 失败',
            hasRefreshToken: Boolean(account.refreshToken),
            cookieFingerprint: account.cookieFingerprint
        };
    }
    return {
        status: account.refreshToken ? 'ready' : 'empty',
        error: account.oauthError || '',
        hasRefreshToken: Boolean(account.refreshToken),
        cookieFingerprint: account.cookieFingerprint
    };
}

async function clearAccountToken(accountId) {
    const id = String(accountId || '');
    const accounts = await getAccounts();
    const account = accounts.find(function (item) { return item.id === id; });
    if (!account) throw new Error('所选账号不存在');
    account.refreshToken = '';
    account.oauthRuid = '';
    account.tokenAt = 0;
    account.oauthError = '';
    await saveAccounts(accounts);
    const oauth = await chrome.storage.session.get(['oauthAccountId', 'oauthTabId']);
    if (oauth.oauthAccountId === id) {
        if (oauth.oauthTabId) {
            try { await chrome.tabs.remove(oauth.oauthTabId); } catch (_) {}
        }
        await chrome.storage.session.remove(OAUTH_SESSION_KEYS);
    }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    const run = async function () {
        if (!message || !message.type) throw new Error('消息格式错误');
        if (message.type === 'accounts:list') {
            return { ok: true, accounts: await getAccounts() };
        }
        if (message.type === 'accounts:capture') {
            return { ok: true, account: await captureAccount(message) };
        }
        if (message.type === 'accounts:rename') {
            return {
                ok: true,
                account: await renameAccount(message.accountId, message.name)
            };
        }
        if (message.type === 'accounts:remove') {
            await removeAccount(message.accountId);
            return { ok: true };
        }
        if (message.type === 'accounts:clear') {
            const oauth = await chrome.storage.session.get(['oauthTabId']);
            if (oauth.oauthTabId) {
                try { await chrome.tabs.remove(oauth.oauthTabId); } catch (_) {}
            }
            await chrome.storage.session.remove(
                OAUTH_SESSION_KEYS.concat([ACCOUNT_STORAGE_KEY])
            );
            return { ok: true };
        }
        if (message.type === 'oauth:start') {
            await startOAuth(message.accountId, message.cookieFingerprint);
            return { ok: true };
        }
        if (message.type === 'oauth:status') {
            return Object.assign({ ok: true }, await accountStatus(message.accountId));
        }
        if (message.type === 'oauth:get-token') {
            const accounts = await getAccounts();
            const account = accounts.find(function (item) {
                return item.id === String(message.accountId || '');
            });
            return {
                ok: true,
                refreshToken: account ? account.refreshToken : '',
                oauthRuid: account ? account.oauthRuid : '',
                cookieFingerprint: account ? account.cookieFingerprint : ''
            };
        }
        if (message.type === 'oauth:clear') {
            await clearAccountToken(message.accountId);
            return { ok: true };
        }
        throw new Error('不支持的消息类型');
    };
    run().then(sendResponse).catch(function (error) {
        sendResponse({ ok: false, error: error.message });
    });
    return true;
});
