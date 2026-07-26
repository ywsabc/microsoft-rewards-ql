'use strict';

const assert = require('assert');
const http = require('http');
const test = require('node:test');
const runtime = require('../microsoft_rewards_ql');

test('CookieJar scopes Bing cookies and merges per-request cookies', function () {
    const jar = new runtime.CookieJar('A=1; B=2');
    const bing = jar.getHeader('https://rewards.bing.com/earn', '_Rwho=u=d');
    assert.match(bing, /A=1/);
    assert.match(bing, /B=2/);
    assert.match(bing, /_Rwho=u=d/);
    assert.equal(jar.getHeader('https://login.live.com/', ''), '');
});

test('parseAccounts accepts multi-account JSON', function () {
    const previous = process.env.BING_REWARDS_ACCOUNTS;
    process.env.BING_REWARDS_ACCOUNTS = JSON.stringify([
        { name: 'A', cookie: 'MUID=x', refreshToken: 'r1' },
        { name: 'B', cookie: 'MUID=y', authCode: 'c2' }
    ]);
    const accounts = runtime.parseAccounts();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].refreshToken, 'r1');
    assert.equal(accounts[1].authCode, 'c2');
    if (previous === undefined) delete process.env.BING_REWARDS_ACCOUNTS;
    else process.env.BING_REWARDS_ACCOUNTS = previous;
});

test('HttpClient follows redirects and retains response cookies', async function (context) {
    const server = http.createServer(function (request, response) {
        if (request.url === '/start') {
            response.writeHead(302, {
                location: '/finish',
                'set-cookie': 'SESSION=abc; Path=/; HttpOnly'
            });
            response.end();
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ cookie: request.headers.cookie || '' }));
    });
    await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
    context.after(function () { server.close(); });

    const address = server.address();
    const jar = new runtime.CookieJar('');
    const client = new runtime.HttpClient(jar);
    const result = await client.request('http://127.0.0.1:' + address.port + '/start');
    assert.equal(result.status, 200);
    assert.match(JSON.parse(result.text).cookie, /SESSION=abc/);
});

test('dry-run never refreshes OAuth', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'dry-run-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(),
            lockCN: false,
            dryRun: true,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    runner.getRewardsInfo = async function () {
        return { balance: 100, pc: { progress: 0, max: 60 }, dashboard: {} };
    };
    runner.checkRegion = async function () { return true; };
    runner.refreshOAuth = async function () {
        throw new Error('dry-run must not call refreshOAuth');
    };
    const result = await runner.run();
    assert.equal(result.startBalance, 100);
    assert.equal(result.endBalance, 100);
});

test('Rewards, search, and region requests use isolated cookie clients', function () {
    const runner = new runtime.RewardsRunner(
        { name: 'isolation-test', cookie: 'WLS=rewards-session; _U=auth' },
        {
            tasks: new Set(),
            lockCN: true,
            dryRun: true,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    assert.notEqual(runner.http, runner.searchHttp);
    assert.notEqual(runner.http.jar, runner.searchHttp.jar);
    assert.equal(runner.regionHttp.jar, null);
    runner.searchHttp.jar.upsert({
        name: 'WLS',
        value: 'search-session',
        domain: '.bing.com',
        path: '/',
        secure: true,
        expires: 0
    });
    assert.match(runner.http.jar.getHeader('https://rewards.bing.com/earn'), /WLS=rewards-session/);
    assert.equal(runner.host, 'www.bing.com');
    assert.match(runner.searchHttp.jar.getHeader('https://www.bing.com/'), /WLS=search-session/);
});

test('extractBingActivityContext uses the live SERP IG and IID', function () {
    const context = runtime.extractBingActivityContext(
        '<script>var _G={IG:"ABCDEF0123456789"};window.data_iid="SERP.5057";</script>'
    );
    assert.deepEqual(context, {
        ig: 'ABCDEF0123456789',
        iid: 'SERP.5057'
    });
});

test('parseBingActivityResponse extracts authenticated reward increments', function () {
    const result = runtime.parseBingActivityResponse(
        '<script>{"IsAuthenticated":true,"RewardsIncrement":15,"Balance":4316}</script>'
    );
    assert.deepEqual(result, {
        authenticated: true,
        increment: 15,
        balance: 4316
    });
    assert.throws(function () {
        runtime.parseBingActivityResponse('{"IsAuthenticated":false}');
    }, /未登录 Rewards/);
});

test('reportBingPageActivity reports with identifiers from the loaded page', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'search-protocol-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(),
            lockCN: true,
            dryRun: true,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    const requests = [];
    runner.searchHttp.request = async function (url, options) {
        requests.push({ url: url, options: options });
        if (requests.length === 1) {
            return { text: 'var _G={IG:"LIVEIG123"};window.data_iid="SERP.5099";' };
        }
        return {
            text: '{"IsAuthenticated":true,"RewardsIncrement":1,"Balance":4302}'
        };
    };
    const result = await runner.reportBingPageActivity(
        'https://www.bing.com/search?q=test&form=QBLH&mkt=zh-CN',
        '7/26/2026'
    );
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /IG=LIVEIG123/);
    assert.match(requests[1].url, /IID=SERP\.5099/);
    assert.match(requests[1].url, /q=test/);
    assert.match(requests[1].options.body, /V=web/);
    assert.equal(result.increment, 1);
});

