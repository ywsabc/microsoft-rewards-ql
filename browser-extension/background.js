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
    return String(value || fallback || '账号').trim().slice(0, 60) || '账号';
}

function accountNameKey(value) {
    return normalizeAccountName(value).toLocaleLowerCase();
}

function normalizeAccount(input, index) {
    if (!input || typeof input !== 'object') return null;
    const cookieFingerprint = String(input.cookieFingerprint || '');
    const cookie = String(input.cookie || '');
    const searchCookie = String(input.searchCookie || '');
    if (!cookieFingerprint || !cookie || !searchCookie) return null;
    return {
        id: String(input.id || randomAccountId()),
        name: normalizeAccountName(input.name, '账号' + (index + 1)),
        cookieFingerprint: cookieFingerprint,
        cookie: cookie,
        searchCookie: searchCookie,
        refreshToken: String(input.refreshToken || ''),
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
        '账号' + (accounts.length + 1)
    );
    let account = null;
    if (mode === 'replace') {
        account = accounts.find(function (item) {
            return item.id === String(input.accountId || '');
        });
        if (!account) throw new Error('所选账号不存在');
        const duplicate = accounts.find(function (item) {
            return item.id !== account.id
                && accountNameKey(item.name) === accountNameKey(requestedName);
        });
        if (duplicate) throw new Error('账号备注已存在：' + duplicate.name);
    } else {
        account = accounts.find(function (item) {
            return item.cookieFingerprint === fingerprint;
        }) || accounts.find(function (item) {
            return accountNameKey(item.name) === accountNameKey(requestedName);
        });
    }
    if (!account) {
        if (accounts.length >= MAX_ACCOUNTS) {
            throw new Error('最多保存 ' + MAX_ACCOUNTS + ' 个账号');
        }
        account = {
            id: randomAccountId(),
            refreshToken: '',
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
    const duplicate = accounts.find(function (item) {
        return item.id !== account.id
            && accountNameKey(item.name) === accountNameKey(requestedName);
    });
    if (duplicate) throw new Error('账号备注已存在：' + duplicate.name);
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

async function exchangeCode(code, oauthSession) {
    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        code: code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
    });
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || !data.refresh_token) {
        throw new Error(data.error_description || data.error || ('Token HTTP ' + response.status));
    }
    const accounts = await getAccounts();
    const account = accounts.find(function (item) {
        return item.id === oauthSession.oauthAccountId;
    });
    if (!account) throw new Error('授权对应的账号已经被删除');
    if (account.cookieFingerprint !== oauthSession.oauthCookieFingerprint) {
        throw new Error('账号 Cookie 会话在授权期间发生变化');
    }
    account.refreshToken = data.refresh_token;
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
