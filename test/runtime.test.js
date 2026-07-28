'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
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

test('parseAccounts rejects duplicate remarks, cookies, OAuth identities, and crossed Bing sessions', function () {
    const previous = process.env.BING_REWARDS_ACCOUNTS;
    const parse = function (accounts) {
        process.env.BING_REWARDS_ACCOUNTS = JSON.stringify(accounts);
        return function () { runtime.parseAccounts(); };
    };
    try {
        assert.throws(parse([
            { name: '账号', cookie: '_U=a', searchCookie: '_U=a' },
            { name: '账号', cookie: '_U=b', searchCookie: '_U=b' }
        ]), /账号备注重复/);
        assert.throws(parse([
            { name: '账号1', cookie: '_U=a', searchCookie: '_U=a' },
            { name: '账号2', cookie: '_U=a', searchCookie: '_U=a' }
        ]), /使用了相同 Cookie/);
        assert.throws(parse([
            {
                name: '账号1',
                cookie: '_U=a',
                searchCookie: '_U=a',
                oauthRuid: 'same-oauth-user'
            },
            {
                name: '账号2',
                cookie: '_U=b',
                searchCookie: '_U=b',
                oauthRuid: 'same-oauth-user'
            }
        ]), /绑定了同一个 OAuth 身份/);
        assert.throws(parse([
            {
                name: '账号1',
                cookie: '_U=rewards-user',
                searchCookie: '_U=search-user'
            }
        ]), /不属于同一会话/);
        assert.throws(parse([
            {
                name: '账号1',
                cookie: '_U=a',
                searchCookie: '_U=a',
                cookieFingerprint: 'forged'
            }
        ]), /Cookie 指纹校验失败/);
    } finally {
        if (previous === undefined) {
            delete process.env.BING_REWARDS_ACCOUNTS;
        } else {
            process.env.BING_REWARDS_ACCOUNTS = previous;
        }
    }
});

test('state files are isolated by account identity instead of remark alone', function () {
    const stateDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'microsoft-rewards-state-binding-')
    );
    const config = {
        tasks: new Set(),
        lockCN: true,
        dryRun: true,
        notify: false,
        delayScale: 0,
        searchInterval: 30,
        searchCount: 1,
        searchSource: 'local',
        maxPromos: 1,
        stateDir: stateDir
    };
    try {
        const first = new runtime.RewardsRunner(
            {
                name: '同名账号',
                cookie: '_U=account-a; .MSA.Auth=auth-a',
                searchCookie: '_U=account-a'
            },
            config
        );
        first.state.refreshToken = 'token-for-account-a';
        first.stateStore.save();

        const firstReloaded = new runtime.RewardsRunner(
            {
                name: '同名账号',
                cookie: '_U=account-a; .MSA.Auth=auth-a',
                searchCookie: '_U=account-a',
                refreshToken: 'stale-environment-token'
            },
            config
        );
        const second = new runtime.RewardsRunner(
            {
                name: '同名账号',
                cookie: '_U=account-b; .MSA.Auth=auth-b',
                searchCookie: '_U=account-b'
            },
            config
        );

        assert.equal(firstReloaded.refreshToken, 'token-for-account-a');
        assert.notEqual(first.stateStore.file, second.stateStore.file);
        assert.equal(second.refreshToken, '');
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('OAuth identity can bootstrap only from an exact Cookie/App balance match', async function () {
    const runner = new runtime.RewardsRunner(
        {
            name: 'unbound-oauth-test',
            cookie: '_U=account-a',
            searchCookie: '_U=account-a',
            refreshToken: 'unbound-refresh-token'
        },
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
            stateDir: path.join(
                os.tmpdir(),
                'microsoft-rewards-unbound-' + process.pid
            )
        }
    );
    let requests = 0;
    runner.preflightRewardsInfo = { balance: 1234 };
    runner.jsonRequest = async function (url) {
        requests++;
        if (url.includes('oauth20_token')) {
            return {
                access_token: 'bootstrap-access-token',
                refresh_token: 'rotated-refresh-token'
            };
        }
        return {
            response: {
                profile: { ruid: 'bootstrapped-oauth-user' },
                balance: 1234
            }
        };
    };

    assert.equal(await runner.refreshOAuth({ deferSave: true }), true);
    assert.equal(requests, 2);
    assert.equal(
        runner.expectedOauthRuid,
        'bootstrapped-oauth-user'
    );
    assert.equal(
        runner.stateStore.binding.oauthRuid,
        'bootstrapped-oauth-user'
    );
});

