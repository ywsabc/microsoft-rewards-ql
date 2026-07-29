'use strict';

const assert = require('assert');
const test = require('node:test');
const runtime = require('../microsoft_rewards_ql');
const codec = require('../browser-extension/bing-ck');

function account(name, user, ruid) {
    const value = {
        name: name,
        cookie: '_U=' + user + '; .MSA.Auth=auth&' + user
            + '; MUID=rewards-' + user,
        searchCookie: '_U=' + user + '; MUID=search-' + user,
        refreshToken: 'token&' + user,
        oauthRuid: ruid
    };
    value.cookieFingerprint = runtime.accountCookieIdentity(
        value.cookie,
        value.searchCookie
    ).fingerprint;
    return value;
}

test('extension codec stores exactly one account in each bing_ck row', function () {
    const first = account('A', 'user-a', 'ruid-a');
    const second = account('B', 'user-b', 'ruid-b');
    const rows = [
        codec.encodeAccount(first),
        codec.encodeAccount(second)
    ];

    assert.match(rows[0], /^__bing_account=oauth\./);
    assert.match(rows[0], /&_U=user-a&/);
    assert.match(rows[0], /\.MSA\.Auth=auth%26user-a/);
    assert.equal(codec.decodeAccounts(rows[0]).length, 1);

    const joined = codec.decodeAccounts(rows.join('&'));
    assert.equal(joined.length, 2);
    assert.deepEqual(joined.map(function (item) {
        return [
            item.name,
            item.cookie,
            item.searchCookie,
            item.refreshToken,
            item.oauthRuid
        ];
    }), [
        [
            first.name,
            first.cookie,
            first.searchCookie,
            first.refreshToken,
            first.oauthRuid
        ],
        [
            second.name,
            second.cookie,
            second.searchCookie,
            second.refreshToken,
            second.oauthRuid
        ]
    ]);
});

test('runtime and extension decode the same QingLong-joined bing_ck rows', function () {
    const sourceAccounts = [
        account('A', 'user-a', 'ruid-a'),
        account('B', 'user-b', 'ruid-b'),
        account('C', 'user-c', 'ruid-c')
    ];
    const rows = sourceAccounts.map(codec.encodeAccount);
    assert.deepEqual(
        rows,
        sourceAccounts.map(runtime.encodeBingCkAccount)
    );
    const joined = rows.join('&');
    const browserAccounts = codec.decodeAccounts(joined);
    const runtimeAccounts = runtime.decodeBingCkAccounts(joined);

    assert.equal(runtimeAccounts.length, 3);
    assert.deepEqual(
        runtimeAccounts.map(function (item) {
            return [
                item.name,
                item.cookie,
                item.searchCookie,
                item.refreshToken,
                item.oauthRuid
            ];
        }),
        browserAccounts.map(function (item) {
            return [
                item.name,
                item.cookie,
                item.searchCookie,
                item.refreshToken,
                item.oauthRuid
            ];
        })
    );
});

test('selected synchronization merges by OAuth or Cookie identity, not name or order', function () {
    const first = account('相同备注', 'user-a', 'ruid-a');
    const second = account('相同备注', 'user-b', 'ruid-b');
    const rotated = account('新备注', 'user-a-new-cookie', 'ruid-a');

    const merged = codec.mergeAccountByIdentity(
        [second, first],
        rotated
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].oauthRuid, 'ruid-b');
    assert.equal(merged[1].name, '新备注');
    assert.equal(merged[1].cookie, rotated.cookie);
});

test('joined multi-account bing_ck requires explicit account boundaries', function () {
    assert.throws(function () {
        runtime.decodeBingCkAccounts(
            '_U=user-a&.MSA.Auth=auth-a'
                + '&__bing_account=cookie.fake&__bing_v=1&_U=user-b'
        );
    }, /缺少账号边界标记/);
});
