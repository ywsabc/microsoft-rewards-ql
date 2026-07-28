#!/usr/bin/env node
/**
 * Microsoft Rewards QingLong shared runtime.
 * Run the scheduled microsoft_rewards_task_*.js entry files.
 */
/*
 * Microsoft Rewards for QingLong
 *
 * Refactored from:
 *   微软积分商城签到（全能智能重构版） v3.0.2
 *   https://scriptcat.org/zh-CN/script-show-page/6241
 *   Author: liyan20001124-byte
 *
 * SPDX-License-Identifier: MIT
 * See LICENSE and upstream/MicrosoftRewardsAuto-3.0.2.user.js.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

const SCRIPT_NAME = '微软积分商城签到（青龙重构版）';
const CLIENT_ID = '0000000040170455';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const REWARDS_SCOPE = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const DEFAULT_STATE_DIR = path.join(__dirname, '.state');
const OAUTH_BALANCE_TOLERANCE = 0;

const UA = {
    pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    mobile: 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.132 Mobile Safari/537.36 EdgA/131.0.0.0',
    app: 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560'
};

const APP = {
    id: 'SAAndroid/32.6.2110003560',
    channel: 'SAAndroid',
    readOfferId: 'ENUS_readarticle3_30points'
};

const REWARDS = {
    // 上游 v3.0.2 与当前 Rewards 页面使用的 reportActivity Server Action。
    reportActivityAction: '70babbc81d2724f60d29a95c03b3d739cba77cea92',
    claimAllPointsAction: '00cf5ba7699f0e920ffcff223f9e48fea78fd49784'
};

const SEARCH_POOL = [
    '天气预报', '今日新闻热点', '美食食谱家常菜', '旅游攻略',
    '健康养生知识', '科技资讯', '电影推荐', '股票行情',
    '体育赛事', '历史上的今天', 'how do solar panels work',
    'how to learn programming', 'best coffee brewing methods',
    'easy healthy breakfast ideas', 'world history overview',
    'home gardening tips', 'how to sleep better naturally',
    'mechanical keyboard guide', 'beginner workout routine',
    'science facts about the ocean'
];

const HOT_SEARCH_PROVIDERS = [
    {
        name: 'hot.nntool.cc',
        baseUrl: 'https://hotapi.nntool.cc/',
        sources: ['weibo', 'douyin', 'baidu', 'toutiao', 'thepaper', 'qq-news', 'netease-news', 'zhihu']
    },
    {
        name: 'cnxiaobai.com',
        baseUrl: 'https://cnxiaobai.com/DailyHotApi/',
        sources: ['weibo', 'douyin', 'baidu', 'toutiao', 'thepaper', 'qq-news', 'netease-news', 'zhihu']
    }
];

const SKIP_PATTERNS = [
    'referral', 'refer and earn', 'sweepstake', 'entries', 'install the',
    'set bing as your default', 'bing wallpaper', 'punch card',
    'ancient coin', 'sea of thieves', 'rewards extension', 'redemption goal',
    'order history', 'claim your gift', 'shop to earn', 'set goal',
    'available tomorrow', 'offer is locked', 'earn -1 points'
];

function boolEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return !/^(0|false|no|off)$/i.test(raw);
}

function numberEnv(name, fallback, min, max) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomHex64() {
    return crypto.randomBytes(32).toString('hex').toUpperCase();
}

function shuffled(values) {
    const result = values.slice();
    for (let index = result.length - 1; index > 0; index--) {
        const swapIndex = randomInt(0, index);
        [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
}

function parseHotSearchResponse(text) {
    const payload = safeJson(text);
    if (!payload || Number(payload.code) !== 200 || !Array.isArray(payload.data)) {
        throw new Error('响应结构不符合预期');
    }
    const seen = new Set();
    const words = [];
    for (const item of payload.data) {
        const title = String(item && item.title || '')
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 64);
        if (title.length < 2 || /^https?:\/\//i.test(title) || seen.has(title)) continue;
        seen.add(title);
        words.push(title);
    }
    if (words.length < 5) throw new Error('有效热搜词少于 5 条');
    return words;
}

async function loadHotSearchWords(client, providers) {
    const providerList = providers ? providers.slice() : shuffled(HOT_SEARCH_PROVIDERS);
    const errors = [];
    for (const provider of providerList) {
        const sources = shuffled(provider.sources);
        const source = sources[0];
        const url = provider.baseUrl + source;
        try {
            const response = await client.request(url, {
                timeout: 12000,
                redirects: 2,
                headers: { accept: 'application/json' }
            });
            if (response.text.length > 1024 * 1024) throw new Error('响应超过 1 MiB');
            return {
                provider: provider.name,
                source: source,
                words: shuffled(parseHotSearchResponse(response.text))
            };
        } catch (error) {
            errors.push(provider.name + ': ' + error.message);
        }
    }
    throw new Error(errors.join('; ') || '没有可用热搜源');
}

function taskDateKey(lockCN) {
    const options = lockCN ? { timeZone: 'Asia/Shanghai' } : {};
    const parts = new Intl.DateTimeFormat('en-CA', Object.assign({
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }, options)).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(function (part) {
        return [part.type, part.value];
    }));
    return values.year + '-' + values.month + '-' + values.day;
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

function extractBingActivityContext(html) {
    const text = String(html || '');
    const ig = text.match(/\bIG:"([A-F0-9]+)"/i)
        || text.match(/\bIG:\\"([A-F0-9]+)\\"/i);
    const iid = text.match(/(?:window\.)?data_iid\s*=\s*["']([^"']+)["']/i)
        || text.match(/"IID":"([^"]+)"/i)
        || text.match(/\bIID:\\"([^"\\]+)\\"/i);
    if (!ig || !iid) throw new Error('搜索页缺少 IG/IID 活动上下文');
    return { ig: ig[1], iid: iid[1] };
}

function parseBingActivityResponse(html) {
    const text = String(html || '');
    const authenticated = text.match(/"IsAuthenticated":(true|false)/i);
    if (authenticated && authenticated[1].toLowerCase() !== 'true') {
        throw new Error('Bing 搜索会话未登录 Rewards');
    }
    const increment = text.match(/"RewardsIncrement":(-?\d+(?:\.\d+)?)/i);
    const balance = text.match(/"Balance":(-?\d+(?:\.\d+)?)/i);
    return {
        authenticated: !authenticated || authenticated[1].toLowerCase() === 'true',
        increment: increment ? Number(increment[1]) : null,
        balance: balance ? Number(balance[1]) : null
    };
}

function evaluateBingReward(activity, previousBalance) {
    const hasReportedIncrement = activity
        && activity.increment !== null
        && activity.increment !== undefined;
    const hasResponseBalance = activity
        && activity.balance !== null
        && activity.balance !== undefined;
    const reportedIncrement = hasReportedIncrement
        && Number.isFinite(Number(activity.increment))
        ? Number(activity.increment)
        : null;
    const responseBalance = hasResponseBalance
        && Number.isFinite(Number(activity.balance))
        ? Number(activity.balance)
        : null;
    const baseline = Number.isFinite(Number(previousBalance))
        ? Number(previousBalance)
        : null;
    const confirmedIncrement = responseBalance !== null && baseline !== null
        ? Math.max(0, responseBalance - baseline)
        : 0;
    return {
        reportedIncrement: reportedIncrement,
        responseBalance: responseBalance,
        confirmedIncrement: confirmedIncrement,
        nextBalance: responseBalance !== null && baseline !== null
            ? Math.max(baseline, responseBalance)
            : baseline
    };
}

function extractEmbeddedJson(text, key, maxLength) {
    const marker = '"' + key + '":';
    let start = String(text || '').indexOf(marker);
    if (start < 0) return null;
    start += marker.length;
    while (/\s/.test(text[start] || '')) start++;
    const opener = text[start];
    const closer = opener === '{' ? '}' : opener === '[' ? ']' : '';
    if (!closer) return null;
    const limit = Math.min(text.length, start + (maxLength || 200000));
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < limit; index++) {
        const char = text[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') {
            quoted = true;
            continue;
        }
        if (char === opener) depth++;
        if (char === closer) {
            depth--;
            if (depth === 0) return safeJson(text.slice(start, index + 1));
        }
    }
    return null;
}

function parseEarnDashboard(html) {
    const clean = String(html || '').replace(/\\"/g, '"');
    const points = extractEmbeddedJson(clean, 'pointsCounters', 5000);
    const cards = extractEmbeddedJson(clean, 'activityCards', 200000);
    const balanceMatch = clean.match(/"balance":(\d+)/)
        || clean.match(/"availablePoints":(\d+)/);
    if (!points && !balanceMatch) throw new Error('earn 页面未包含积分数据');
    const pc = points && points.pc || {};
    const balance = balanceMatch
        ? Number(balanceMatch[1])
        : Number(points && points.totalPoints || 0);
    const promotions = Array.isArray(cards) ? cards : [];
    return {
        source: 'earn',
        pointsCounters: points || {},
        streakProgress: parseEarnStreakProgress(clean),
        activityCards: promotions,
        morePromotions: promotions,
        userStatus: {
            availablePoints: balance,
            counters: {
                pcSearch: [{
                    pointProgress: Number(pc.progress || 0),
                    pointProgressMax: Number(pc.max || 0)
                }]
            }
        }
    };
}

function extractNextFlightJson(html, key, maxLength) {
    const source = String(html || '');
    const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/g;
    let match;
    while ((match = scriptPattern.exec(source)) !== null) {
        const call = match[1].trim();
        if (!call.startsWith('self.__next_f.push(')) continue;
        const start = call.indexOf('(');
        const end = call.lastIndexOf(')');
        if (start < 0 || end <= start) continue;
        const frame = safeJson(call.slice(start + 1, end));
        if (!Array.isArray(frame) || typeof frame[1] !== 'string') continue;
        const value = extractEmbeddedJson(frame[1], key, maxLength);
        if (value !== null) return value;
    }
    return null;
}

function normalizeDashboardDate(value) {
    const text = String(value || '').trim();
    let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
        return match[3] + '-'
            + match[1].padStart(2, '0') + '-'
            + match[2].padStart(2, '0');
    }
    match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
        return match[1] + '-'
            + match[2].padStart(2, '0') + '-'
            + match[3].padStart(2, '0');
    }
    return '';
}

function rewardsDateKey(lockCN, now) {
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    };
    if (lockCN) options.timeZone = 'Asia/Shanghai';
    const parts = new Intl.DateTimeFormat('en-US', options)
        .formatToParts(now || new Date());
    const values = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }
    return values.year + '-' + values.month + '-' + values.day;
}

function parseDashboardDailySet(html, dateKey) {
    const items = extractNextFlightJson(
        html,
        'dailySetItems',
        200000
    );
    if (!Array.isArray(items)) {
        throw new Error('dashboard 页面未包含每日活动数据');
    }
    const targetDate = normalizeDashboardDate(dateKey)
        || normalizeDashboardDate(items[0] && items[0].date);
    const seen = new Set();
    const todayItems = items.filter(function (item) {
        return (
            item
            && normalizeDashboardDate(item.date) === targetDate
        );
    }).filter(function (item) {
        const key = String(item.offerId || '') + ':'
            + String(item.hash || '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return {
        source: 'dashboard',
        date: targetDate,
        dailySetItems: todayItems
    };
}

function parseEarnStreakProgress(html) {
    const clean = String(html || '').replace(/\\"/g, '"');
    const progresses = [];
    const seen = new Set();
    const pattern =
        /"partner":"([^"]+)","complete":(\d+),"total":(\d+)/g;
    let match;
    while ((match = pattern.exec(clean)) !== null) {
        const partner = match[1];
        if (seen.has(partner)) continue;
        seen.add(partner);
        progresses.push({
            partner: partner,
            complete: Number(match[2]),
            total: Number(match[3])
        });
    }
    return progresses;
}

function parsePointClaim(html) {
    const clean = String(html || '').replace(/\\"/g, '"');
    const pointClaim = extractEmbeddedJson(clean, 'pointClaim', 100000);
    if (!pointClaim || typeof pointClaim !== 'object') {
        return { points: 0, entries: [] };
    }
    return {
        points: Math.max(0, Number(pointClaim.points || 0)),
        entries: Array.isArray(pointClaim.entries) ? pointClaim.entries : []
    };
}

function sanitizeName(value) {
    return String(value || 'account').replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]/g, '_').slice(0, 60);
}

function parseCookieHeader(header) {
    const values = new Map();
    for (const part of String(header || '').split(/;\s*/)) {
        const pos = part.indexOf('=');
        if (pos <= 0) continue;
        values.set(
            part.slice(0, pos).trim(),
            part.slice(pos + 1).trim()
        );
    }
    return values;
}