test('OAuth identity bootstrap rejects a mismatched Cookie/App balance', async function () {
    const runner = new runtime.RewardsRunner(
        {
            name: 'unbound-oauth-mismatch-test',
            cookie: '_U=account-a',
            searchCookie: '_U=account-a',
            refreshToken: 'unbound-refresh-token'
        },
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
            stateDir: path.join(
                os.tmpdir(),
                'microsoft-rewards-unbound-mismatch-' + process.pid
            )
        }
    );
    runner.preflightRewardsInfo = { balance: 1234 };
    runner.jsonRequest = async function (url) {
        if (url.includes('oauth20_token')) {
            return { access_token: 'wrong-account-access-token' };
        }
        return {
            response: {
                profile: { ruid: 'wrong-oauth-user' },
                balance: 9999
            }
        };
    };

    assert.equal(await runner.refreshOAuth({ deferSave: true }), false);
    assert.equal(runner.expectedOauthRuid, '');
    assert.match(runner.oauthRefreshError, /无法通过.*余额一致性/);
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

test('a successful PC sign-in does not hide an App branch failure', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'partial-sign-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(['sign']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 7,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-partial-sign-' + process.pid
        }
    );
    runner.accessToken = 'test-access-token';
    runner.signApp = async function () {
        throw new Error('DAPI unavailable');
    };
    runner.signPC = async function () { return 1; };
    runner.delay = async function () {};

    await runner.runSign();

    assert.match(runner.result.sign, /完成 \+1.*App 分支失败/);
    assert.match(runner.result.failures[0], /App 分支失败/);
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

test('daily-set cards use the Rewards Server Action without compatibility fallbacks', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'daily-set-flow-test', cookie: 'WLS=session; _U=auth' },
        {
            tasks: new Set(['promos']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 3,
            stateDir:
                '/tmp/microsoft-rewards-ql-daily-set-flow-'
                + process.pid
        }
    );
    let serverActions = 0;
    runner.reportDailyActivity = async function (destination) {
        throw new Error(
            'daily set must not use a compatibility page report: '
                + destination
        );
    };
    runner.reportCardServerAction = async function () {
        serverActions++;
        return true;
    };
    const ok = await runner.claimCard({
        offerId: 'Gamification_DailySet_ZHCN_20260728_Child1',
        hash: 'daily-hash',
        kind: 'daily',
        url: 'https://www.bing.com/search?q=test&rnoreward=1'
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
    runner.getDailySetDashboard = async function () {
        return { source: 'dashboard', dailySetItems: [] };
    };
    const cards = await runner.discoverCards();
    assert.deepEqual(cards.map(function (card) { return card.offerId; }), [
        'available-offer'
    ]);
});

test('activity string false remains pending instead of becoming completed', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'activity-false-test', cookie: '_U=account-a' },
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
            stateDir: path.join(
                os.tmpdir(),
                'microsoft-rewards-activity-false-' + process.pid
            )
        }
    );
    runner.getDashboard = async function () {
        return {
            source: 'test-dashboard',
            activityCards: [
                {
                    title: 'pending string false',
                    points: 10,
                    offerId: 'pending-offer',
                    hash: 'pending-hash',
                    isCompleted: 'false'
                },
                {
                    title: 'manual onboarding card',
                    points: 0,
                    offerId: 'zero-point-offer',
                    hash: 'zero-point-hash',
                    isCompleted: false
                }
            ]
        };
    };
    runner.getDailySetDashboard = async function () {
        return { source: 'dashboard', dailySetItems: [] };
    };

    const cards = await runner.discoverCards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].offerId, 'pending-offer');
    assert.equal(cards[0].completed, false);
    assert.match(
        runner.activityExclusionText(),
        /1 个零分\/引导卡片未自动处理/
    );
});

