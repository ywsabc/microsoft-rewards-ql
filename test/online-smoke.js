'use strict';

const assert = require('assert');
const runtime = require('../microsoft_rewards_ql');

async function main() {
    const client = new runtime.HttpClient(null);
    const bing = await client.request(
        'https://www.bing.com/search?q=Microsoft+Rewards&mkt=zh-CN'
    );
    const context = runtime.extractBingActivityContext(bing.text);
    assert.equal(bing.status, 200);
    assert.ok(context.ig);
    assert.ok(context.iid);

    const rewards = await client.request('https://rewards.bing.com/');
    assert.equal(rewards.status, 200);
    assert.match(new URL(rewards.url).hostname, /^rewards\.bing\.com$/);
    assert.ok(rewards.text.length > 10000);

    const hot = await runtime.loadHotSearchWords(
        new runtime.HttpClient(null)
    );
    assert.ok(hot.words.length >= 5);

    const regionRunner = new runtime.RewardsRunner(
        { name: 'online-region-check', cookie: '' },
        {
            tasks: new Set(),
            lockCN: true,
            dryRun: true,
            notify: false,
            delayScale: 0,
            searchInterval: 30,
            searchCount: 7,
            mobileSearchCount: 3,
            searchSource: 'local',
            maxPromos: 0,
            stateDir: '/tmp/microsoft-rewards-online-smoke'
        }
    );
    const regionOK = await regionRunner.checkRegion();
    assert.equal(regionOK, true);
    assert.equal(regionRunner.region, 'CN');
    assert.ok(regionRunner.logs.some(function (line) {
        return line.includes('地区检测通过: CN');
    }));

    console.log(JSON.stringify({
        checkedAt: new Date().toISOString(),
        bing: {
            status: bing.status,
            finalUrl: bing.url,
            bytes: bing.text.length,
            activityContext: {
                igPresent: Boolean(context.ig),
                iid: context.iid
            }
        },
        rewards: {
            status: rewards.status,
            finalUrl: rewards.url,
            bytes: rewards.text.length
        },
        hotSearch: {
            provider: hot.provider,
            source: hot.source,
            wordCount: hot.words.length
        },
        region: regionRunner.region,
        safety: 'read-only; no account cookie; no Rewards activity submitted'
    }, null, 2));
}

main().catch(function (error) {
    console.error('[在线只读测试失败] ' + error.stack);
    process.exitCode = 1;
});
