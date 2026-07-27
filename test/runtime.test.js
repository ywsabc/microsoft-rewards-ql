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
        {
            name: 'A',
            cookie: 'MUID=x',
            searchCookie: 'MUID=search-x',
            refreshToken: 'r1',
            oauthRuid: 'oauth-user-a'
        },
        { name: 'B', cookie: 'MUID=y', authCode: 'c2' }
    ]);
    const accounts = runtime.parseAccounts();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].refreshToken, 'r1');
    assert.equal(accounts[0].oauthRuid, 'oauth-user-a');
    assert.equal(accounts[0].searchCookie, 'MUID=search-x');
    assert.equal(accounts[1].searchCookie, 'MUID=y');
    assert.equal(accounts[1].authCode, 'c2');
    if (previous === undefined) delete process.env.BING_REWARDS_ACCOUNTS;
    else process.env.BING_REWARDS_ACCOUNTS = previous;
});

test('OAuth conflict resolver keeps only the cookie account matching the App balance', function () {
    const first = {
        name: '账号1',
        appAccountInfo: { ruid: 'same-user', balance: 15000 },
        preflightRewardsInfo: { balance: 4400 },
        oauthBindingError: ''
    };
    const second = {
        name: '账号2',
        appAccountInfo: { ruid: 'same-user', balance: 15000 },
        preflightRewardsInfo: { balance: 15000 },
        oauthBindingError: ''
    };
    runtime.resolveOAuthBindingConflicts([first, second]);
    assert.match(first.oauthBindingError, /账号2.*同一 Microsoft 账号/);
    assert.equal(second.oauthBindingError, '');
});

test('OAuth conflict resolver rejects ambiguous duplicate account bindings', function () {
    const runners = ['账号1', '账号2'].map(function (name) {
        return {
            name: name,
            appAccountInfo: { ruid: 'same-user', balance: 5000 },
            preflightRewardsInfo: { balance: 5000 },
            oauthBindingError: ''
        };
    });
    runtime.resolveOAuthBindingConflicts(runners);
    assert.match(runners[0].oauthBindingError, /多个备注使用了同一个/);
    assert.match(runners[1].oauthBindingError, /多个备注使用了同一个/);
});