test('activity verification requires an explicit server-completed status', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'activity-verification-test', cookie: '_U=account-a' },
        {
            tasks: new Set(['promos']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 1,
            searchSource: 'local',
            maxPromos: 10,
            stateDir: path.join(
                os.tmpdir(),
                'microsoft-rewards-activity-verification-' + process.pid
            )
        }
    );
    const cards = [
        { offerId: 'missing', hash: 'hash-missing' },
        { offerId: 'pending', hash: 'hash-pending' },
        { offerId: 'explicit', hash: 'hash-explicit' },
        { offerId: 'progress', hash: 'hash-progress' }
    ];
    runner.getActivityVerificationSnapshots = async function () {
        return [runner.activitySnapshot({
            source: 'test-dashboard',
            activityCards: [
                {
                    offerId: 'pending',
                    hash: 'hash-pending',
                    points: 10,
                    isCompleted: false
                },
                {
                    offerId: 'explicit',
                    hash: 'hash-explicit',
                    points: 10,
                    isCompleted: true
                },
                {
                    offerId: 'progress',
                    hash: 'hash-progress',
                    points: 10,
                    pointProgress: 10,
                    pointProgressMax: 10
                }
            ]
        })];
    };

    const verified = await runner.verifySubmittedCards(cards);
    assert.deepEqual(verified.map(function (item) {
        return {
            offerId: item.card.offerId,
            found: item.found,
            completed: item.completed
        };
    }), [
        { offerId: 'missing', found: false, completed: false },
        { offerId: 'pending', found: true, completed: false },
        { offerId: 'explicit', found: true, completed: true },
        { offerId: 'progress', found: true, completed: true }
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
    runner.verifySubmittedCards = async function (cards) {
        return cards.map(function (submittedCard) {
            return {
                card: submittedCard,
                completed: false,
                found: false,
                source: 'test-dashboard'
            };
        });
    };
    runner.delay = async function () {};

    await runner.runPromos(false);
    await runner.runPromos(false);
    assert.equal(submissions, 1);
    assert.match(runner.result.promos, /冷却跳过 1/);
});

test('an accepted promo is reported incomplete when the card disappears', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'promo-disappeared-test', cookie: '_U=account-a' },
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
            stateDir: path.join(
                os.tmpdir(),
                'microsoft-rewards-promo-disappeared-' + process.pid
            )
        }
    );
    const card = {
        title: 'disappeared card',
        points: 10,
        offerId: 'disappeared-offer',
        hash: 'disappeared-hash',
        kind: 'open_only',
        url: 'https://www.bing.com/search?q=test'
    };
    runner.stateStore.save = function () {};
    runner.discoverCards = async function () { return [card]; };
    runner.claimCard = async function () { return true; };
    runner.verifySubmittedCards = async function (cards) {
        return cards.map(function (submittedCard) {
            return {
                card: submittedCard,
                completed: false,
                found: false,
                source: 'test-dashboard'
            };
        });
    };
    runner.delay = async function () {};

    await runner.runPromos(false);
    await runner.runPromos(true);

    assert.match(runner.result.promos, /明确完成 0\/1/);
    assert.match(runner.result.promos, /仍未完成 1/);
    assert.ok(runner.result.failures.some(function (message) {
        return /未获服务端明确完成状态/.test(message);
    }));
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

test('a failed promo submission remains visible after the second scan', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'promo-failure-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(['promos', 'quiz']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 7,
            searchSource: 'local',
            maxPromos: 1,
            promoRetryHours: 12,
            stateDir: '/tmp/microsoft-rewards-ql-promo-failure-' + process.pid
        }
    );
    const card = {
        title: 'failed card',
        points: 10,
        offerId: 'failed-offer',
        hash: 'hash',
        kind: 'open_only',
        url: 'https://www.bing.com/search?q=test'
    };
    runner.stateStore.save = function () {};
    runner.discoverCards = async function () { return [card]; };
    runner.claimCard = async function () { return false; };
    runner.delay = async function () {};

    await runner.runPromos(false);
    await runner.runPromos(true);

    assert.match(runner.result.failures[0], /卡片提交失败/);
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
    assert.equal(runtime.buildConfig().searchCount, 7);
    assert.equal(runtime.buildConfig().startDelayMin, 5);
    assert.equal(runtime.buildConfig().startDelayMax, 95);
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