function stableCookieText(values) {
    return Array.from(values.entries()).sort(function (left, right) {
        return left[0].localeCompare(right[0]);
    }).map(function (entry) {
        return entry[0] + '=' + entry[1];
    }).join(';');
}

function accountCookieIdentity(cookie, searchCookie) {
    const rewards = parseCookieHeader(cookie);
    const search = parseCookieHeader(searchCookie || cookie);
    const rewardsU = rewards.get('_U') || '';
    const searchU = search.get('_U') || '';
    const auth = rewards.get('.MSA.Auth')
        || rewards.get('_C_Auth')
        || '';
    const stableValues = [rewardsU, auth, searchU];
    const hasStableIdentity = stableValues.some(Boolean);
    const material = hasStableIdentity
        ? stableValues.join('\n')
        : stableCookieText(rewards) + '\n' + stableCookieText(search);
    return {
        rewardsU: rewardsU,
        searchU: searchU,
        fingerprint: crypto.createHash('sha256').update(material).digest('hex')
    };
}

function validateAccounts(accounts) {
    const names = new Map();
    const cookies = new Map();
    const oauthUsers = new Map();
    for (const account of accounts) {
        const nameKey = String(account.name || '').trim().toLocaleLowerCase();
        if (names.has(nameKey)) {
            throw new Error(
                '账号备注重复：“' + names.get(nameKey)
                    + '”与“' + account.name + '”'
            );
        }
        names.set(nameKey, account.name);

        const identity = accountCookieIdentity(
            account.cookie,
            account.searchCookie
        );
        if (
            identity.rewardsU
            && identity.searchU
            && identity.rewardsU !== identity.searchU
        ) {
            throw new Error(
                '账号“' + account.name
                    + '”的 Rewards Cookie 与搜索 Cookie 不属于同一会话'
            );
        }
        if (
            account.cookieFingerprint
            && account.cookieFingerprint !== identity.fingerprint
        ) {
            throw new Error(
                '账号“' + account.name + '”的 Cookie 指纹校验失败'
            );
        }
        account.cookieFingerprint = identity.fingerprint;
        if (cookies.has(identity.fingerprint)) {
            throw new Error(
                '账号“' + cookies.get(identity.fingerprint)
                    + '”与“' + account.name + '”使用了相同 Cookie'
            );
        }
        cookies.set(identity.fingerprint, account.name);

        const ruid = String(account.oauthRuid || '');
        if (ruid && oauthUsers.has(ruid)) {
            throw new Error(
                '账号“' + oauthUsers.get(ruid) + '”与“'
                    + account.name + '”绑定了同一个 OAuth 身份'
            );
        }
        if (ruid) oauthUsers.set(ruid, account.name);
    }
    return accounts;
}

class CookieJar {
    constructor(initialCookie) {
        this.cookies = [];
        if (initialCookie) this.addCookieHeader(initialCookie, '.bing.com');
    }

    addCookieHeader(header, domain) {
        const parts = String(header).split(/;\s*/);
        for (const part of parts) {
            const pos = part.indexOf('=');
            if (pos <= 0) continue;
            this.upsert({
                name: part.slice(0, pos).trim(),
                value: part.slice(pos + 1).trim(),
                domain: domain,
                path: '/',
                secure: true,
                expires: 0
            });
        }
    }

    upsert(cookie) {
        this.cookies = this.cookies.filter(function (item) {
            return !(item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path);
        });
        if (!cookie.expires || cookie.expires > Date.now()) this.cookies.push(cookie);
    }

    setFromResponse(lines, requestUrl) {
        if (!lines) return;
        const list = Array.isArray(lines) ? lines : [lines];
        const source = new URL(requestUrl);
        for (const line of list) {
            const attrs = String(line).split(/;\s*/);
            const pair = attrs.shift();
            const pos = pair.indexOf('=');
            if (pos <= 0) continue;
            const cookie = {
                name: pair.slice(0, pos),
                value: pair.slice(pos + 1),
                domain: source.hostname,
                path: '/',
                secure: false,
                expires: 0
            };
            for (const attr of attrs) {
                const split = attr.indexOf('=');
                const key = (split < 0 ? attr : attr.slice(0, split)).trim().toLowerCase();
                const value = split < 0 ? '' : attr.slice(split + 1).trim();
                if (key === 'domain') cookie.domain = value.toLowerCase();
                if (key === 'path') cookie.path = value || '/';
                if (key === 'secure') cookie.secure = true;
                if (key === 'max-age') cookie.expires = Date.now() + Number(value) * 1000;
                if (key === 'expires' && !cookie.expires) cookie.expires = Date.parse(value) || 0;
            }
            this.upsert(cookie);
        }
    }

    getHeader(targetUrl, extraCookie) {
        const target = new URL(targetUrl);
        const now = Date.now();
        this.cookies = this.cookies.filter(function (cookie) {
            return !cookie.expires || cookie.expires > now;
        });
        const pairs = new Map();
        for (const cookie of this.cookies) {
            const domain = cookie.domain.replace(/^\./, '');
            const domainOK = target.hostname === domain || target.hostname.endsWith('.' + domain);
            const pathOK = target.pathname.startsWith(cookie.path || '/');
            const secureOK = !cookie.secure || target.protocol === 'https:';
            if (domainOK && pathOK && secureOK) pairs.set(cookie.name, cookie.value);
        }
        if (extraCookie) {
            for (const part of String(extraCookie).split(/;\s*/)) {
                const pos = part.indexOf('=');
                if (pos > 0) pairs.set(part.slice(0, pos).trim(), part.slice(pos + 1).trim());
            }
        }
        return Array.from(pairs.entries()).map(function (entry) {
            return entry[0] + '=' + entry[1];
        }).join('; ');
    }
}

class HttpClient {
    constructor(jar) {
        this.jar = jar;
    }

    request(url, options) {
        const self = this;
        const opts = Object.assign({
            method: 'GET',
            headers: {},
            body: '',
            timeout: 20000,
            redirects: 5
        }, options || {});

        return new Promise(function (resolve, reject) {
            const target = new URL(url);
            const transport = target.protocol === 'http:' ? http : https;
            const headers = Object.assign({
                accept: '*/*',
                'accept-encoding': 'gzip, deflate, br',
                'user-agent': UA.pc
            }, opts.headers || {});
            const explicitCookie = headers.cookie || headers.Cookie || '';
            delete headers.Cookie;
            const jarCookie = self.jar ? self.jar.getHeader(url, explicitCookie) : explicitCookie;
            if (jarCookie) headers.cookie = jarCookie;
            if (opts.body && !headers['content-length']) {
                headers['content-length'] = Buffer.byteLength(opts.body);
            }

            const req = transport.request(target, {
                method: opts.method,
                headers: headers
            }, function (res) {
                if (self.jar) self.jar.setFromResponse(res.headers['set-cookie'], url);
                const chunks = [];
                res.on('data', function (chunk) { chunks.push(chunk); });
                res.on('end', function () {
                    let buffer = Buffer.concat(chunks);
                    try {
                        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
                        if (encoding === 'gzip') buffer = zlib.gunzipSync(buffer);
                        if (encoding === 'deflate') buffer = zlib.inflateSync(buffer);
                        if (encoding === 'br') buffer = zlib.brotliDecompressSync(buffer);
                    } catch (error) {
                        return reject(new Error('响应解压失败: ' + error.message));
                    }
                    const text = buffer.toString('utf8');
                    const status = res.statusCode || 0;
                    const location = res.headers.location;
                    if (location && [301, 302, 303, 307, 308].includes(status) && opts.redirects > 0) {
                        const nextUrl = new URL(location, url).toString();
                        const nextOptions = Object.assign({}, opts, { redirects: opts.redirects - 1 });
                        if (status === 303 || ((status === 301 || status === 302) && opts.method === 'POST')) {
                            nextOptions.method = 'GET';
                            nextOptions.body = '';
                            nextOptions.headers = Object.assign({}, opts.headers);
                            delete nextOptions.headers['content-length'];
                        }
                        return resolve(self.request(nextUrl, nextOptions));
                    }
                    const result = { status: status, headers: res.headers, text: text, url: url };
                    if (status < 200 || status >= 300) {
                        const error = new Error('HTTP ' + status + ' ' + target.hostname + target.pathname);
                        error.status = status;
                        error.response = result;
                        return reject(error);
                    }
                    resolve(result);
                });
            });
            req.setTimeout(opts.timeout, function () {
                req.destroy(new Error('请求超时: ' + target.hostname));
            });
            req.on('error', reject);
            if (opts.body) req.write(opts.body);
            req.end();
        });
    }
}

class StateStore {
    constructor(account, stateDir) {
        this.dir = stateDir || DEFAULT_STATE_DIR;
        this.binding = {
            cookieFingerprint: String(
                account.cookieFingerprint
                || accountCookieIdentity(
                    account.cookie,
                    account.searchCookie
                ).fingerprint
            ),
            oauthRuid: String(account.oauthRuid || '')
        };
        const identity = this.binding.oauthRuid
            ? 'oauth:' + this.binding.oauthRuid
            : 'cookie:' + this.binding.cookieFingerprint;
        const suffix = crypto.createHash('sha256')
            .update(identity)
            .digest('hex')
            .slice(0, 16);
        this.file = path.join(
            this.dir,
            sanitizeName(account.name) + '-' + suffix + '.json'
        );
        this.data = {};
        try {
            const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const stored = loaded.accountBinding || {};
            const oauthMatches = Boolean(
                this.binding.oauthRuid
                && stored.oauthRuid
                && this.binding.oauthRuid === stored.oauthRuid
            );
            const cookieMatches = Boolean(
                this.binding.cookieFingerprint
                && stored.cookieFingerprint
                && this.binding.cookieFingerprint
                    === stored.cookieFingerprint
            );
            this.data = oauthMatches || cookieMatches ? loaded : {};
        } catch (_) {
            this.data = {};
        }
    }

    save() {
        this.data.accountBinding = Object.assign({}, this.binding);
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const temp = this.file + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        fs.renameSync(temp, this.file);
        try { fs.chmodSync(this.file, 0o600); } catch (_) {}
    }
}

class RewardsRunner {
    constructor(account, config) {
        this.account = account;
        this.config = config;
        this.name = account.name || '账号';
        this.jar = new CookieJar(account.cookie);
        this.http = new HttpClient(this.jar);
        // 导出的 Cookie Header 不包含原始 Domain/Path 元数据。搜索域返回的
        // Set-Cookie 不能写回 Rewards 会话，否则会覆盖同名的 Rewards Cookie。
        this.searchHttp = new HttpClient(new CookieJar(
            account.searchCookie || account.cookie
        ));
        this.regionHttp = new HttpClient(null);
        this.stateStore = new StateStore(account, config.stateDir);
        this.state = this.stateStore.data;
        this.accessToken = '';
        this.refreshToken = this.state.refreshToken || account.refreshToken || '';
        this.expectedOauthRuid = String(
            account.oauthRuid || this.state.oauthRuid || ''
        );
        if (this.expectedOauthRuid) {
            this.stateStore.binding.oauthRuid = this.expectedOauthRuid;
        }
        this.appAccountInfo = null;
        this.preflightRewardsInfo = null;
        this.lastRewardsInfo = null;
        this.oauthPreflightDone = false;
        this.oauthBindingError = '';
        this.oauthRefreshError = '';
        this.region = 'CN';
        // Bing 当前的 Rewards 搜索上报由实际 SERP 页面生成 IG/IID。
        // 使用 www.bing.com 并通过 mkt 锁定中文市场，与上游浏览器脚本一致。
        this.host = 'www.bing.com';
        this.searchSessionSynced = false;
        this.submittedPromoCards = new Map();
        this.confirmedPromoIds = new Set();
        this.lastActivitySnapshot = null;
        this.promoSubmissionFailures = 0;
        this.promoDeferred = 0;
        this.promoCooldownSkipped = 0;
        this.promoAttempts = this.state.promoAttempts
            && typeof this.state.promoAttempts === 'object'
            ? this.state.promoAttempts
            : {};
        this.logs = [];
        this.result = {
            name: this.name,
            startBalance: 0,
            endBalance: 0,
            claim: '未执行',
            sign: '未执行',
            read: '未执行',
            promos: '未执行',
            search: '未执行',
            mobileSearch: '未执行',
            streak: '未执行',
            failures: []
        };
    }

