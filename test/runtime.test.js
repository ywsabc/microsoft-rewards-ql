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