test('parseDashboardDailySet decodes RSC data and keeps only the requested day', function () {
    const items = [
        {
            date: '07/28/2026',
            title: '活动一',
            description: '包含括号 (测试) 的 RSC 文本',
            points: 10,
            offerId: 'Gamification_DailySet_ZHCN_20260728_Child1',
            hash: 'hash-1',
            isCompleted: false,
            destination:
                'https://www.bing.com/search?q=one&rnoreward=1'
        },
        {
            date: '07/28/2026',
            title: '活动二',
            points: 10,
            offerId: 'Gamification_DailySet_ZHCN_20260728_Child2',
            hash: 'hash-2',
            isCompleted: true,
            destination:
                'https://www.bing.com/search?q=two&rnoreward=1'
        },
        {
            date: '07/29/2026',
            title: '明日活动',
            points: 10,
            offerId: 'Gamification_DailySet_ZHCN_20260729_Child1',
            hash: 'hash-next',
            isCompleted: false,
            destination:
                'https://www.bing.com/search?q=next&rnoreward=1'
        }
    ];
    const payload = '42:' + JSON.stringify({ dailySetItems: items });
    const html = '<script>self.__next_f.push('
        + JSON.stringify([1, payload]) + ')</script>';
    const dashboard = runtime.parseDashboardDailySet(
        html,
        '2026-07-28'
    );
    assert.equal(dashboard.source, 'dashboard');
    assert.equal(dashboard.date, '2026-07-28');
    assert.deepEqual(
        dashboard.dailySetItems.map(function (item) {
            return item.offerId;
        }),
        [
            'Gamification_DailySet_ZHCN_20260728_Child1',
            'Gamification_DailySet_ZHCN_20260728_Child2'
        ]
    );
});

test('discoverCards combines earn cards with pending dashboard daily-set items', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'daily-set-discovery-test', cookie: '_U=account-a' },
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
            stateDir:
                '/tmp/microsoft-rewards-ql-daily-set-discovery-'
                + process.pid
        }
    );
    runner.getDashboard = async function () {
        return { source: 'earn', activityCards: [] };
    };
    runner.getDailySetDashboard = async function () {
        return {
            source: 'dashboard',
            dailySetItems: [
                {
                    date: '07/28/2026',
                    title: '真实每日活动',
                    points: 10,
                    offerId:
                        'Gamification_DailySet_ZHCN_20260728_Child1',
                    hash: 'daily-hash',
                    isCompleted: false,
                    destination:
                        'https://www.bing.com/search?q=test&rnoreward=1'
                }
            ]
        };
    };
    const cards = await runner.discoverCards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'daily');
    assert.equal(
        cards[0].offerId,
        'Gamification_DailySet_ZHCN_20260728_Child1'
    );
});

test('parseEarnStreakProgress reads the current daily-set counter', function () {
    const html = [
        '<script>self.__next_f.push([1,"',
        '\\"partner\\":\\"bing\\",\\"complete\\":1,\\"total\\":1,',
        '\\"partner\\":\\"dailyset\\",\\"complete\\":0,\\"total\\":3',
        '"])</script>'
    ].join('');
    assert.deepEqual(runtime.parseEarnStreakProgress(html), [
        { partner: 'bing', complete: 1, total: 1 },
        { partner: 'dailyset', complete: 0, total: 3 }
    ]);
});

test('search rounds retain the upstream 4-7 request limit', function () {
    const runner = new runtime.RewardsRunner(
        { name: 'search-round-size-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(['search']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 7,
            mobileSearchCount: 3,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-round-size-' + process.pid
        }
    );
    for (let index = 0; index < 100; index++) {
        const count = runner.getSearchRoundCount();
        assert.ok(count >= 4 && count <= 7);
    }
});

test('search count configuration cannot exceed the upstream round limit', function () {
    const previous = {
        count: process.env.BING_REWARDS_SEARCH_COUNT,
        interval: process.env.BING_REWARDS_SEARCH_INTERVAL,
        scale: process.env.BING_REWARDS_DELAY_SCALE,
        start: process.env.BING_REWARDS_START_DELAY_MIN
    };
    process.env.BING_REWARDS_SEARCH_COUNT = '30';
    process.env.BING_REWARDS_SEARCH_INTERVAL = '1';
    process.env.BING_REWARDS_DELAY_SCALE = '0';
    process.env.BING_REWARDS_START_DELAY_MIN = '0';
    const config = runtime.buildConfig();
    assert.equal(config.searchCount, 7);
    assert.equal(config.searchInterval, 30);
    assert.equal(config.delayScale, 1);
    assert.equal(config.startDelayMin, 5);
    const names = {
        count: 'BING_REWARDS_SEARCH_COUNT',
        interval: 'BING_REWARDS_SEARCH_INTERVAL',
        scale: 'BING_REWARDS_DELAY_SCALE',
        start: 'BING_REWARDS_START_DELAY_MIN'
    };
    for (const [key, name] of Object.entries(names)) {
        if (previous[key] === undefined) delete process.env[name];
        else process.env[name] = previous[key];
    }
});