test('legacy Rewards activity is not submitted without a verification token', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'legacy-protocol-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(),
            lockCN: true,
            dryRun: true,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    runner.getVerificationToken = async function () { return ''; };
    await assert.rejects(
        runner.reportActivity('offer', 'hash'),
        function (error) {
            return error.code === 'LEGACY_REWARDS_UNAVAILABLE';
        }
    );
});

test('parseHotSearchResponse sanitizes and deduplicates titles', function () {
    const words = runtime.parseHotSearchResponse(JSON.stringify({
        code: 200,
        data: [
            { title: ' 热搜一 ' },
            { title: '热搜一' },
            { title: '热搜二\n更新' },
            { title: '热搜三' },
            { title: '热搜四' },
            { title: '热搜五' },
            { title: 'https://example.com/not-a-keyword' }
        ]
    }));
    assert.deepEqual(words, ['热搜一', '热搜二 更新', '热搜三', '热搜四', '热搜五']);
});

test('loadHotSearchWords falls through failed providers', async function () {
    const requested = [];
    const client = {
        request: async function (url) {
            requested.push(url);
            if (url.startsWith('https://bad.example/')) throw new Error('offline');
            return {
                text: JSON.stringify({
                    code: 200,
                    data: [
                        { title: '词条一' },
                        { title: '词条二' },
                        { title: '词条三' },
                        { title: '词条四' },
                        { title: '词条五' }
                    ]
                })
            };
        }
    };
    const result = await runtime.loadHotSearchWords(client, [
        { name: 'bad', baseUrl: 'https://bad.example/', sources: ['weibo'] },
        { name: 'good', baseUrl: 'https://good.example/', sources: ['weibo'] }
    ]);
    assert.equal(result.provider, 'good');
    assert.equal(result.words.length, 5);
    assert.equal(requested.length, 2);
});

test('buildConfig supports hot and local search sources', function () {
    const previous = process.env.BING_REWARDS_SEARCH_SOURCE;
    process.env.BING_REWARDS_SEARCH_SOURCE = 'offline';
    assert.equal(runtime.buildConfig().searchSource, 'local');
    process.env.BING_REWARDS_SEARCH_SOURCE = 'auto';
    assert.equal(runtime.buildConfig().searchSource, 'hot');
    if (previous === undefined) delete process.env.BING_REWARDS_SEARCH_SOURCE;
    else process.env.BING_REWARDS_SEARCH_SOURCE = previous;
});

test('parseEarnDashboard extracts balance, search quota, and activity cards', function () {
    const escaped = [
        '<script>self.__next_f.push([1,"',
        '\\"balance\\":15534,',
        '\\"pointsCounters\\":{\\"dailyOffer\\":3008,\\"pc\\":{\\"max\\":60,\\"progress\\":15},\\"totalPoints\\":3023},',
        '\\"activityCards\\":[{\\"title\\":\\"每日活动\\",\\"points\\":10,\\"isCompleted\\":false,',
        '\\"offerId\\":\\"offer-1\\",\\"hash\\":\\"hash-1\\"}]',
        '"])</script>'
    ].join('');
    const dashboard = runtime.parseEarnDashboard(escaped);
    assert.equal(dashboard.source, 'earn');
    assert.equal(dashboard.userStatus.availablePoints, 15534);
    assert.deepEqual(dashboard.userStatus.counters.pcSearch, [{
        pointProgress: 15,
        pointProgressMax: 60
    }]);
    assert.equal(dashboard.morePromotions.length, 1);
    assert.equal(dashboard.morePromotions[0].offerId, 'offer-1');
});