    log(icon, message) {
        const line = '[' + this.name + '] ' + icon + ' ' + message;
        this.logs.push(line);
        console.log(line);
    }

    async delay(min, max) {
        const value = randomInt(min, max) * this.config.delayScale;
        if (value > 0) await sleep(value);
    }

    recordFailure(task, message) {
        const text = task + '：' + message;
        if (!this.result.failures.includes(text)) {
            this.result.failures.push(text);
        }
    }

    hasRecentPromoAttempt(offerId) {
        const attempt = this.promoAttempts[String(offerId || '')];
        if (!attempt || !Number(attempt.time)) return false;
        const cooldown = Number(this.config.promoRetryHours || 12)
            * 60 * 60 * 1000;
        return Date.now() - Number(attempt.time) < cooldown;
    }

    markPromoAttempt(card) {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const offerId of Object.keys(this.promoAttempts)) {
            if (Number(this.promoAttempts[offerId].time || 0) < cutoff) {
                delete this.promoAttempts[offerId];
            }
        }
        this.promoAttempts[card.offerId] = {
            time: Date.now(),
            title: String(card.title || '').slice(0, 100)
        };
        this.state.promoAttempts = this.promoAttempts;
        this.stateStore.save();
    }

    async jsonRequest(url, options) {
        const response = await this.http.request(url, options);
        const data = safeJson(response.text);
        if (!data) throw new Error('接口未返回 JSON: ' + new URL(url).hostname);
        return data;
    }

    syncRewardsSessionToSearch() {
        if (this.searchSessionSynced) return;
        for (const cookie of this.http.jar.cookies) {
            if (cookie.domain.replace(/^\./, '') === 'rewards.bing.com') {
                this.searchHttp.jar.upsert(Object.assign({}, cookie));
            }
        }
        this.searchSessionSynced = true;
    }

    async refreshOAuth(options) {
        const refreshOptions = options || {};
        this.oauthRefreshError = '';
        const storedToken = this.state.refreshToken || '';
        const configuredToken = this.account.refreshToken || '';
        const candidates = [];
        if (storedToken) {
            candidates.push({ type: 'refresh_token', value: storedToken });
        }
        if (configuredToken && configuredToken !== storedToken) {
            candidates.push({ type: 'refresh_token', value: configuredToken });
        }
        if (this.account.authCode) candidates.push({ type: 'authorization_code', value: this.account.authCode });

        if (candidates.length === 0) {
            this.log('🟡', '未配置 refreshToken/authCode，跳过 App 签到与阅读');
            return false;
        }
        let lastError = null;
        for (const candidate of candidates) {
            const params = new URLSearchParams();
            params.set('client_id', CLIENT_ID);
            params.set('redirect_uri', REDIRECT_URI);
            if (candidate.type === 'refresh_token') {
                params.set('refresh_token', candidate.value);
                params.set('scope', REWARDS_SCOPE);
                params.set('grant_type', 'refresh_token');
            } else {
                let code = String(candidate.value || '').trim();
                if (code.includes('code=')) {
                    try { code = new URL(code).searchParams.get('code') || ''; } catch (_) {}
                }
                params.set('code', code);
                params.set('grant_type', 'authorization_code');
            }

            try {
                const data = await this.jsonRequest(TOKEN_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: params.toString()
                });
                if (!data.access_token) {
                    throw new Error(data.error_description || data.error || '响应缺少 access_token');
                }
                this.accessToken = data.access_token;
                const appAccountInfo = await this.getAppAccountInfo();
                if (!appAccountInfo || !appAccountInfo.ruid) {
                    throw new Error('DAPI 未返回 OAuth 账号标识');
                }
                if (
                    this.expectedOauthRuid
                    && appAccountInfo.ruid !== this.expectedOauthRuid
                ) {
                    throw new Error('OAuth Token 与扩展记录的账号标识不一致');
                }
                if (!this.expectedOauthRuid) {
                    const cookieBalance = this.preflightRewardsInfo
                        && Number(this.preflightRewardsInfo.balance);
                    const appBalance = Number(appAccountInfo.balance);
                    if (
                        !Number.isFinite(cookieBalance)
                        || !Number.isFinite(appBalance)
                        || Math.abs(cookieBalance - appBalance)
                            > OAUTH_BALANCE_TOLERANCE
                    ) {
                        throw new Error(
                            '缺少 oauthRuid，且无法通过 Cookie/App '
                                + '余额一致性建立账号绑定'
                        );
                    }
                    this.expectedOauthRuid = appAccountInfo.ruid;
                    this.stateStore.binding.oauthRuid =
                        this.expectedOauthRuid;
                    this.log(
                        '🟡',
                        '旧配置缺少 oauthRuid，已通过 Cookie/App '
                            + '余额一致性建立本机绑定；建议用扩展重新同步'
                    );
                }
                if (
                    this.preflightRewardsInfo
                    && Number.isFinite(Number(appAccountInfo.balance))
                    && Math.abs(
                        Number(appAccountInfo.balance)
                            - Number(this.preflightRewardsInfo.balance)
                    ) > OAUTH_BALANCE_TOLERANCE
                ) {
                    throw new Error(
                        'OAuth Token 的 App 余额与 Rewards Cookie 不一致'
                    );
                }
                this.appAccountInfo = appAccountInfo;
                this.oauthRefreshError = '';
                if (data.refresh_token) {
                    this.refreshToken = data.refresh_token;
                    if (!refreshOptions.deferSave) {
                        this.saveRefreshToken();
                    }
                }
                this.log('🟢', 'OAuth Token 获取成功');
                return true;
            } catch (error) {
                this.accessToken = '';
                this.appAccountInfo = null;
                lastError = error;
            }
        }
        this.oauthRefreshError = lastError ? lastError.message : '未知错误';
        this.log('🔴', 'OAuth Token 获取失败: ' + this.oauthRefreshError);
        return false;
    }

    saveRefreshToken() {
        if (!this.refreshToken || !this.appAccountInfo) return;
        if (
            !this.expectedOauthRuid
            || this.appAccountInfo.ruid !== this.expectedOauthRuid
        ) {
            this.oauthBindingError =
                'OAuth 身份未与当前账号的 oauthRuid 完成强绑定';
            return;
        }
        this.state.refreshToken = this.refreshToken;
        this.state.oauthRuid = this.appAccountInfo.ruid;
        this.state.tokenUpdatedAt = Date.now();
        this.stateStore.save();
    }

    dapiHeaders() {
        return {
            'content-type': 'application/json; charset=UTF-8',
            'user-agent': UA.app,
            authorization: 'Bearer ' + this.accessToken,
            'x-rewards-appid': APP.id,
            'x-rewards-ismobile': 'true',
            'x-rewards-country': this.config.lockCN ? 'cn' : this.region.toLowerCase(),
            'x-rewards-language': 'zh'
        };
    }

    async getAppAccountInfo() {
        if (!this.accessToken) return null;
        const data = await this.jsonRequest(
            'https://prod.rewardsplatform.microsoft.com/dapi/me'
                + '?channel=SAAndroid&options=105',
            { headers: this.dapiHeaders() }
        );
        const response = data.response || {};
        const profile = response.profile || {};
        const balance = Number(response.balance);
        return {
            ruid: String(profile.ruid || ''),
            balance: Number.isFinite(balance) ? balance : null
        };
    }

    async getUserInfoDashboard() {
        const url = 'https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=' + Date.now();
        const response = await this.http.request(url, {
            headers: {
                'user-agent': UA.pc,
                referer: 'https://rewards.bing.com/',
                'x-requested-with': 'XMLHttpRequest'
            }
        });
        const data = safeJson(response.text);
        if (!data) throw new Error('Cookie 无效或 getuserinfo 返回了登录页面');
        const dashboard = data.dashboard || data;
        if (!dashboard.source) dashboard.source = 'getuserinfo';
        return dashboard;
    }

    async getEarnDashboard() {
        const response = await this.http.request('https://rewards.bing.com/earn', {
            headers: {
                'user-agent': UA.pc,
                referer: 'https://rewards.bing.com/'
            }
        });
        return parseEarnDashboard(response.text);
    }

    async getDailySetDashboard() {
        const response = await this.http.request(
            'https://rewards.bing.com/dashboard',
            {
                headers: {
                    'user-agent': UA.pc,
                    referer: 'https://rewards.bing.com/'
                }
            }
        );
        return parseDashboardDailySet(
            response.text,
            rewardsDateKey(this.config.lockCN)
        );
    }

    async getDashboard() {
        let earnError = null;
        try {
            const dashboard = await this.getEarnDashboard();
            if (!this.dashboardSourceLogged) {
                this.log('🟢', '账户状态读取成功（earn 页面）');
                this.dashboardSourceLogged = true;
            }
            return dashboard;
        } catch (error) {
            earnError = error;
        }
        try {
            const dashboard = await this.getUserInfoDashboard();
            if (!this.dashboardSourceLogged) {
                this.log('🟡', 'earn 页面解析失败，已使用 getuserinfo 兜底');
                this.dashboardSourceLogged = true;
            }
            return dashboard;
        } catch (error) {
            throw new Error(
                '账户状态读取失败：earn=' + earnError.message + '；getuserinfo=' + error.message
            );
        }
    }

    sumCounter(items) {
        if (!Array.isArray(items)) return { progress: 0, max: 0 };
        return items.reduce(function (sum, item) {
            sum.progress += Number(item.pointProgress || 0);
            sum.max += Number(item.pointProgressMax || item.pointMax || 0);
            return sum;
        }, { progress: 0, max: 0 });
    }

    async getRewardsInfo() {
        const dashboard = await this.getDashboard();
        const userStatus = dashboard.userStatus || {};
        const counters = userStatus.counters || {};
        const pc = this.sumCounter(counters.pcSearch);
        const balance = Number(
            userStatus.availablePoints ||
            dashboard.availablePoints ||
            dashboard.balance ||
            0
        );
        const info = { dashboard: dashboard, pc: pc, balance: balance };
        this.lastRewardsInfo = info;
        return info;
    }

    async checkRegion() {
        if (!this.config.lockCN) return true;
        try {
            const response = await this.regionHttp.request('https://' + this.host + '/', {
                headers: { 'user-agent': UA.pc }
            });
            const match = response.text.replace(/\s/g, '').match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
            if (!match) {
                this.log('🟡', '未能解析出口地区，继续运行；请自行确认是大陆 IP');
                return true;
            }
            this.region = String(match[3]).toUpperCase();
            if (this.region !== 'CN') {
                this.log('🔴', '出口地区为 ' + this.region + '，已按锁定国区配置停止');
                return false;
            }
            this.log('🟢', '地区检测通过: CN');
            return true;
        } catch (error) {
            this.log('🟡', '地区检测失败，继续运行: ' + error.message);
            return true;
        }
    }

    async getVerificationToken(pageUrl) {
        const url = pageUrl || 'https://rewards.bing.com/';
        const response = await this.http.request(url, {
            headers: { 'user-agent': UA.pc, referer: 'https://rewards.bing.com/' }
        });
        const match = response.text.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
            || response.text.match(/RequestVerificationToken.*?value=["']([^"']+)["']/i)
            || response.text.match(/"verificationToken"\s*:\s*"([^"]+)"/i)
            || response.text.match(/"__RequestVerificationToken"\s*:\s*"([^"]+)"/i);
        return match ? match[1].replace(/&amp;/g, '&') : '';
    }

    async reportActivity(offerId, hash, referer) {
        const source = referer || 'https://rewards.bing.com/';
        const token = await this.getVerificationToken('https://rewards.bing.com/');
        if (!token) {
            const error = new Error('当前 Rewards 页面未提供旧版防伪令牌');
            error.code = 'LEGACY_REWARDS_UNAVAILABLE';
            throw error;
        }
        const params = new URLSearchParams({
            id: offerId,
            hash: hash || '1',
            activityAmount: '1',
            timeZone: '480',
            dbs: '0',
            form: '',
            type: ''
        });
        params.set('__RequestVerificationToken', token);
        const headers = {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'user-agent': UA.pc,
            referer: source,
            origin: 'https://rewards.bing.com',
            'x-requested-with': 'XMLHttpRequest'
        };
        headers.RequestVerificationToken = token;
        return this.http.request(
            'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
            { method: 'POST', headers: headers, body: params.toString() }
        );
    }

    async signApp() {
        if (!this.accessToken) return null;
        const body = {
            amount: 1,
            id: randomHex64(),
            type: 103,
            country: this.config.lockCN ? 'cn' : this.region.toLowerCase(),
            channel: APP.channel
        };
        const data = await this.jsonRequest('https://prod.rewardsplatform.microsoft.com/dapi/me/activities', {
            method: 'POST',
            headers: Object.assign(this.dapiHeaders(), {
                'x-rewards-partnerid': 'startapp',
                'x-rewards-flights': 'rwgobig'
            }),
            body: JSON.stringify(body)
        });
        const response = data.response || {};
        const balance = Number(response.balance);
        if (response.activity) {
            return {
                reportedPoints: Number(
                    response.activity.p || response.activity.points || 0
                ),
                balance: Number.isFinite(balance) ? balance : null,
                duplicate: false,
                accepted: true
            };
        }
        if (response.isDuplicate || response.activity === null) {
            return {
                reportedPoints: 0,
                balance: Number.isFinite(balance) ? balance : null,
                duplicate: true,
                accepted: true
            };
        }
        return null;
    }

    async signPC() {
        const response = await this.reportActivity('Gamification_DailyCheckIn', '1');
        const data = safeJson(response.text);
        if (!data) throw new Error('PC 签到响应不是 JSON');
        if (data.error) throw new Error(data.error.message || data.error || 'PC 签到接口报错');
        const apiResponse = data.response || {};
        const activity = apiResponse.activity || {};
        if (typeof data.points === 'number') return Number(data.points);
        if (apiResponse.activity) return Number(activity.p || activity.points || 0);
        if (apiResponse.isDuplicate || apiResponse.activity === null) return 0;
        throw new Error('PC 签到响应未确认');
    }

    async runSign() {
        if (!this.config.tasks.has('sign')) return;
        if (this.config.dryRun) {
            this.result.sign = 'dry-run';
            return;
        }
        let total = 0;
        let success = false;
        let appUnconfirmed = 0;
        let appFailure = '';
        const streakProgress = this.lastRewardsInfo
            && this.lastRewardsInfo.dashboard
            && this.lastRewardsInfo.dashboard.streakProgress;
        const appStreak = Array.isArray(streakProgress)
            ? streakProgress.find(function (progress) {
                return progress.partner === 'bingapp';
            })
            : null;
        if (
            appStreak
            && appStreak.total > 0
            && appStreak.complete >= appStreak.total
        ) {
            success = true;
            this.log(
                '📱',
                '页面已确认 App 签到 '
                    + appStreak.complete + '/' + appStreak.total
                    + '，跳过重复请求'
            );
        } else {
            try {
                const appBalanceBefore = this.appAccountInfo
                    && this.appAccountInfo.balance;
                const appResult = await this.signApp();
                if (appResult !== null) {
                    const appInfoAfter = await this.getAppAccountInfo();
                    this.appAccountInfo = appInfoAfter || this.appAccountInfo;
                    const balances = [
                        appResult.balance,
                        appInfoAfter && appInfoAfter.balance
                    ].filter(function (value) {
                        return Number.isFinite(Number(value));
                    }).map(Number);
                    const confirmed = Number.isFinite(Number(appBalanceBefore))
                        ? Math.max(0, ...balances.map(function (value) {
                            return value - Number(appBalanceBefore);
                        }))
                        : 0;
                    if (confirmed > 0) {
                        success = true;
                        total += confirmed;
                        this.log('📱', 'App 签到余额确认 +' + confirmed);
                    } else if (appResult.duplicate) {
                        success = true;
                        this.log('📱', 'App 签到今日已完成，无新增积分');
                    } else if (appResult.reportedPoints > 0) {
                        appUnconfirmed = appResult.reportedPoints;
                        this.log(
                            '🟡',
                            'App 签到接口返回 +' + appResult.reportedPoints
                                + '，但 App 余额未变化，暂不确认入账'
                        );
                    } else if (appResult.accepted) {
                        success = true;
                        this.log('📱', 'App 签到请求已接受，今日无新增积分');
                    }
                }
            } catch (error) {
                appFailure = error.message;
                this.log('🟡', 'App 签到失败: ' + error.message);
            }
        }
        await this.delay(3000, 8000);
        try {
            const pcPoints = await this.signPC();
            success = true;
            total += pcPoints;
            this.log('💻', 'PC 签到确认 +' + pcPoints);
        } catch (error) {
            if (error.code === 'LEGACY_REWARDS_UNAVAILABLE') {
                this.log('🟡', '当前 Rewards 已停用旧版 PC 签到接口，跳过该分支');
            } else {
                this.log('🟡', 'PC 签到失败: ' + error.message);
            }
        }
        if (success) {
            this.result.sign = total > 0
                ? '完成 +' + total
                : '完成 +0（今日无新增积分）';
            if (appUnconfirmed > 0) {
                this.result.sign += '（App 未确认 +' + appUnconfirmed + '）';
                this.recordFailure(
                    '签到',
                    'App 积分未确认 +' + appUnconfirmed
                );
            }
            if (appFailure && this.accessToken) {
                this.result.sign += '（App 分支失败）';
                this.recordFailure('签到', 'App 分支失败：' + appFailure);
            }
            if (this.oauthBindingError) {
                this.result.sign += '（App 因 OAuth 账号不匹配跳过）';
                this.recordFailure('签到', 'OAuth 账号不匹配');
            }
        } else if (appUnconfirmed > 0) {
            this.result.sign = '未确认（App 接口 +' + appUnconfirmed + '）';
        } else if (this.oauthBindingError) {
            this.result.sign = '跳过（OAuth 账号不匹配）';
        } else {
            this.result.sign = '失败';
        }
        if (!success) {
            this.recordFailure('签到', this.result.sign);
        }
    }

    async getReadProgress() {
        if (!this.accessToken) return null;
        const data = await this.jsonRequest(
            'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
            { headers: this.dapiHeaders() }
        );
        const response = data.response || {};
        const promos = response.promotions || [];
        const task = promos.find(function (item) {
            return item.attributes && item.attributes.offerid === APP.readOfferId;
        });
        if (!task || !task.attributes) return null;
        return {
            progress: Number(task.attributes.progress || 0),
            max: Number(task.attributes.max || 30)
        };
    }

    async readOnce() {
        const body = {
            amount: 1,
            country: this.config.lockCN ? 'cn' : this.region.toLowerCase(),
            id: randomHex64(),
            type: 101,
            attributes: { offerid: APP.readOfferId }
        };
        const data = await this.jsonRequest('https://prod.rewardsplatform.microsoft.com/dapi/me/activities', {
            method: 'POST',
            headers: this.dapiHeaders(),
            body: JSON.stringify(body)
        });
        const response = data.response || {};
        const activity = response.activity || {};
        const balance = Number(response.balance);
        return {
            reportedPoints: Number(activity.p || 0),
            balance: Number.isFinite(balance) ? balance : null,
            duplicate: Boolean(response.isDuplicate)
        };
    }

    async runRead() {
        if (!this.config.tasks.has('read')) return;
        if (this.config.dryRun) {
            this.result.read = 'dry-run（未刷新 OAuth）';
            return;
        }
        if (!this.accessToken) {
            this.result.read = this.oauthBindingError
                ? '跳过（OAuth 账号不匹配）'
                : '跳过（无 Token）';
            this.recordFailure('阅读', this.result.read);
            return;
        }
        try {
            const appBalanceBefore = this.appAccountInfo
                && this.appAccountInfo.balance;
            let progress = await this.getReadProgress();
            if (!progress) throw new Error('未找到阅读任务');
            this.log('📖', '阅读进度 ' + progress.progress + '/' + progress.max);
            const remaining = Math.min(10, Math.max(0, progress.max - progress.progress));
            let reportedPoints = 0;
            for (let i = 0; i < remaining; i++) {
                const result = await this.readOnce();
                reportedPoints += result.reportedPoints;
                this.log(
                    '📖',
                    '阅读 ' + (i + 1) + '/' + remaining
                        + '，接口值 +' + result.reportedPoints
                );
                await this.delay(3000, 8000);
            }
            progress = await this.getReadProgress();
            this.result.read = progress ? progress.progress + '/' + progress.max : '已执行，验证失败';
            if (!progress || (progress.max > 0 && progress.progress < progress.max)) {
                this.recordFailure('阅读', this.result.read);
            }
            const appInfoAfter = await this.getAppAccountInfo();
            this.appAccountInfo = appInfoAfter || this.appAccountInfo;
            const confirmed = (
                Number.isFinite(Number(appBalanceBefore))
                && appInfoAfter
                && Number.isFinite(Number(appInfoAfter.balance))
            ) ? Math.max(
                    0,
                    Number(appInfoAfter.balance) - Number(appBalanceBefore)
                )
                : 0;
            if (confirmed > 0) {
                this.result.read += '（App 余额 +' + confirmed + '）';
                this.log('🟢', '阅读 App 余额确认 +' + confirmed);
            } else if (reportedPoints > 0) {
                this.result.read += '（积分未确认，接口值 +'
                    + reportedPoints + '）';
                this.log(
                    '🟡',
                    '阅读进度已更新，但 App 余额未变化，暂不确认积分入账'
                );
            }
        } catch (error) {
            this.result.read = '失败';
            this.recordFailure('阅读', error.message);
            this.log('🔴', '阅读任务失败: ' + error.message);
        }
    }

    inferKind(offerId, title) {
        const text = offerId + ' ' + title;
        if (/quiz|trivia/i.test(text)) return 'quiz';
        if (/puzzle/i.test(text)) return 'puzzle';
        if (/dailyset|daily/i.test(text)) return 'daily';
        if (/streak/i.test(text)) return 'streak';
        return 'open_only';
    }

    normalizeActivityCard(item, kind) {
        if (!item) return null;
        const offerId = item.offerId || item.offerid || item.id || item.name;
        const hash = item.hash || item.activityId;
        const title = item.title || item.name || item.description || '';
        const points = Number(item.points || item.pointProgressMax || item.max || 0);
        const max = Number(item.pointProgressMax || 0);
        const current = Number(item.pointProgress || 0);
        const trueValues = new Set([
            true,
            1,
            '1',
            'true',
            'completed',
            'complete',
            'claimed',
            'done'
        ]);
        const falseValues = new Set([false, 0, '0', 'false']);
        const completionValues = [
            item.isCompleted,
            item.complete,
            item.completed,
            item.state,
            item.status
        ].filter(function (value) {
            return value !== undefined && value !== null;
        }).map(function (value) {
            return typeof value === 'string'
                ? value.trim().toLowerCase()
                : value;
        });
        const completed = completionValues.some(function (value) {
            return trueValues.has(value);
        }) || (max > 0 && current >= max);
        const lockedValue = typeof item.isLocked === 'string'
            ? item.isLocked.trim().toLowerCase()
            : item.isLocked;
        const unlockedValue = typeof item.isUnlocked === 'string'
            ? item.isUnlocked.trim().toLowerCase()
            : item.isUnlocked;
        const locked = trueValues.has(lockedValue)
            || (
                falseValues.has(unlockedValue)
                && item.isUnlocked !== undefined
                && item.isUnlocked !== null
            );
        const haystack = (title + ' ' + offerId).toLowerCase();
        const skipped = SKIP_PATTERNS.some(function (pattern) {
            return haystack.includes(pattern);
        });
        return {
            title: title,
            points: points,
            offerId: String(offerId || ''),
            hash: String(hash || ''),
            kind: kind || this.inferKind(offerId, title),
            type: item.type === undefined || item.type === null ? 11 : item.type,
            isPromotional: item.isPromotional === undefined
                ? '$undefined'
                : item.isPromotional,
            form: item.form || '',
            url: item.destinationUrl || item.destination || 'https://rewards.bing.com/',
            current: current,
            max: max,
            completed: completed,
            locked: locked,
            skipped: skipped
        };
    }

    activitySnapshot(dashboard) {
        const statuses = [];
        const seen = new Set();
        const self = this;
        function push(item, kind) {
            const card = self.normalizeActivityCard(item, kind);
            if (!card) return;
            const key = card.offerId + ':' + card.hash + ':'
                + card.completed + ':' + card.current + ':' + card.max;
            if (!seen.has(key)) {
                seen.add(key);
                statuses.push(card);
            }
        }
        const dailySets = dashboard.dailySetPromotions || {};
        const today = rewardsDateKey(this.config.lockCN);
        for (const key of Object.keys(dailySets)) {
            if (normalizeDashboardDate(key) !== today) continue;
            const items = dailySets[key];
            if (Array.isArray(items)) items.forEach(function (item) { push(item, 'daily'); });
        }
        if (Array.isArray(dashboard.dailySetItems)) {
            dashboard.dailySetItems.forEach(function (item) {
                push(item, 'daily');
            });
        }
        for (const collection of [
            dashboard.activityCards,
            dashboard.morePromotions,
            dashboard.promotions
        ]) {
            if (Array.isArray(collection)) {
                collection.forEach(function (item) { push(item); });
            }
        }
        const pending = statuses.filter(function (card) {
            return !card.completed;
        });
        return {
            source: dashboard.source || 'getuserinfo',
            statuses: statuses,
            cards: statuses.filter(function (card) {
                return Boolean(
                    card.offerId
                    && card.hash
                    && card.points > 0
                    && !card.completed
                    && !card.locked
                    && !card.skipped
                );
            }),
            excluded: {
                zeroPoint: pending.filter(function (card) {
                    return Boolean(
                        card.offerId
                        && card.hash
                        && card.points <= 0
                        && !card.locked
                        && !card.skipped
                    );
                }).length,
                locked: pending.filter(function (card) {
                    return card.locked;
                }).length,
                skipped: pending.filter(function (card) {
                    return card.skipped;
                }).length,
                missingIdentity: pending.filter(function (card) {
                    return !card.offerId || !card.hash;
                }).length
            }
        };
    }

    async getActivitySnapshot() {
        const dashboards = await Promise.all([
            this.getDashboard(),
            this.getDailySetDashboard()
        ]);
        const combined = Object.assign({}, dashboards[0], {
            source: [
                dashboards[0].source || 'getuserinfo',
                dashboards[1].source || 'dashboard'
            ].join('+'),
            dailySetItems: dashboards[1].dailySetItems
        });
        const snapshot = this.activitySnapshot(combined);
        const dailySetCards = (dashboards[1].dailySetItems || []).map(
            function (item) {
                return this.normalizeActivityCard(item, 'daily');
            },
            this
        ).filter(Boolean);
        snapshot.dailySet = {
            complete: dailySetCards.filter(function (card) {
                return card.completed;
            }).length,
            total: dailySetCards.length
        };
        this.lastActivitySnapshot = snapshot;
        return snapshot;
    }

    async getActivityVerificationSnapshots() {
        const attempts = await Promise.allSettled([
            this.getEarnDashboard(),
            this.getUserInfoDashboard(),
            this.getDailySetDashboard()
        ]);
        const snapshots = attempts.filter(function (attempt) {
            return attempt.status === 'fulfilled';
        }).map(function (attempt) {
            return this.activitySnapshot(attempt.value);
        }, this);
        if (snapshots.length === 0) {
            const reasons = attempts.map(function (attempt) {
                return attempt.status === 'rejected'
                    ? attempt.reason.message
                    : '';
            }).filter(Boolean);
            throw new Error(
                '活动状态复核失败：' + (reasons.join('；') || '没有可用数据源')
            );
        }
        return snapshots;
    }

    async discoverCards() {
        return (await this.getActivitySnapshot()).cards;
    }

    activityExclusionText() {
        const excluded = this.lastActivitySnapshot
            && this.lastActivitySnapshot.excluded;
        if (!excluded) return '';
        const parts = [];
        if (excluded.zeroPoint > 0) {
            parts.push(
                excluded.zeroPoint + ' 个零分/引导卡片未自动处理'
            );
        }
        if (excluded.locked > 0) {
            parts.push(excluded.locked + ' 个锁定卡片');
        }
        if (excluded.skipped > 0) {
            parts.push(excluded.skipped + ' 个高风险卡片已跳过');
        }
        if (excluded.missingIdentity > 0) {
            parts.push(
                excluded.missingIdentity + ' 个卡片缺少服务端标识'
            );
        }
        return parts.join('，');
    }

    activityDailySetText() {
        const dailySet = this.lastActivitySnapshot
            && this.lastActivitySnapshot.dailySet;
        if (!dailySet || dailySet.total <= 0) return '';
        return dailySet.complete + '/' + dailySet.total;
    }

    async verifySubmittedCards(cards) {
        const snapshots = await this.getActivityVerificationSnapshots();
        const statuses = snapshots.flatMap(function (snapshot) {
            return snapshot.statuses;
        });
        return cards.map(function (card) {
            const offerMatches = statuses.filter(function (status) {
                return status.offerId === card.offerId;
            });
            const exactMatches = offerMatches.filter(function (status) {
                return card.hash && status.hash === card.hash;
            });
            const matches = exactMatches.length > 0
                ? exactMatches
                : offerMatches;
            const completed = matches.length > 0
                && matches.every(function (status) {
                    return status.completed === true;
                });
            return {
                card: card,
                completed: completed,
                found: matches.length > 0,
                source: snapshots.map(function (snapshot) {
                    return snapshot.source;
                }).join('+')
            };
        });
    }

    async claimCard(card) {
        if (card.kind === 'quiz' && !this.config.tasks.has('quiz')) return false;
        if (
            card.kind === 'daily'
            && /^Gamification_DailySet_/i.test(card.offerId)
        ) {
            try {
                await this.reportCardServerAction(card);
                this.log(
                    '🟢',
                    '每日活动已由 Rewards Server Action 接受'
                );
                return true;
            } catch (error) {
                this.log(
                    '🟡',
                    '每日活动 Server Action 失败: ' + error.message
                );
                return false;
            }
        }
        try {
            await this.reportCardServerAction(card);
            this.log('🟢', 'Rewards 活动提交已由新版页面接口接受');
            return true;
        } catch (serverActionError) {
            this.log(
                '🟡',
                'Rewards 新版页面接口失败，尝试兼容接口: '
                    + serverActionError.message
            );
        }
        try {
            const target = new URL(card.url || '', 'https://rewards.bing.com/');
            if (target.hostname === 'bing.com' || target.hostname.endsWith('.bing.com')) {
                const activity = await this.reportDailyActivity(target.toString());
                this.log(
                    '🟢',
                    '每日卡片接口已响应'
                        + (activity.balance === null ? '' : '（余额 ' + activity.balance + '）')
                );
                if (activity.increment !== null && activity.increment < card.points) {
                    this.log(
                        '🟡',
                        'RewardsIncrement 字段为 +' + activity.increment
                            + '，不等于卡片标注 +' + card.points
                            + '；不据此判定完成，等待仪表板确认'
                    );
                }
                return true;
            }
        } catch (bingError) {
            this.log('🟡', 'Bing 页面活动上报失败，尝试旧接口: ' + bingError.message);
        }
        try {
            await this.reportActivity(card.offerId, card.hash, card.url);
            return true;
        } catch (firstError) {
            try {
                await this.reportActivity(card.offerId, '1', card.url);
                return true;
            } catch (_) {
                this.log('🟡', '卡片失败 ' + card.offerId + ': ' + firstError.message);
                return false;
            }
        }
    }

    async reportCardServerAction(card) {
        const isPromotional = card.isPromotional === undefined
            ? '$undefined'
            : String(card.isPromotional);
        const timezoneOffset = this.config.lockCN
            ? '-480'
            : String(new Date().getTimezoneOffset());
        const body = JSON.stringify([
            card.hash,
            card.type === undefined || card.type === null ? 11 : card.type,
            {
                offerid: card.offerId,
                isPromotional: isPromotional,
                timezoneOffset: timezoneOffset
            }
        ]);
        const response = await this.http.request(
            'https://rewards.bing.com/earn',
            {
                method: 'POST',
                headers: {
                    'content-type': 'text/plain;charset=UTF-8',
                    'next-action': REWARDS.reportActivityAction,
                    accept: 'text/x-component',
                    origin: 'https://rewards.bing.com',
                    referer: 'https://rewards.bing.com/earn'
                },
                body: body
            }
        );
        if (!/(?:^|\r?\n)\d+:true(?:\r?\n|$)/.test(response.text.trim())) {
            throw new Error('Server Action 响应未确认活动');
        }
        return true;
    }

    async reportDailyActivity(destination) {
        this.syncRewardsSessionToSearch();
        const target = new URL(destination, 'https://www.bing.com/');
        if (target.hostname === 'bing.com' || target.hostname === 'www.bing.com') {
            target.hostname = 'cn.bing.com';
        }
        if (target.hostname !== 'cn.bing.com') {
            throw new Error('每日卡片目标不是受支持的 Bing 页面');
        }
        const ig = crypto.randomBytes(16).toString('hex').toUpperCase();
        const commonHeaders = {
            'user-agent': UA.pc,
            referer: target.toString(),
            origin: target.origin,
            accept: '*/*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
        };
        await this.searchHttp.request(target.toString(), {
            headers: {
                'user-agent': UA.pc,
                referer: 'https://rewards.bing.com/',
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': commonHeaders['accept-language']
            }
        });
        const ncheader = new URLSearchParams({
            ver: String(Date.now()).slice(0, 8),
            IID: 'commerce.5057',
            IG: ig
        });
        await this.searchHttp.request(
            target.origin + '/rewardsapp/ncheader?' + ncheader.toString(),
            {
                method: 'POST',
                headers: Object.assign({
                    'content-type': 'application/x-www-form-urlencoded'
                }, commonHeaders),
                body: 'wb=1;i=1;v=1'
            }
        );
        const report = new URLSearchParams({ IG: ig, IID: 'commerce.5067' });
        for (const name of ['form', 'ocid', 'rnoreward']) {
            const value = target.searchParams.get(name)
                || target.searchParams.get(name.toUpperCase());
            if (value) report.set(name, value);
        }
        const response = await this.searchHttp.request(
            target.origin + '/rewardsapp/reportActivity?' + report.toString(),
            {
                method: 'POST',
                headers: Object.assign({
                    'content-type': 'application/x-www-form-urlencoded'
                }, commonHeaders),
                body: new URLSearchParams({ url: target.toString(), V: 'web' }).toString()
            }
        );
        return parseBingActivityResponse(response.text);
    }

    async runPromos(secondPass) {
        if (!this.config.tasks.has('promos')) return;
        const label = secondPass ? '二次扫描' : '活动卡片';
        try {
            if (secondPass) {
                const submittedCards = Array.from(
                    this.submittedPromoCards.values()
                );
                if (submittedCards.length === 0) {
                    this.result.promos += '，二扫无待确认';
                    if (this.promoSubmissionFailures > 0) {
                        this.recordFailure(
                            '活动',
                            this.promoSubmissionFailures + ' 个卡片提交失败'
                        );
                    }
                    if (this.promoDeferred > 0) {
                        this.recordFailure(
                            '活动',
                            this.promoDeferred + ' 个卡片超出本轮安全上限'
                        );
                    }
                    if (this.promoCooldownSkipped > 0) {
                        this.recordFailure(
                            '活动',
                            this.promoCooldownSkipped + ' 个卡片仍在冷却'
                        );
                    }
                    return;
                }
                const pendingCards = submittedCards.filter(function (card) {
                    return !this.confirmedPromoIds.has(card.offerId);
                }, this);
                if (pendingCards.length > 0) {
                    const verifications = await this.verifySubmittedCards(
                        pendingCards
                    );
                    for (const verification of verifications) {
                        if (verification.completed) {
                            this.confirmedPromoIds.add(
                                verification.card.offerId
                            );
                        } else {
                            this.log(
                                '🟡',
                                '活动未获明确完成状态: '
                                    + verification.card.offerId
                                    + '（'
                                    + (
                                        verification.found
                                            ? '仍为未完成'
                                            : '复核列表中未找到，不能据此判完成'
                                    )
                                    + '）'
                            );
                        }
                    }
                }
                const confirmed = this.confirmedPromoIds.size;
                this.result.promos += '，二扫确认 '
                    + confirmed + '/' + submittedCards.length;
                if (confirmed < submittedCards.length) {
                    this.result.promos += '（仍未完成 '
                        + (submittedCards.length - confirmed) + '）';
                    this.recordFailure(
                        '活动',
                        '二次扫描后仍有 '
                            + (submittedCards.length - confirmed)
                            + ' 个未获服务端明确完成状态'
                    );
                }
                if (this.promoSubmissionFailures > 0) {
                    this.recordFailure(
                        '活动',
                        this.promoSubmissionFailures + ' 个卡片提交失败'
                    );
                }
                if (this.promoDeferred > 0) {
                    this.recordFailure(
                        '活动',
                        this.promoDeferred + ' 个卡片超出本轮安全上限'
                    );
                }
                if (this.promoCooldownSkipped > 0) {
                    this.recordFailure(
                        '活动',
                        this.promoCooldownSkipped + ' 个卡片仍在冷却'
                    );
                }
                return;
            }
            const cards = await this.discoverCards();
            const exclusionText = this.activityExclusionText();
            const dailySetText = this.activityDailySetText();
            const eligibleCards = cards.filter(function (card) {
                return card.kind !== 'quiz' || this.config.tasks.has('quiz');
            }, this);
            this.log(
                '🧩',
                label + '发现 ' + eligibleCards.length + ' 个可执行未完成卡片'
            );
            if (exclusionText) {
                this.log('🟡', '另有 ' + exclusionText);
            }
            if (dailySetText) {
                this.log('📅', '页面每日活动状态 ' + dailySetText);
            }
            if (this.config.dryRun) {
                this.result.promos = 'dry-run：发现 '
                    + eligibleCards.length
                    + ' 个可执行未完成活动';
                if (dailySetText) {
                    this.result.promos += '；每日活动 ' + dailySetText;
                }
                if (exclusionText) {
                    this.result.promos += '；另有 ' + exclusionText;
                }
                return;
            }
            if (eligibleCards.length === 0) {
                const dailySet = this.lastActivitySnapshot
                    && this.lastActivitySnapshot.dailySet;
                if (
                    dailySet
                    && dailySet.total > 0
                    && dailySet.complete >= dailySet.total
                ) {
                    this.result.promos = '每日活动 '
                        + dailySetText
                        + ' 已完成；未发现其他可执行活动';
                } else {
                    this.result.promos =
                        '未发现可执行活动（不等同服务端全部完成）';
                    if (dailySetText) {
                        this.result.promos += '；每日活动 '
                            + dailySetText;
                    }
                    if (
                        dailySet
                        && dailySet.total > 0
                        && dailySet.complete < dailySet.total
                    ) {
                        this.recordFailure(
                            '活动',
                            '每日活动仍为 ' + dailySetText
                        );
                    }
                }
                if (exclusionText) {
                    this.result.promos += '；另有 ' + exclusionText;
                }
                return;
            }
            let ok = 0;
            const available = eligibleCards.filter(function (card) {
                return !this.hasRecentPromoAttempt(card.offerId);
            }, this);
            const skipped = eligibleCards.length - available.length;
            this.promoCooldownSkipped = skipped;
            if (skipped > 0) {
                this.log(
                    '🟡',
                    '活动冷却中，跳过 ' + skipped + ' 个最近已尝试卡片'
                );
            }
            const limited = available.slice(0, this.config.maxPromos);
            this.promoDeferred = Math.max(0, available.length - limited.length);
            const submitted = [];
            for (const card of limited) {
                this.log('🧩', '[' + card.kind + '] ' + (card.title || card.offerId) + ' +' + card.points);
                await this.delay(3000, 8000);
                this.markPromoAttempt(card);
                if (await this.claimCard(card)) {
                    submitted.push(card);
                    this.submittedPromoCards.set(card.offerId, card);
                } else {
                    this.promoSubmissionFailures++;
                }
            }
            if (submitted.length > 0) {
                // Rewards 卡片状态存在服务端同步延迟；集中等待后再验证，
                // 避免刚提交就误判失败并重复上报。
                await this.delay(10000, 20000);
                const verifications = await this.verifySubmittedCards(
                    submitted
                );
                for (const verification of verifications) {
                    if (verification.completed) {
                        this.confirmedPromoIds.add(
                            verification.card.offerId
                        );
                        ok++;
                    } else {
                        this.log(
                            '🟡',
                            '活动提交已接受但未获明确完成状态: '
                                + verification.card.offerId
                                + '（'
                                + (
                                    verification.found
                                        ? '服务端仍显示未完成'
                                        : '复核列表中未找到'
                                )
                                + '）'
                        );
                    }
                }
                if (ok < submitted.length) {
                    this.log(
                        '🟡',
                        '卡片已提交 ' + submitted.length
                            + ' 个，已确认 ' + ok
                            + ' 个，其余未获 Rewards 确认'
                    );
                }
            }
            this.result.promos = '明确完成 ' + ok + '/'
                + eligibleCards.length;
            if (ok < submitted.length) {
                this.result.promos += '（已接受但未确认 '
                    + (submitted.length - ok) + '）';
            }
            if (this.promoDeferred > 0) {
                this.result.promos += '，安全上限延后 '
                    + this.promoDeferred;
            }
            if (skipped > 0) {
                this.result.promos += '，冷却跳过 ' + skipped;
            }
        } catch (error) {
            if (!secondPass) this.result.promos = '失败';
            this.recordFailure('活动', error.message);
            this.log('🔴', label + '失败: ' + error.message);
        }
    }

    async searchOnce(query) {
        const date = new Date();
        const dateText = (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
        const params = 'q=' + encodeURIComponent(query) + '&form=QBLH' + (this.config.lockCN ? '&mkt=zh-CN' : '');
        return this.reportBingPageActivity('https://' + this.host + '/search?' + params, dateText);
    }

    async reportBingPageActivity(destination, dateText) {
        this.syncRewardsSessionToSearch();
        const target = new URL(destination, 'https://' + this.host + '/');
        if (target.hostname === 'bing.com' || target.hostname === 'cn.bing.com') {
            target.hostname = this.host;
        }
        if (target.hostname !== this.host) {
            throw new Error('活动目标不是受支持的 Bing 搜索页');
        }
        const referer = target.origin + '/?form=QBLH';
        const today = dateText || (function () {
            const date = new Date();
            return (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
        })();
        const cookie = '_Rwho=u=d&ts=' + today;
        const page = await this.searchHttp.request(target.toString(), {
            headers: { 'user-agent': UA.pc, referer: referer, cookie: cookie }
        });
        const context = extractBingActivityContext(page.text);
        const headers = {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'user-agent': UA.pc,
            referer: target.toString(),
            origin: target.origin,
            accept: '*/*',
            cookie: cookie
        };
        const query = target.search ? '&' + target.search.slice(1) : '';
        const response = await this.searchHttp.request(
            target.origin + '/rewardsapp/reportActivity?IG='
                + encodeURIComponent(context.ig)
                + '&IID=' + encodeURIComponent(context.iid)
                + query,
            {
                method: 'POST',
                headers: headers,
                body: new URLSearchParams({ url: target.toString(), V: 'web' }).toString()
            }
        );
        return parseBingActivityResponse(response.text);
    }

    async mobileSearchOnce(query) {
        const date = new Date();
        const dateText = (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
        const params = 'q=' + encodeURIComponent(query)
            + '&form=QBLH' + (this.config.lockCN ? '&mkt=zh-CN' : '');
        return this.reportMobileBingActivity(
            'https://' + this.host + '/search?' + params,
            dateText
        );
    }

    async reportMobileBingActivity(destination, dateText) {
        this.syncRewardsSessionToSearch();
        const target = new URL(destination, 'https://' + this.host + '/');
        if (target.hostname === 'bing.com' || target.hostname === 'cn.bing.com') {
            target.hostname = this.host;
        }
        if (target.hostname !== this.host) {
            throw new Error('活动目标不是受支持的 Bing 搜索页');
        }
        const today = dateText || (function () {
            const date = new Date();
            return (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
        })();
        const cookie = '_Rwho=u=m&ts=' + today;
        const referer = target.origin + '/?form=QBLH';
        const headers = {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'user-agent': UA.mobile,
            referer: target.toString(),
            origin: target.origin,
            accept: '*/*',
            cookie: cookie
        };

        // 移动 SERP 不稳定地输出 IID。当前 Bing 移动端先初始化
        // rewardsapp/ncheader，再使用同一 IG/IID 上报活动。
        await this.searchHttp.request(target.toString(), {
            headers: {
                'user-agent': UA.mobile,
                referer: referer,
                cookie: cookie
            }
        });
        const ig = crypto.randomBytes(16).toString('hex').toUpperCase();
        const iid = 'SERP.5047';
        const common = new URLSearchParams({
            ver: '88888888',
            IID: iid,
            IG: ig,
            ajaxreq: '1'
        });
        await this.searchHttp.request(
            target.origin + '/rewardsapp/ncheader?' + common.toString(),
            {
                method: 'POST',
                headers: headers,
                body: 'wb=1%3bi%3d1%3bv%3d1'
            }
        );
        const report = new URLSearchParams({
            IG: ig,
            IID: iid
        });
        for (const [name, value] of target.searchParams) {
            report.append(name, value);
        }
        report.set('ajaxreq', '1');
        const response = await this.searchHttp.request(
            target.origin + '/rewardsapp/reportActivity?' + report.toString(),
            {
                method: 'POST',
                headers: headers,
                body: new URLSearchParams({
                    url: target.toString(),
                    V: 'web'
                }).toString()
            }
        );
        return parseBingActivityResponse(response.text);
    }

    async getSearchQueries(count) {
        if (this.config.searchSource !== 'local') {
            try {
                // 独立客户端不带 Microsoft Cookie、OAuth Token 或账号状态。
                const hot = await loadHotSearchWords(new HttpClient(null));
                this.log('📰', '热搜词来源 ' + hot.provider + '/' + hot.source + '，获取 ' + hot.words.length + ' 条');
                return hot.words.slice(0, count);
            } catch (error) {
                this.log('🟡', '热搜接口不可用，回退本地词库: ' + error.message);
            }
        }
        return shuffled(SEARCH_POOL).slice(0, count);
    }

    getSearchRoundCount() {
        const maximum = Math.max(1, Number(this.config.searchCount || 7));
        return randomInt(Math.min(4, maximum), Math.min(7, maximum));
    }

    getSearchControl(info) {
        const date = taskDateKey(this.config.lockCN);
        let control = this.state.searchControl;
        if (!control || control.date !== date) {
            control = {
                date: date,
                lastProgress: null,
                noProgressRounds: 0,
                paused: false
            };
        }
        if (
            control.paused
            && Number(info.pc.progress) > Number(control.lastProgress)
        ) {
            control.noProgressRounds = 0;
            control.paused = false;
        }
        this.state.searchControl = control;
        return control;
    }

    saveSearchRound(startInfo, finalInfo) {
        const control = this.getSearchControl(startInfo);
        if (finalInfo.pc.progress > startInfo.pc.progress) {
            control.noProgressRounds = 0;
            control.paused = false;
        } else if (
            finalInfo.pc.max > 0
            && finalInfo.pc.progress < finalInfo.pc.max
        ) {
            control.noProgressRounds++;
        }
        if (
            control.noProgressRounds >= 3
            && finalInfo.pc.progress < finalInfo.pc.max
        ) {
            control.paused = true;
        }
        if (
            finalInfo.pc.max > 0
            && finalInfo.pc.progress >= finalInfo.pc.max
        ) {
            control.noProgressRounds = 0;
            control.paused = false;
        }
        control.lastProgress = finalInfo.pc.progress;
        this.state.searchControl = control;
        this.stateStore.save();
        return control;
    }

    async runSearch() {
        if (!this.config.tasks.has('search')) return;
        try {
            const startInfo = this.config.tasks.size === 1
                && this.lastRewardsInfo
                ? this.lastRewardsInfo
                : await this.getRewardsInfo();
            let info = startInfo;
            this.log('🔍', '搜索进度 PC ' + info.pc.progress + '/' + info.pc.max);
            if (this.config.dryRun) {
                this.result.search = 'dry-run ' + info.pc.progress + '/' + info.pc.max;
                return;
            }
            if (info.pc.max <= 0) {
                this.result.search = '跳过（未解析到搜索配额）';
                this.recordFailure('搜索', this.result.search);
                return;
            }
            if (info.pc.progress >= info.pc.max) {
                this.result.search = info.pc.progress + '/' + info.pc.max;
                return;
            }
            const control = this.getSearchControl(info);
            if (control.paused) {
                this.result.search = '暂停（连续 '
                    + control.noProgressRounds + ' 轮服务端进度未变化）';
                this.recordFailure('搜索', this.result.search);
                this.log('🔴', '搜索受限或账号异常，今日停止继续搜索');
                return;
            }
            const searchStartBalance = info.balance;
            let latestResponseBalance = searchStartBalance;
            const queries = await this.getSearchQueries(
                this.getSearchRoundCount()
            );
            let confirmedPoints = 0;
            let successfulRequests = 0;
            const requestErrors = [];
            for (let i = 0; i < queries.length; i++) {
                const query = queries[i];
                this.log('🔍', '搜索 ' + (i + 1) + '/' + queries.length + ': ' + query);
                try {
                    const activity = await this.searchOnce(query);
                    successfulRequests++;
                    const evaluation = evaluateBingReward(
                        activity,
                        latestResponseBalance
                    );
                    latestResponseBalance = evaluation.nextBalance;
                    if (evaluation.confirmedIncrement > 0) {
                        confirmedPoints += evaluation.confirmedIncrement;
                        this.log(
                            '🟢',
                            'Bing 搜索余额确认 +' + evaluation.confirmedIncrement
                        );
                    } else if (
                        evaluation.reportedIncrement !== null
                        && evaluation.reportedIncrement > 0
                    ) {
                        this.log(
                            '🟡',
                            '接口 RewardsIncrement 返回 +'
                                + evaluation.reportedIncrement
                                + '，但余额未变化，暂不确认入账'
                        );
                    }
                    if (
                        info.pc.progress + confirmedPoints >= info.pc.max
                    ) {
                        break;
                    }
                } catch (error) {
                    requestErrors.push(error.message);
                    this.log('🟡', '单次搜索失败，继续本轮: ' + error.message);
                }
                if (i + 1 < queries.length) {
                    await this.delay(
                        Math.max(1000, (this.config.searchInterval - 15) * 1000),
                        (this.config.searchInterval + 15) * 1000
                    );
                }
            }
            info = await this.getRewardsInfo();
            const finalControl = this.saveSearchRound(startInfo, info);
            this.result.search = info.pc.progress + '/' + info.pc.max;
            const dashboardDelta = Math.max(0, info.balance - searchStartBalance);
            if (dashboardDelta > 0) {
                this.result.search += '（本轮余额 +' + dashboardDelta + '）';
            } else if (confirmedPoints === 0) {
                this.result.search += '（本轮未确认入账）';
            }
            if (info.pc.progress < info.pc.max) {
                this.result.search += finalControl.paused
                    ? '（已触发三轮无进度熔断）'
                    : '（待后续轮次）';
            }
            if (successfulRequests === 0 && requestErrors.length > 0) {
                this.recordFailure(
                    '搜索',
                    '本轮全部请求失败：' + requestErrors[0]
                );
            }
            if (finalControl.paused) {
                this.recordFailure('搜索', '连续三轮服务端进度未变化');
            }
            if (confirmedPoints > dashboardDelta) {
                this.log(
                    '🟡',
                    '接口余额曾确认 +' + confirmedPoints
                        + '，最终面板仅 +' + dashboardDelta
                        + '；以最终 Rewards 面板为准'
                );
            }
        } catch (error) {
            this.result.search = '失败';
            this.recordFailure('搜索', error.message);
            this.log('🔴', '搜索任务失败: ' + error.message);
        }
    }

    async runMobileSearch() {
        if (!this.config.tasks.has('mobile')) return;
        try {
            const startInfo = this.config.tasks.size === 1
                && this.lastRewardsInfo
                ? this.lastRewardsInfo
                : await this.getRewardsInfo();
            let info = startInfo;
            this.log(
                '📱',
                '移动搜索使用合并配额 PC ' + info.pc.progress + '/' + info.pc.max
            );
            if (this.config.dryRun) {
                this.result.mobileSearch = 'dry-run ' + info.pc.progress + '/'
                    + info.pc.max + '（合并配额）';
                return;
            }
            if (info.pc.max <= 0) {
                this.result.mobileSearch = '跳过（未解析到搜索配额）';
                this.recordFailure('移动搜索', this.result.mobileSearch);
                return;
            }
            if (info.pc.progress >= info.pc.max) {
                this.result.mobileSearch = info.pc.progress + '/' + info.pc.max
                    + '（合并配额）';
                return;
            }
            const control = this.getSearchControl(info);
            if (control.paused) {
                this.result.mobileSearch = '暂停（搜索进度熔断，共用配额）';
                this.recordFailure('移动搜索', this.result.mobileSearch);
                return;
            }
            const searchStartBalance = info.balance;
            let latestResponseBalance = searchStartBalance;
            const queries = await this.getSearchQueries(
                this.config.mobileSearchCount
            );
            let confirmedPoints = 0;
            let successfulRequests = 0;
            const requestErrors = [];
            for (let i = 0; i < queries.length; i++) {
                const query = queries[i];
                this.log(
                    '📱',
                    '移动搜索 ' + (i + 1) + '/' + queries.length + ': ' + query
                );
                try {
                    const activity = await this.mobileSearchOnce(query);
                    successfulRequests++;
                    const evaluation = evaluateBingReward(
                        activity,
                        latestResponseBalance
                    );
                    latestResponseBalance = evaluation.nextBalance;
                    if (evaluation.confirmedIncrement > 0) {
                        confirmedPoints += evaluation.confirmedIncrement;
                        this.log(
                            '🟢',
                            'Bing 移动搜索余额确认 +'
                                + evaluation.confirmedIncrement
                        );
                    } else if (
                        evaluation.reportedIncrement !== null
                        && evaluation.reportedIncrement > 0
                    ) {
                        this.log(
                            '🟡',
                            '移动接口 RewardsIncrement 返回 +'
                                + evaluation.reportedIncrement
                                + '，但余额未变化，暂不确认入账'
                        );
                    }
                    if (
                        info.pc.progress + confirmedPoints >= info.pc.max
                    ) {
                        break;
                    }
                } catch (error) {
                    requestErrors.push(error.message);
                    this.log('🟡', '单次移动搜索失败，继续本轮: ' + error.message);
                }
                if (i + 1 < queries.length) {
                    await this.delay(
                        Math.max(
                            1000,
                            (this.config.searchInterval - 15) * 1000
                        ),
                        (this.config.searchInterval + 15) * 1000
                    );
                }
            }
            info = await this.getRewardsInfo();
            const finalControl = this.saveSearchRound(startInfo, info);
            this.result.mobileSearch = info.pc.progress + '/' + info.pc.max
                + '（合并配额';
            const dashboardDelta = Math.max(
                0,
                info.balance - searchStartBalance
            );
            if (dashboardDelta > 0) {
                this.result.mobileSearch += '，本轮余额 +' + dashboardDelta;
            } else if (confirmedPoints === 0) {
                this.result.mobileSearch += '，本轮未确认入账';
            }
            if (info.pc.progress < info.pc.max) {
                this.result.mobileSearch += finalControl.paused
                    ? '，已触发三轮无进度熔断'
                    : '，待后续电脑搜索轮次';
            }
            this.result.mobileSearch += '）';
            if (successfulRequests === 0 && requestErrors.length > 0) {
                this.recordFailure(
                    '移动搜索',
                    '本轮全部请求失败：' + requestErrors[0]
                );
            }
            if (finalControl.paused) {
                this.recordFailure('移动搜索', '连续三轮服务端进度未变化');
            }
            if (confirmedPoints > dashboardDelta) {
                this.log(
                    '🟡',
                    '移动接口余额曾确认 +' + confirmedPoints
                        + '，最终面板仅 +' + dashboardDelta
                        + '；以最终 Rewards 面板为准'
                );
            }
        } catch (error) {
            this.result.mobileSearch = '失败';
            this.recordFailure('移动搜索', error.message);
            this.log('🔴', '移动搜索任务失败: ' + error.message);
        }
    }

    async runStreak() {
        if (!this.config.tasks.has('streak')) return;
        try {
            const response = await this.http.request('https://rewards.bing.com/earn', {
                headers: { 'user-agent': UA.pc, referer: 'https://rewards.bing.com/' }
            });
            const progresses = parseEarnStreakProgress(response.text);
            const labels = {
                bing: 'Bing 搜索',
                dailyset: '每日活动',
                bingapp: 'Bing App',
                visualsearch: '视觉搜索'
            };
            this.result.streak = progresses.length > 0
                ? progresses.map(function (progress) {
                    return (labels[progress.partner] || progress.partner)
                        + ' ' + progress.complete + '/' + progress.total;
                }).join('，')
                : '未解析到';
            const dailySet = progresses.find(function (progress) {
                return progress.partner === 'dailyset';
            });
            if (!dailySet) {
                this.recordFailure('连签', '页面未解析到每日活动进度');
            } else if (dailySet.complete < dailySet.total) {
                this.recordFailure(
                    '连签',
                    '每日活动仍为 ' + dailySet.complete
                        + '/' + dailySet.total
                );
            }
            this.log('📅', '连续打卡: ' + this.result.streak);
        } catch (error) {
            this.result.streak = '失败';
            this.recordFailure('连签', error.message);
            this.log('🟡', '连签查询失败: ' + error.message);
        }
    }

    async getClaimablePoints() {
        const response = await this.http.request('https://rewards.bing.com/', {
            headers: {
                'user-agent': UA.pc,
                referer: 'https://rewards.bing.com/'
            }
        });
        const claim = parsePointClaim(response.text);
        claim.pageUrl = response.url;
        return claim;
    }

    async claimAllPoints(pageUrl) {
        const target = new URL(
            pageUrl || 'https://rewards.bing.com/dashboard'
        );
        if (
            target.protocol !== 'https:'
            || target.hostname !== 'rewards.bing.com'
        ) {
            throw new Error('领取页面不是受支持的 Rewards 地址');
        }
        const response = await this.http.request(
            target.toString(),
            {
                method: 'POST',
                headers: {
                    'content-type': 'text/plain;charset=UTF-8',
                    'next-action': REWARDS.claimAllPointsAction,
                    accept: 'text/x-component',
                    origin: target.origin,
                    referer: target.toString()
                },
                body: '[]'
            }
        );
        if (!/(?:^|\r?\n)\d+:true(?:\r?\n|$)/.test(response.text.trim())) {
            throw new Error('领取积分 Server Action 响应未确认');
        }
        return true;
    }

    async runClaim() {
        if (!this.config.tasks.has('claim')) return;
        try {
            const before = await this.getClaimablePoints();
            this.log('🎁', '待领取积分: ' + before.points);
            if (this.config.dryRun) {
                this.result.claim = 'dry-run ' + before.points;
                return;
            }
            if (before.points <= 0) {
                this.result.claim = '0';
                return;
            }
            const balanceBefore = await this.getRewardsInfo();
            await this.claimAllPoints(before.pageUrl);
            await this.delay(5000, 10000);
            const after = await this.getClaimablePoints();
            const info = await this.getRewardsInfo();
            const balanceDelta = Math.max(
                0,
                info.balance - balanceBefore.balance
            );
            const claimed = Math.max(
                balanceDelta,
                before.points - after.points
            );
            if (claimed <= 0 || after.points >= before.points) {
                this.result.claim = '未确认（仍有 ' + after.points + '）';
                this.recordFailure('领取', this.result.claim);
                this.log('🟡', '领取接口已响应，但余额和待领取积分均未变化');
                return;
            }
            this.result.claim = '完成 +' + claimed;
            this.log('🟢', '待领取积分确认 +' + claimed);
        } catch (error) {
            this.result.claim = '失败';
            this.recordFailure('领取', error.message);
            this.log('🔴', '领取积分失败: ' + error.message);
        }
    }

    async run() {
        this.log('🚀', '开始执行');
        const startDelayMin = Math.max(
            0,
            Number(this.config.startDelayMin || 0)
        );
        const startDelayMax = Math.max(
            startDelayMin,
            Number(this.config.startDelayMax || 0)
        );
        if (!this.config.dryRun && startDelayMax > 0) {
            this.log(
                '⏳',
                '启动随机等待 ' + startDelayMin + '–' + startDelayMax + ' 秒'
            );
            await this.delay(startDelayMin * 1000, startDelayMax * 1000);
        }
        try {
            const info = this.preflightRewardsInfo
                || await this.getRewardsInfo();
            if (!this.preflightRewardsInfo) {
                this.preflightRewardsInfo = info;
            }
            this.lastRewardsInfo = info;
            this.result.startBalance = info.balance;
            this.log('📊', '初始积分: ' + info.balance);
        } catch (error) {
            this.log('🔴', error.message);
            this.result.error = 'Cookie 无效';
            return this.result;
        }
        if (!(await this.checkRegion())) {
            this.result.error = '非大陆 IP';
            return this.result;
        }
        if (this.config.dryRun) {
            this.log('🔎', 'dry-run：不刷新 OAuth、不写入令牌状态');
        } else if (this.config.tasks.has('sign') || this.config.tasks.has('read')) {
            if (this.oauthBindingError) {
                this.accessToken = '';
                this.log('🔴', this.oauthBindingError);
            } else if (!this.oauthPreflightDone) {
                await this.refreshOAuth();
            }
        }
        const stages = [
            { task: 'sign', run: this.runSign.bind(this) },
            { task: 'read', run: this.runRead.bind(this) },
            {
                task: 'promos',
                run: this.runPromos.bind(this, false)
            },
            { task: 'search', run: this.runSearch.bind(this) },
            {
                task: 'mobile',
                run: this.runMobileSearch.bind(this)
            },
            { task: 'streak', run: this.runStreak.bind(this) },
            { task: 'claim', run: this.runClaim.bind(this) }
        ].filter(function (stage) {
            return this.config.tasks.has(stage.task);
        }, this);
        let previousTask = '';
        for (const stage of stages) {
            if (previousTask && !this.config.dryRun) {
                if (previousTask === 'search' && stage.task === 'mobile') {
                    await this.delay(
                        Math.max(
                            1000,
                            (this.config.searchInterval - 15) * 1000
                        ),
                        (this.config.searchInterval + 15) * 1000
                    );
                } else {
                    await this.delay(3000, 8000);
                }
            }
            await stage.run();
            previousTask = stage.task;
        }
        if (this.config.tasks.has('promos') && !this.config.dryRun) {
            await this.delay(3000, 8000);
            await this.runPromos(true);
        }
        try {
            const searchOnly = stages.length === 1
                && ['search', 'mobile'].includes(stages[0].task);
            const info = searchOnly && this.lastRewardsInfo
                ? this.lastRewardsInfo
                : await this.getRewardsInfo();
            this.result.endBalance = info.balance;
        } catch (error) {
            this.result.endBalance = this.result.startBalance;
            this.recordFailure('收尾校验', error.message);
        }
        this.log('🎉', '执行结束，积分 ' + this.result.startBalance + ' → ' + this.result.endBalance);
        return this.result;
    }
}

function parseAccounts() {
    const raw = String(process.env.BING_REWARDS_ACCOUNTS || '').trim();
    if (raw) {
        const parsed = safeJson(raw);
        if (!Array.isArray(parsed)) {
            throw new Error('BING_REWARDS_ACCOUNTS 必须是 JSON 数组');
        }
        const accounts = parsed.map(function (item, index) {
            if (!item || typeof item !== 'object') throw new Error('账号 ' + (index + 1) + ' 格式错误');
            return {
                name: item.name || '账号' + (index + 1),
                cookie: item.cookie || '',
                searchCookie: item.searchCookie || item.cookie || '',
                refreshToken: item.refreshToken || item.refresh_token || '',
                authCode: item.authCode || item.auth_code || '',
                oauthRuid: item.oauthRuid || item.oauth_ruid || '',
                cookieFingerprint: item.cookieFingerprint
                    || item.cookie_fingerprint
                    || ''
            };
        });
        return validateAccounts(accounts);
    }
    const cookie = process.env.BING_REWARDS_COOKIE || '';
    if (!cookie) return [];
    return validateAccounts([{
        name: process.env.BING_REWARDS_NAME || '账号1',
        cookie: cookie,
        searchCookie: process.env.BING_REWARDS_SEARCH_COOKIE || cookie,
        refreshToken: process.env.BING_REWARDS_REFRESH_TOKEN || '',
        authCode: process.env.BING_REWARDS_AUTH_CODE || '',
        oauthRuid: process.env.BING_REWARDS_OAUTH_RUID || '',
        cookieFingerprint:
            process.env.BING_REWARDS_COOKIE_FINGERPRINT || ''
    }]);
}

function buildConfig() {
    const taskText = process.env.BING_REWARDS_TASKS || 'sign,read,promos,quiz,search,mobile,streak,claim';
    const searchSourceValue = String(process.env.BING_REWARDS_SEARCH_SOURCE || 'hot').trim().toLowerCase();
    if (!['hot', 'auto', 'local', 'offline'].includes(searchSourceValue)) {
        throw new Error('BING_REWARDS_SEARCH_SOURCE 仅支持 hot/auto/local/offline');
    }
    return {
        tasks: new Set(taskText.split(',').map(function (item) { return item.trim().toLowerCase(); }).filter(Boolean)),
        lockCN: boolEnv('BING_REWARDS_LOCK_CN', true),
        dryRun: boolEnv('BING_REWARDS_DRY_RUN', false),
        notify: boolEnv('BING_REWARDS_NOTIFY', true),
        delayScale: numberEnv('BING_REWARDS_DELAY_SCALE', 1, 1, 10),
        startDelayMin: numberEnv('BING_REWARDS_START_DELAY_MIN', 5, 5, 300),
        startDelayMax: numberEnv('BING_REWARDS_START_DELAY_MAX', 95, 5, 600),
        searchInterval: numberEnv('BING_REWARDS_SEARCH_INTERVAL', 30, 30, 600),
        searchCount: numberEnv('BING_REWARDS_SEARCH_COUNT', 7, 1, 7),
        mobileSearchCount: numberEnv(
            'BING_REWARDS_MOBILE_SEARCH_COUNT',
            3,
            1,
            10
        ),
        searchSource: ['local', 'offline'].includes(searchSourceValue) ? 'local' : 'hot',
        maxPromos: numberEnv('BING_REWARDS_MAX_PROMOS', 20, 0, 100),
        promoRetryHours: numberEnv('BING_REWARDS_PROMO_RETRY_HOURS', 12, 1, 72),
        stateDir: process.env.BING_REWARDS_STATE_DIR || DEFAULT_STATE_DIR
    };
}

function formatSummary(results) {
    return results.map(function (item) {
        const lines = [
            '账号：' + item.name,
            '领取：' + item.claim,
            '签到：' + item.sign,
            '阅读：' + item.read,
            '活动：' + item.promos,
            '搜索：' + item.search,
            '移动搜索：' + item.mobileSearch,
            '连签：' + item.streak,
            '积分：' + item.startBalance + ' → ' + item.endBalance
        ];
        if (item.error) lines.push('错误：' + item.error);
        if (Array.isArray(item.failures) && item.failures.length > 0) {
            lines.push('未完成：' + item.failures.join('；'));
        }
        return lines.join('\n');
    }).join('\n\n');
}

function resultsHaveFailures(results) {
    return results.some(function (item) {
        return Boolean(
            item.error
            || (Array.isArray(item.failures) && item.failures.length > 0)
        );
    });
}

async function sendQingLongNotify(message, enabled) {
    if (!enabled) return;
    const candidates = [
        path.join(__dirname, 'sendNotify.js'),
        path.join(__dirname, '..', 'sendNotify.js')
    ];
    const errors = [];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        try {
            const notify = require(candidate);
            if (notify && typeof notify.sendNotify === 'function') {
                await notify.sendNotify(SCRIPT_NAME, message);
                return;
            }
            errors.push(candidate + ' 未导出 sendNotify');
        } catch (error) {
            errors.push(candidate + ': ' + error.message);
        }
    }
    console.log('[通知] sendNotify.js 调用失败: ' + (errors.join('; ') || '未找到通知模块'));
}

function resolveOAuthBindingConflicts(runners) {
    const groups = new Map();
    for (const runner of runners) {
        const ruid = runner.appAccountInfo && runner.appAccountInfo.ruid;
        if (!ruid) continue;
        if (!groups.has(ruid)) groups.set(ruid, []);
        groups.get(ruid).push(runner);
    }
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const viable = group.filter(function (runner) {
            if (!runner.preflightRewardsInfo || !runner.appAccountInfo) {
                return false;
            }
            return Math.abs(
                Number(runner.appAccountInfo.balance)
                    - Number(runner.preflightRewardsInfo.balance)
            ) <= OAUTH_BALANCE_TOLERANCE;
        });
        if (viable.length === 1) {
            for (const runner of group) {
                if (runner === viable[0]) continue;
                runner.oauthBindingError =
                    'OAuth Token 与“' + viable[0].name
                    + '”属于同一 Microsoft 账号，已阻止串号执行';
            }
            continue;
        }
        for (const runner of group) {
            runner.oauthBindingError =
                '多个备注使用了同一个 Microsoft OAuth 账号，'
                + '请在扩展中分别重新授权';
        }
    }
    return runners;
}

async function preflightOAuthBindings(runners) {
    for (const runner of runners) {
        try {
            runner.preflightRewardsInfo = await runner.getRewardsInfo();
        } catch (_) {
            continue;
        }
        runner.oauthPreflightDone = true;
        const refreshed = await runner.refreshOAuth({ deferSave: true });
        if (
            !refreshed
            && (runner.refreshToken || runner.account.authCode)
        ) {
            runner.oauthBindingError =
                'OAuth 预检失败：' + (runner.oauthRefreshError || 'Token 不可用');
        }
    }
    resolveOAuthBindingConflicts(runners);
    for (const runner of runners) {
        if (runner.oauthBindingError) {
            runner.accessToken = '';
            runner.appAccountInfo = null;
        } else if (runner.accessToken) {
            runner.saveRefreshToken();
        }
    }
}

async function main() {
    const accounts = parseAccounts();
    if (accounts.length === 0) {
        throw new Error('未配置账号，请设置 BING_REWARDS_ACCOUNTS 或 BING_REWARDS_COOKIE');
    }
    for (const account of accounts) {
        if (!account.cookie) throw new Error('账号 ' + account.name + ' 缺少 cookie');
    }
    const config = buildConfig();
    console.log(SCRIPT_NAME);
    console.log('账号数: ' + accounts.length + '，任务: ' + Array.from(config.tasks).join(','));
    if (config.dryRun) console.log('当前为 dry-run，只读取状态，不提交任务');

    const runners = accounts.map(function (account) {
        return new RewardsRunner(account, config);
    });
    if (
        !config.dryRun
        && (config.tasks.has('sign') || config.tasks.has('read'))
    ) {
        await preflightOAuthBindings(runners);
    }

    const results = [];
    for (const runner of runners) {
        try {
            results.push(await runner.run());
        } catch (error) {
            console.error('[' + runner.name + '] 未处理异常:', error);
            results.push(Object.assign(runner.result, { error: error.message }));
        }
    }
    const summary = formatSummary(results);
    console.log('\n' + summary);
    await sendQingLongNotify(summary, config.notify);
    if (resultsHaveFailures(results)) process.exitCode = 1;
    return results;
}

if (require.main === module) {
    main().catch(function (error) {
        console.error('[致命错误] ' + error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    CookieJar: CookieJar,
    HttpClient: HttpClient,
    RewardsRunner: RewardsRunner,
    extractEmbeddedJson: extractEmbeddedJson,
    extractBingActivityContext: extractBingActivityContext,
    parseBingActivityResponse: parseBingActivityResponse,
    evaluateBingReward: evaluateBingReward,
    parseEarnDashboard: parseEarnDashboard,
    extractNextFlightJson: extractNextFlightJson,
    parseDashboardDailySet: parseDashboardDailySet,
    parseEarnStreakProgress: parseEarnStreakProgress,
    parsePointClaim: parsePointClaim,
    parseHotSearchResponse: parseHotSearchResponse,
    loadHotSearchWords: loadHotSearchWords,
    accountCookieIdentity: accountCookieIdentity,
    validateAccounts: validateAccounts,
    parseAccounts: parseAccounts,
    buildConfig: buildConfig,
    resultsHaveFailures: resultsHaveFailures,
    resolveOAuthBindingConflicts: resolveOAuthBindingConflicts,
    preflightOAuthBindings: preflightOAuthBindings,
    main: main
};