test('a failed Bing request does not abort the remaining search round', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'search-partial-request-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(['search']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 2,
            mobileSearchCount: 1,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-partial-' + process.pid
        }
    );
    let infoReads = 0;
    runner.getRewardsInfo = async function () {
        infoReads++;
        return infoReads === 1
            ? { balance: 1000, pc: { progress: 0, max: 60 } }
            : { balance: 1003, pc: { progress: 3, max: 60 } };
    };
    runner.getSearchQueries = async function () {
        return ['first', 'second'];
    };
    let requests = 0;
    runner.searchOnce = async function () {
        requests++;
        if (requests === 1) throw new Error('temporary SERP error');
        return { increment: 3, balance: 1003 };
    };
    runner.delay = async function () {};
    runner.stateStore.save = function () {};

    await runner.runSearch();

    assert.equal(requests, 2);
    assert.match(runner.result.search, /^3\/60/);
    assert.equal(runner.result.failures.length, 0);
});

test('search never submits when the server quota cannot be parsed', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'search-missing-quota-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(['search']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 7,
            mobileSearchCount: 3,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-missing-quota-' + process.pid
        }
    );
    runner.getRewardsInfo = async function () {
        return { balance: 1000, pc: { progress: 0, max: 0 } };
    };
    runner.searchOnce = async function () {
        throw new Error('must not submit');
    };

    await runner.runSearch();

    assert.match(runner.result.search, /未解析到搜索配额/);
    assert.equal(runner.result.failures.length, 1);
});

test('three unchanged server rounds trigger the daily search circuit breaker', function () {
    const runner = new runtime.RewardsRunner(
        { name: 'search-circuit-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(['search']),
            lockCN: true,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 7,
            mobileSearchCount: 3,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-circuit-' + process.pid
        }
    );
    runner.stateStore.save = function () {};
    const unchanged = {
        balance: 1000,
        pc: { progress: 9, max: 60 }
    };
    runner.saveSearchRound(unchanged, unchanged);
    runner.saveSearchRound(unchanged, unchanged);
    const control = runner.saveSearchRound(unchanged, unchanged);
    assert.equal(control.noProgressRounds, 3);
    assert.equal(control.paused, true);
});

test('split task execution does not wait for disabled modules', async function () {
    const runner = new runtime.RewardsRunner(
        { name: 'split-stage-test', cookie: 'MUID=fake' },
        {
            tasks: new Set(['search']),
            lockCN: false,
            dryRun: false,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 7,
            mobileSearchCount: 3,
            searchSource: 'local',
            maxPromos: 1,
            stateDir: '/tmp/microsoft-rewards-ql-stage-' + process.pid
        }
    );
    let infoReads = 0;
    runner.getRewardsInfo = async function () {
        infoReads++;
        return { balance: 1000, pc: { progress: 60, max: 60 } };
    };
    runner.checkRegion = async function () { return true; };
    let searches = 0;
    runner.runSearch = async function () { searches++; };
    const waits = [];
    runner.delay = async function (min, max) {
        waits.push([min, max]);
    };

    await runner.run();

    assert.equal(searches, 1);
    assert.equal(infoReads, 1);
    assert.deepEqual(waits, []);
});

test('any account-level or module-level failure makes the run fail', function () {
    assert.equal(runtime.resultsHaveFailures([
        { failures: [] },
        { failures: ['搜索：失败'] }
    ]), true);
    assert.equal(runtime.resultsHaveFailures([
        { failures: [] },
        { error: 'Cookie 无效', failures: [] }
    ]), true);
    assert.equal(runtime.resultsHaveFailures([
        { failures: [] },
        { failures: [] }
    ]), false);
});