test('App sign-in accepts a zero-point activity without claiming points', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'sign-zero-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(['sign']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    runner.accessToken = 'test-access-token';
    runner.jsonRequest = async function () {
        return {
            code: 0,
            response: {
                balance: 4491,
                activity: { type: 103, p: 0, q: 1 },
                isDuplicate: false
            }
        };
    };
    const result = await runner.signApp();
    assert.deepEqual(result, {
        reportedPoints: 0,
        balance: 4491,
        duplicate: false,
        accepted: true
    });
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

test('RewardsRunner uses the dedicated Bing search cookie when provided', function () {
    const runner = new runtime.RewardsRunner(
        {
            name: 'split-session-test',
            cookie: 'WLS=rewards-session; _U=rewards-auth',
            searchCookie: 'WLS=search-session; _U=search-auth'
        },
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
    assert.match(
        runner.http.jar.getHeader('https://rewards.bing.com/earn'),
        /WLS=rewards-session/
    );
    assert.match(
        runner.searchHttp.jar.getHeader('https://www.bing.com/search'),
        /WLS=search-session/
    );
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

test('evaluateBingReward confirms points only when the balance increases', function () {
    assert.deepEqual(
        runtime.evaluateBingReward({ increment: 1, balance: 100 }, 100),
        {
            reportedIncrement: 1,
            responseBalance: 100,
            confirmedIncrement: 0,
            nextBalance: 100
        }
    );
    assert.deepEqual(
        runtime.evaluateBingReward({ increment: 1, balance: 103 }, 100),
        {
            reportedIncrement: 1,
            responseBalance: 103,
            confirmedIncrement: 3,
            nextBalance: 103
        }
    );
    assert.deepEqual(
        runtime.evaluateBingReward({ increment: 1, balance: null }, 100),
        {
            reportedIncrement: 1,
            responseBalance: null,
            confirmedIncrement: 0,
            nextBalance: 100
        }
    );
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
            return { text: 'var _G={IG:"ABCDEF123"};window.data_iid="SERP.5099";' };
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
    assert.match(requests[1].url, /IG=ABCDEF123/);
    assert.match(requests[1].url, /IID=SERP\.5099/);
    assert.match(requests[1].url, /q=test/);
    assert.match(requests[1].options.body, /V=web/);
    assert.equal(result.increment, 1);
});

test('reportMobileBingActivity initializes and reports the mobile SERP', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'mobile-search-protocol-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['mobile']),
            lockCN: true,
            dryRun: true,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            mobileSearchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    const requests = [];
    runner.searchHttp.request = async function (url, options) {
        requests.push({ url: url, options: options });
        if (requests.length < 3) return { text: '' };
        return {
            text: '{"IsAuthenticated":true,"RewardsIncrement":1,"Balance":4305}'
        };
    };
    const result = await runner.reportMobileBingActivity(
        'https://www.bing.com/search?q=mobile&form=QBLH&mkt=zh-CN',
        '7/26/2026'
    );
    assert.equal(requests.length, 3);
    assert.match(requests[0].options.headers['user-agent'], /Mobile/);
    assert.match(requests[0].options.headers.cookie, /_Rwho=u=m/);
    assert.match(requests[1].url, /\/rewardsapp\/ncheader\?/);
    assert.match(requests[1].url, /IID=SERP\.5047/);
    assert.match(requests[1].url, /ajaxreq=1/);
    assert.equal(requests[1].options.body, 'wb=1%3bi%3d1%3bv%3d1');
    assert.match(requests[2].url, /\/rewardsapp\/reportActivity\?/);
    assert.match(requests[2].url, /IID=SERP\.5047/);
    assert.match(requests[2].url, /q=mobile/);
    assert.match(requests[2].url, /ajaxreq=1/);
    assert.match(requests[2].options.body, /V=web/);
    assert.equal(result.increment, 1);
});

test('reportDailyActivity uses the commerce protocol for Rewards cards', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'daily-protocol-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['promos']),
            lockCN: true,
            dryRun: false,
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
        if (requests.length < 3) return { text: '' };
        return {
            text: '{"IsAuthenticated":true,"RewardsIncrement":15,"Balance":4316}'
        };
    };
    const result = await runner.reportDailyActivity(
        'https://www.bing.com/search?q=test&form=ML2W4J&OCID=ML2W4J'
    );
    assert.equal(requests.length, 3);
    assert.match(requests[0].url, /^https:\/\/cn\.bing\.com\/search/);
    assert.match(requests[1].url, /\/rewardsapp\/ncheader\?/);
    assert.match(requests[1].url, /IID=commerce\.5057/);
    assert.match(requests[2].url, /\/rewardsapp\/reportActivity\?/);
    assert.match(requests[2].url, /IID=commerce\.5067/);
    assert.match(requests[2].url, /form=ML2W4J/);
    assert.equal(result.increment, 15);
});

test('reportCardServerAction matches the current Rewards page protocol', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'card-verification-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['promos']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    let request;
    runner.http.request = async function (url, options) {
        request = { url: url, options: options };
        return {
            status: 200,
            headers: { 'content-type': 'text/x-component' },
            text: '0:{"a":"$@1","f":"","q":"","i":false}\n1:true\n'
        };
    };
    const ok = await runner.reportCardServerAction({
        offerId: 'offer-1',
        hash: 'hash-1',
        type: 11,
        isPromotional: '$undefined',
        kind: 'open_only',
        url: 'https://www.bing.com/search?q=test'
    });
    assert.equal(ok, true);
    assert.equal(request.url, 'https://rewards.bing.com/earn');
    assert.equal(
        request.options.headers['next-action'],
        '70babbc81d2724f60d29a95c03b3d739cba77cea92'
    );
    assert.deepEqual(JSON.parse(request.options.body), [
        'hash-1',
        11,
        {
            offerid: 'offer-1',
            isPromotional: '$undefined',
            timezoneOffset: '-480'
        }
    ]);
});

test('parsePointClaim reads pending points and treats a null model as zero', function () {
    const pending = [
        '<script>self.__next_f.push([1,',
        '\\"type\\":\\"pointsclaim\\",\\"model\\":{\\"pointClaim\\":',
        '{\\"points\\":420,\\"entries\\":[{\\"category\\":\\"gub\\",',
        '\\"points\\":420,\\"date\\":\\"2026-07\\"}]}}',
        ']);</script>'
    ].join('');
    assert.deepEqual(runtime.parsePointClaim(pending), {
        points: 420,
        entries: [{
            category: 'gub',
            points: 420,
            date: '2026-07'
        }]
    });
    assert.deepEqual(
        runtime.parsePointClaim(
            '<script>\\"pointClaim\\":null</script>'
        ),
        { points: 0, entries: [] }
    );
});

test('claimAllPoints matches the current Rewards claim protocol', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'points-claim-protocol-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['claim']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    let request;
    runner.http.request = async function (url, options) {
        request = { url: url, options: options };
        return {
            status: 200,
            headers: { 'content-type': 'text/x-component' },
            text: '0:{"a":"$@1","f":"","q":"","i":false}\n1:true\n'
        };
    };
    assert.equal(
        await runner.claimAllPoints('https://rewards.bing.com/dashboard'),
        true
    );
    assert.equal(request.url, 'https://rewards.bing.com/dashboard');
    assert.equal(
        request.options.headers.referer,
        'https://rewards.bing.com/dashboard'
    );
    assert.equal(request.options.body, '[]');
    assert.equal(
        request.options.headers['next-action'],
        '00cf5ba7699f0e920ffcff223f9e48fea78fd49784'
    );
});

