/*
 * Microsoft Rewards Cookie Exporter
 * SPDX-License-Identifier: MIT
 */

'use strict';

const statusElement = document.getElementById('status');
const copyStatusElement = document.getElementById('copy-status');
const copyCookieButton = document.getElementById('copy-cookie');
const copyJsonButton = document.getElementById('copy-json');
const accountNameInput = document.getElementById('account-name');
const REQUIRED_AUTH_COOKIES = ['_U', '.MSA.Auth', 'tifacfaatcs'];

let cachedCookieHeader = '';

function getCookies(query) {
    if (globalThis.browser && globalThis.browser.cookies) {
        return globalThis.browser.cookies.getAll(query);
    }
    return new Promise(function (resolve, reject) {
        chrome.cookies.getAll(query, function (cookies) {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(cookies);
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
    try {
        await navigator.clipboard.writeText(text);
        copyStatusElement.className = 'message ok';
        copyStatusElement.textContent = successMessage;
    } catch (error) {
        copyStatusElement.className = 'message error';
        copyStatusElement.textContent = '复制失败：' + error.message;
    }
}

async function loadCookies() {
    copyCookieButton.disabled = true;
    copyJsonButton.disabled = true;
    try {
        // 只导出实际会发送到 Rewards 页的 Cookie，避免无关 Bing 子域 Cookie。
        const cookies = await getCookies({ url: 'https://rewards.bing.com/' });
        cachedCookieHeader = buildCookieHeader(cookies);
        const cookieNames = new Set(cookies.map(function (cookie) { return cookie.name; }));
        const missingCookies = REQUIRED_AUTH_COOKIES.filter(function (name) {
            return !cookieNames.has(name);
        });
        if (!cachedCookieHeader) {
            statusElement.className = 'error';
            statusElement.textContent = '未读取到 Cookie，请先登录 Microsoft Rewards。';
            return;
        }
        if (missingCookies.length > 0) {
            statusElement.className = 'error';
            statusElement.textContent = 'Cookie 不完整，缺少 ' + missingCookies.join('、')
                + '。请打开积分仪表板并完成登录后重试。';
            return;
        }
        statusElement.className = 'ok';
        statusElement.textContent = '已检测到完整登录 Cookie（共 ' + cookies.length + ' 项）。';
        copyCookieButton.disabled = false;
        copyJsonButton.disabled = false;
    } catch (error) {
        statusElement.className = 'error';
        statusElement.textContent = '读取失败：' + error.message;
    }
}

copyCookieButton.addEventListener('click', function () {
    if (cachedCookieHeader) copyText(cachedCookieHeader, 'Cookie 已复制。');
});

copyJsonButton.addEventListener('click', function () {
    if (!cachedCookieHeader) return;
    const name = accountNameInput.value.trim() || '账号1';
    const config = [{
        name: name,
        cookie: cachedCookieHeader
    }];
    copyText(JSON.stringify(config, null, 2), '青龙账号 JSON 已复制。');
});

loadCookies();
