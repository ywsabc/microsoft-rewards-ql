#!/usr/bin/env node
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

function todayKeys() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const year = now.getFullYear();
    return [
        String(month).padStart(2, '0') + '/' + String(day).padStart(2, '0') + '/' + year,
        month + '/' + day + '/' + year
    ];
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

function mask(value) {
    const text = String(value || '');
    if (text.length < 12) return text ? '***' : '';
    return text.slice(0, 5) + '…' + text.slice(-4);
}

function sanitizeName(value) {
    return String(value || 'account').replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]/g, '_').slice(0, 60);
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
    constructor(accountName, stateDir) {
        this.dir = stateDir || DEFAULT_STATE_DIR;
        this.file = path.join(this.dir, sanitizeName(accountName) + '.json');
        this.data = {};
        try {
            this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch (_) {
            this.data = {};
        }
    }

    save() {
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
        this.stateStore = new StateStore(this.name, config.stateDir);
        this.state = this.stateStore.data;
        this.accessToken = '';
        this.refreshToken = this.state.refreshToken || account.refreshToken || '';
        this.region = 'CN';
        this.host = config.lockCN ? 'cn.bing.com' : 'www.bing.com';
        this.logs = [];
        this.result = {
            name: this.name,
            startBalance: 0,
            endBalance: 0,
            sign: '未执行',
            read: '未执行',
            promos: '未执行',
            search: '未执行',
            streak: '未执行'
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

    async jsonRequest(url, options) {
        const response = await this.http.request(url, options);
        const data = safeJson(response.text);
        if (!data) throw new Error('接口未返回 JSON: ' + new URL(url).hostname);
        return data;
    }

    async refreshOAuth() {
        const storedToken = this.state.refreshToken || '';
        const configuredToken = this.account.refreshToken || '';
        const candidates = [];
        if (storedToken) candidates.push({ type: 'refresh_token', value: storedToken });
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
                if (data.refresh_token) {
                    this.refreshToken = data.refresh_token;
                    this.state.refreshToken = data.refresh_token;
                    this.state.tokenUpdatedAt = Date.now();
                    this.stateStore.save();
                }
                this.log('🟢', 'OAuth Token 获取成功（refreshToken ' + mask(this.refreshToken) + '）');
                return true;
            } catch (error) {
                lastError = error;
            }
        }
        this.log('🔴', 'OAuth Token 获取失败: ' + (lastError ? lastError.message : '未知错误'));
        return false;
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

    async getDashboard() {
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
        return data.dashboard || data;
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
        return { dashboard: dashboard, pc: pc, balance: balance };
    }

    async checkRegion() {
        if (!this.config.lockCN) return true;
        try {
            const response = await this.http.request('https://' + this.host + '/', {
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
        // 活动目标经常是 cn.bing.com 搜索页，但防伪令牌属于 Rewards 域。
        const token = await this.getVerificationToken('https://rewards.bing.com/');
        const params = new URLSearchParams({
            id: offerId,
            hash: hash || '1',
            activityAmount: '1'
        });
        if (token) params.set('__RequestVerificationToken', token);
        const headers = {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'user-agent': UA.pc,
            referer: source,
            origin: 'https://rewards.bing.com',
            'x-requested-with': 'XMLHttpRequest'
        };
        if (token) headers.RequestVerificationToken = token;
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
        if (response.activity) return Number(response.activity.p || response.activity.points || 0);
        if (response.isDuplicate || response.activity === null) return 0;
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
        try {
            const appPoints = await this.signApp();
            if (appPoints !== null) {
                success = true;
                total += appPoints;
                this.log('📱', 'App 签到确认 +' + appPoints);
            }
        } catch (error) {
            this.log('🟡', 'App 签到失败: ' + error.message);
        }
        await this.delay(3000, 8000);
        try {
            const pcPoints = await this.signPC();
            success = true;
            total += pcPoints;
            this.log('💻', 'PC 签到确认 +' + pcPoints);
        } catch (error) {
            this.log('🟡', 'PC 签到失败: ' + error.message);
        }
        this.result.sign = success ? '完成 +' + total : '失败';
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
        return Number(activity.p || 0);
    }

    async runRead() {
        if (!this.config.tasks.has('read')) return;
        if (this.config.dryRun) {
            this.result.read = 'dry-run（未刷新 OAuth）';
            return;
        }
        if (!this.accessToken) {
            this.result.read = '跳过（无 Token）';
            return;
        }
        try {
            let progress = await this.getReadProgress();
            if (!progress) throw new Error('未找到阅读任务');
            this.log('📖', '阅读进度 ' + progress.progress + '/' + progress.max);
            const remaining = Math.min(10, Math.max(0, progress.max - progress.progress));
            for (let i = 0; i < remaining; i++) {
                const points = await this.readOnce();
                this.log('📖', '阅读 ' + (i + 1) + '/' + remaining + ' +' + points);
                await this.delay(3000, 8000);
            }
            progress = await this.getReadProgress();
            this.result.read = progress ? progress.progress + '/' + progress.max : '已执行，验证失败';
        } catch (error) {
            this.result.read = '失败';
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

    normalizeCard(item, kind) {
        if (!item) return null;
        const offerId = item.offerId || item.offerid || item.id || item.name;
        const hash = item.hash || item.activityId;
        const title = item.title || item.name || item.description || '';
        const points = Number(item.points || item.pointProgressMax || item.max || 0);
        const max = Number(item.pointProgressMax || 0);
        const current = Number(item.pointProgress || 0);
        const completed = item.isCompleted || item.complete || item.completed || (max > 0 && current >= max);
        if (!offerId || !hash || points <= 0 || completed) return null;
        const haystack = (title + ' ' + offerId).toLowerCase();
        if (SKIP_PATTERNS.some(function (pattern) { return haystack.includes(pattern); })) return null;
        return {
            title: title,
            points: points,
            offerId: offerId,
            hash: hash,
            kind: kind || this.inferKind(offerId, title),
            url: item.destinationUrl || item.destination || 'https://rewards.bing.com/'
        };
    }

    async discoverCards() {
        const dashboard = await this.getDashboard();
        const cards = [];
        const seen = new Set();
        const self = this;
        function push(item, kind) {
            const card = self.normalizeCard(item, kind);
            if (!card) return;
            const key = card.offerId + ':' + card.hash;
            if (!seen.has(key)) {
                seen.add(key);
                cards.push(card);
            }
        }
        const dailySets = dashboard.dailySetPromotions || {};
        for (const key of todayKeys()) {
            const items = dailySets[key];
            if (Array.isArray(items)) items.forEach(function (item) { push(item, 'daily'); });
        }
        const more = dashboard.morePromotions || dashboard.promotions || [];
        if (Array.isArray(more)) more.forEach(function (item) { push(item); });
        return cards;
    }

    async claimCard(card) {
        if (card.kind === 'quiz' && !this.config.tasks.has('quiz')) return false;
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

    async runPromos(secondPass) {
        if (!this.config.tasks.has('promos')) return;
        const label = secondPass ? '二次扫描' : '活动卡片';
        try {
            const cards = await this.discoverCards();
            this.log('🧩', label + '发现 ' + cards.length + ' 个未完成卡片');
            if (this.config.dryRun) {
                this.result.promos = 'dry-run ' + cards.length + ' 个';
                return;
            }
            let ok = 0;
            const limited = cards.slice(0, this.config.maxPromos);
            for (const card of limited) {
                this.log('🧩', '[' + card.kind + '] ' + (card.title || card.offerId) + ' +' + card.points);
                await this.delay(3000, 8000);
                if (await this.claimCard(card)) ok++;
            }
            if (secondPass) {
                this.result.promos += '，二扫 ' + ok + '/' + limited.length;
            } else {
                this.result.promos = ok + '/' + limited.length;
            }
        } catch (error) {
            if (!secondPass) this.result.promos = '失败';
            this.log('🔴', label + '失败: ' + error.message);
        }
    }

    async searchOnce(query) {
        const date = new Date();
        const dateText = (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
        const params = 'q=' + encodeURIComponent(query) + '&form=QBLH' + (this.config.lockCN ? '&mkt=zh-CN' : '');
        const referer = 'https://' + this.host + '/?form=QBLH';
        const cookie = '_Rwho=u=d&ts=' + dateText;
        await this.http.request('https://' + this.host + '/search?' + params, {
            headers: { 'user-agent': UA.pc, referer: referer, cookie: cookie }
        });
        const ig = crypto.randomBytes(16).toString('hex').toUpperCase();
        const headers = {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'user-agent': UA.pc,
            referer: referer,
            cookie: cookie
        };
        await this.http.request(
            'https://' + this.host + '/rewardsapp/ncheader?ver=88888888&IID=SERP.5047&IG=' + ig + '&ajaxreq=1',
            { method: 'POST', headers: headers, body: 'wb=1%3bi%3d1%3bv%3d1' }
        );
        await this.http.request(
            'https://' + this.host + '/rewardsapp/reportActivity?IG=' + ig + '&IID=SERP.5047&' + params + '&ajaxreq=1',
            {
                method: 'POST',
                headers: headers,
                body: 'url=' + encodeURIComponent('https://' + this.host + '/search?' + params) + '&V=web'
            }
        );
    }

    async runSearch() {
        if (!this.config.tasks.has('search')) return;
        try {
            let info = await this.getRewardsInfo();
            this.log('🔍', '搜索进度 PC ' + info.pc.progress + '/' + info.pc.max);
            if (this.config.dryRun) {
                this.result.search = 'dry-run ' + info.pc.progress + '/' + info.pc.max;
                return;
            }
            if (info.pc.max > 0 && info.pc.progress >= info.pc.max) {
                this.result.search = info.pc.progress + '/' + info.pc.max;
                return;
            }
            for (let i = 0; i < this.config.searchCount; i++) {
                const query = SEARCH_POOL[randomInt(0, SEARCH_POOL.length - 1)] + ' ' + randomInt(100, 999);
                this.log('🔍', '搜索 ' + (i + 1) + '/' + this.config.searchCount + ': ' + query);
                await this.searchOnce(query);
                if (i + 1 < this.config.searchCount) {
                    await this.delay(
                        Math.max(1000, (this.config.searchInterval - 15) * 1000),
                        (this.config.searchInterval + 15) * 1000
                    );
                }
            }
            info = await this.getRewardsInfo();
            this.result.search = info.pc.progress + '/' + info.pc.max;
        } catch (error) {
            this.result.search = '失败';
            this.log('🔴', '搜索任务失败: ' + error.message);
        }
    }

    async runStreak() {
        if (!this.config.tasks.has('streak')) return;
        try {
            const response = await this.http.request('https://rewards.bing.com/earn', {
                headers: { 'user-agent': UA.pc, referer: 'https://rewards.bing.com/' }
            });
            const text = response.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
            const match = text.match(/每日连续打卡\s*(\d+)/);
            this.result.streak = match ? match[1] + ' 天' : '未解析到';
            this.log('📅', '连续签到: ' + this.result.streak);
        } catch (error) {
            this.result.streak = '失败';
            this.log('🟡', '连签查询失败: ' + error.message);
        }
    }

    async run() {
        this.log('🚀', '开始执行');
        try {
            const info = await this.getRewardsInfo();
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
        } else {
            await this.refreshOAuth();
        }
        await this.runSign();
        await this.delay(3000, 8000);
        await this.runRead();
        await this.delay(3000, 8000);
        await this.runPromos(false);
        await this.delay(3000, 8000);
        await this.runSearch();
        if (this.config.tasks.has('promos') && !this.config.dryRun) {
            await this.delay(3000, 8000);
            await this.runPromos(true);
        }
        await this.runStreak();
        try {
            const info = await this.getRewardsInfo();
            this.result.endBalance = info.balance;
        } catch (_) {
            this.result.endBalance = this.result.startBalance;
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
        return parsed.map(function (item, index) {
            if (!item || typeof item !== 'object') throw new Error('账号 ' + (index + 1) + ' 格式错误');
            return {
                name: item.name || '账号' + (index + 1),
                cookie: item.cookie || '',
                refreshToken: item.refreshToken || item.refresh_token || '',
                authCode: item.authCode || item.auth_code || ''
            };
        });
    }
    const cookie = process.env.BING_REWARDS_COOKIE || '';
    if (!cookie) return [];
    return [{
        name: process.env.BING_REWARDS_NAME || '账号1',
        cookie: cookie,
        refreshToken: process.env.BING_REWARDS_REFRESH_TOKEN || '',
        authCode: process.env.BING_REWARDS_AUTH_CODE || ''
    }];
}

function buildConfig() {
    const taskText = process.env.BING_REWARDS_TASKS || 'sign,read,promos,quiz,search,streak';
    return {
        tasks: new Set(taskText.split(',').map(function (item) { return item.trim().toLowerCase(); }).filter(Boolean)),
        lockCN: boolEnv('BING_REWARDS_LOCK_CN', true),
        dryRun: boolEnv('BING_REWARDS_DRY_RUN', false),
        notify: boolEnv('BING_REWARDS_NOTIFY', true),
        delayScale: numberEnv('BING_REWARDS_DELAY_SCALE', 1, 0, 10),
        searchInterval: numberEnv('BING_REWARDS_SEARCH_INTERVAL', 30, 15, 600),
        searchCount: numberEnv('BING_REWARDS_SEARCH_COUNT', 6, 1, 30),
        maxPromos: numberEnv('BING_REWARDS_MAX_PROMOS', 20, 0, 100),
        stateDir: process.env.BING_REWARDS_STATE_DIR || DEFAULT_STATE_DIR
    };
}

function formatSummary(results) {
    return results.map(function (item) {
        const lines = [
            '账号：' + item.name,
            '签到：' + item.sign,
            '阅读：' + item.read,
            '活动：' + item.promos,
            '搜索：' + item.search,
            '连签：' + item.streak,
            '积分：' + item.startBalance + ' → ' + item.endBalance
        ];
        if (item.error) lines.push('错误：' + item.error);
        return lines.join('\n');
    }).join('\n\n');
}

async function sendQingLongNotify(message, enabled) {
    if (!enabled) return;
    try {
        const notify = require(path.join(__dirname, '..', 'sendNotify.js'));
        if (notify && typeof notify.sendNotify === 'function') {
            await notify.sendNotify(SCRIPT_NAME, message);
        }
    } catch (error) {
        console.log('[通知] sendNotify.js 调用失败: ' + error.message);
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

    const results = [];
    for (const account of accounts) {
        const runner = new RewardsRunner(account, config);
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
    if (results.every(function (item) { return item.error; })) process.exitCode = 1;
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
    parseAccounts: parseAccounts,
    buildConfig: buildConfig
};
