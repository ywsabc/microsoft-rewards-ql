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
const SESSION_KEYS = [
    'oauthState',
    'oauthTabId',
    'oauthStatus',
    'oauthError',
    'refreshToken'
];

async function openDashboard() {
    const pageUrl = chrome.runtime.getURL(DASHBOARD_PAGE);
    const saved = await chrome.storage.session.get(['dashboardTabId']);
    if (saved.dashboardTabId) {
        try {
            await chrome.tabs.update(saved.dashboardTabId, { active: true });
            return;
        } catch (_) {
            await chrome.storage.session.remove(['dashboardTabId']);
        }
    }
    const tab = await chrome.tabs.create({ url: pageUrl, active: true });
    await chrome.storage.session.set({ dashboardTabId: tab.id });
}

chrome.action.onClicked.addListener(function () {
    openDashboard().catch(function (error) {
        console.error('打开同步页面失败:', error);
    });
});

chrome.tabs.onRemoved.addListener(async function (tabId) {
    const saved = await chrome.storage.session.get(['dashboardTabId']);
    if (saved.dashboardTabId === tabId) {
        await chrome.storage.session.remove(['dashboardTabId']);
    }
});

function randomState() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return Array.from(bytes, function (value) {
        return value.toString(16).padStart(2, '0');
    }).join('');
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

async function setFailure(message) {
    await chrome.storage.session.set({
        oauthStatus: 'error',
        oauthError: String(message || 'OAuth 失败'),
        refreshToken: ''
    });
}

async function exchangeCode(code) {
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
    await chrome.storage.session.set({
        oauthStatus: 'ready',
        oauthError: '',
        refreshToken: data.refresh_token
    });
}

async function startOAuth() {
    const state = randomState();
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
        client_id: CLIENT_ID,
        scope: REWARDS_SCOPE,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        state: state
    }).toString();
    const tab = await chrome.tabs.create({ url: url.toString(), active: true });
    await chrome.storage.session.set({
        oauthState: state,
        oauthTabId: tab.id,
        oauthStatus: 'pending',
        oauthError: '',
        refreshToken: ''
    });
}

chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo) {
    const url = changeInfo.url || '';
    if (!url.startsWith(REDIRECT_URI)) return;
    const session = await chrome.storage.session.get(SESSION_KEYS);
    if (session.oauthTabId !== tabId || session.oauthStatus !== 'pending') return;
    try {
        const callback = parseCallback(url);
        if (callback.error) throw new Error(callback.error);
        if (!callback.code) throw new Error('OAuth 回调缺少 code');
        if (!callback.state || callback.state !== session.oauthState) {
            throw new Error('OAuth state 校验失败');
        }
        await exchangeCode(callback.code);
    } catch (error) {
        await setFailure(error.message);
    } finally {
        chrome.tabs.remove(tabId).catch(function () {});
        await chrome.storage.session.remove(['oauthState', 'oauthTabId']);
    }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    const run = async function () {
        if (!message || !message.type) throw new Error('消息格式错误');
        if (message.type === 'oauth:start') {
            await startOAuth();
            return { ok: true };
        }
        if (message.type === 'oauth:status') {
            const data = await chrome.storage.session.get([
                'oauthStatus',
                'oauthError',
                'refreshToken'
            ]);
            return {
                ok: true,
                status: data.oauthStatus || 'empty',
                error: data.oauthError || '',
                hasRefreshToken: Boolean(data.refreshToken)
            };
        }
        if (message.type === 'oauth:get-token') {
            const data = await chrome.storage.session.get(['refreshToken']);
            return { ok: true, refreshToken: data.refreshToken || '' };
        }
        if (message.type === 'oauth:clear') {
            await chrome.storage.session.remove(SESSION_KEYS);
            return { ok: true };
        }
        throw new Error('不支持的消息类型');
    };
    run().then(sendResponse).catch(function (error) {
        sendResponse({ ok: false, error: error.message });
    });
    return true;
});