test('runClaim submits only when points are actually pending', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'points-claim-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['claim']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    let claimReads = 0;
    let balanceReads = 0;
    let submissions = 0;
    runner.getClaimablePoints = async function () {
        claimReads++;
        return claimReads === 1
            ? {
                points: 100,
                entries: [{ points: 100 }],
                pageUrl: 'https://rewards.bing.com/dashboard'
            }
            : { points: 0, entries: [] };
    };
    runner.getRewardsInfo = async function () {
        balanceReads++;
        return { balance: balanceReads === 1 ? 1000 : 1100 };
    };
    let submittedPageUrl = '';
    runner.claimAllPoints = async function (pageUrl) {
        submissions++;
        submittedPageUrl = pageUrl;
        return true;
    };
    runner.delay = async function () {};
    await runner.runClaim();
    assert.equal(submissions, 1);
    assert.equal(
        submittedPageUrl,
        'https://rewards.bing.com/dashboard'
    );
    assert.equal(runner.result.claim, '完成 +100');

    runner.getClaimablePoints = async function () {
        return { points: 0, entries: [] };
    };
    await runner.runClaim();
    assert.equal(submissions, 1);
    assert.equal(runner.result.claim, '0');
});

test('claimCard prefers the Rewards Server Action over compatibility APIs', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'card-action-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['promos']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-test-state'
        }
    );
    let serverActions = 0;
    runner.reportCardServerAction = async function () {
        serverActions++;
        return true;
    };
    runner.reportDailyActivity = async function () {
        throw new Error('compatibility API must not run after Server Action success');
    };
    const ok = await runner.claimCard({
        offerId: 'offer-1',
        hash: 'hash-1',
        type: 11,
        isPromotional: '$undefined',
        kind: 'open_only',
        url: 'https://www.bing.com/search?q=test'
    });
    assert.equal(ok, true);
    assert.equal(serverActions, 1);
});

test('discoverCards excludes locked level-benefit activities', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'locked-card-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['promos']),
            lockCN: true,
            dryRun: true,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 10,
            promoRetryHours: 12,
            stateDir: '/tmp/microsoft-rewards-ql-locked-card-' + process.pid
        }
    );
    runner.getDashboard = async function () {
        return {
            morePromotions: [
                {
                    title: 'locked',
                    points: 15,
                    offerId: 'locked-offer',
                    hash: 'hash-1',
                    isLocked: true,
                    isUnlocked: false
                },
                {
                    title: 'available',
                    points: 15,
                    offerId: 'available-offer',
                    hash: 'hash-2',
                    isLocked: false,
                    isUnlocked: true,
                    destination: 'https://www.bing.com/search?q=test'
                }
            ]
        };
    };
    const cards = await runner.discoverCards();
    assert.deepEqual(cards.map(function (card) { return card.offerId; }), [
        'available-offer'
    ]);
});

test('runPromos cools down an unconfirmed card after one submission', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'promo-cooldown-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['promos']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            promoRetryHours: 12,
            stateDir: '/tmp/microsoft-rewards-ql-promo-cooldown-' + process.pid
        }
    );
    const card = {
        title: 'cooldown card',
        points: 15,
        offerId: 'cooldown-offer',
        hash: 'hash',
        kind: 'open_only',
        url: 'https://www.bing.com/search?q=test'
    };
    let submissions = 0;
    runner.stateStore.save = function () {};
    runner.discoverCards = async function () { return [card]; };
    runner.claimCard = async function () {
        submissions++;
        return true;
    };
    runner.delay = async function () {};

    await runner.runPromos(false);
    await runner.runPromos(false);
    assert.equal(submissions, 1);
    assert.match(runner.result.promos, /冷却跳过 1/);
});

test('the second promo scan never submits a new card', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'promo-second-pass-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['promos']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            promoRetryHours: 12,
            stateDir: '/tmp/microsoft-rewards-ql-promo-second-' + process.pid
        }
    );
    let submissions = 0;
    runner.discoverCards = async function () {
        return [{
            title: 'new card',
            points: 15,
            offerId: 'new-offer',
            hash: 'hash',
            kind: 'open_only',
            url: 'https://www.bing.com/search?q=test'
        }];
    };
    runner.claimCard = async function () {
        submissions++;
        return true;
    };
    await runner.runPromos(true);
    assert.equal(submissions, 0);
    assert.match(runner.result.promos, /二扫无待确认/);
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
    assert.equal(runtime.buildConfig().promoRetryHours, 12);
    assert.equal(runtime.buildConfig().mobileSearchCount, 3);
    assert.equal(runtime.buildConfig().tasks.has('mobile'), true);
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
