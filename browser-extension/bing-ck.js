/*
 * JD_COOKIE-style bing_ck codec.
 * One QingLong environment row represents one account. Cookie fields inside
 * the row use "&"; QingLong also joins same-name rows with "&", so every row
 * starts with __bing_account to preserve account boundaries at runtime.
 * SPDX-License-Identifier: MIT
 */

'use strict';

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BingCkCodec = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
    const ACCOUNT_MARKER = '__bing_account';
    const VERSION = '__bing_v';
    const METADATA = new Set([
        ACCOUNT_MARKER,
        VERSION,
        '__bing_search',
        '__bing_token',
        '__bing_ruid',
        '__bing_name',
        '__bing_fp'
    ]);

    function encodeBase64Url(value) {
        const bytes = new TextEncoder().encode(String(value || ''));
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode.apply(
                null,
                bytes.subarray(offset, offset + 0x8000)
            );
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    function decodeBase64Url(value, field, index) {
        if (!value) return '';
        if (!/^[A-Za-z0-9_-]+$/.test(value)) {
            throw new Error(
                'bing_ck 第 ' + (index + 1) + ' 个账号的 ' + field + ' 格式错误'
            );
        }
        try {
            const standard = value.replace(/-/g, '+').replace(/_/g, '/');
            const binary = atob(
                standard + '='.repeat((4 - standard.length % 4) % 4)
            );
            const bytes = Uint8Array.from(binary, function (char) {
                return char.charCodeAt(0);
            });
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (_) {
            throw new Error(
                'bing_ck 第 ' + (index + 1) + ' 个账号的 ' + field + ' 无法解码'
            );
        }
    }

    function parseCookieHeader(header) {
        const values = new Map();
        String(header || '').split(/;\s*/).forEach(function (part) {
            const position = part.indexOf('=');
            if (position <= 0) return;
            values.set(
                part.slice(0, position).trim(),
                part.slice(position + 1).trim()
            );
        });
        return values;
    }

    function splitRecords(raw) {
        const fields = String(raw || '').trim().split('&').map(function (field) {
            return field.trim();
        }).filter(Boolean);
        if (!fields.length) return [];
        const records = [];
        let current = [];
        fields.forEach(function (field) {
            const key = field.split('=', 1)[0];
            if (key === ACCOUNT_MARKER && current.length) {
                records.push(current.join('&'));
                current = [];
            }
            current.push(field);
        });
        if (current.length) records.push(current.join('&'));
        if (
            records.length > 1
            && !records.every(function (record) {
                return record.startsWith(ACCOUNT_MARKER + '=');
            })
        ) {
            throw new Error(
                '多个 bing_ck 账号缺少边界标记，请用新版扩展重新同步'
            );
        }
        return records;
    }

    function decodeAccount(record, index) {
        const rawPairs = String(record || '').split('&').filter(Boolean).map(
            function (part) {
                const position = part.indexOf('=');
                if (position <= 0) {
                    throw new Error(
                        'bing_ck 第 ' + (index + 1)
                            + ' 个账号存在无效 Cookie 字段'
                    );
                }
                return [
                    part.slice(0, position).trim(),
                    part.slice(position + 1)
                ];
            }
        );
        const versioned = rawPairs.some(function (pair) {
            return pair[0] === VERSION && pair[1] === '1';
        });
        const values = new Map();
        rawPairs.forEach(function (rawPair) {
            let key = rawPair[0];
            let value = rawPair[1];
            if (versioned && !METADATA.has(key)) {
                try {
                    key = decodeURIComponent(key);
                    value = decodeURIComponent(value);
                } catch (_) {
                    throw new Error(
                        'bing_ck 第 ' + (index + 1) + ' 个账号 Cookie 转义错误'
                    );
                }
            }
            values.set(key, value);
        });
        const cookie = Array.from(values.entries()).filter(function (entry) {
            return !METADATA.has(entry[0]);
        }).map(function (entry) {
            return entry[0] + '=' + entry[1];
        }).join('; ');
        if (!cookie) {
            throw new Error(
                'bing_ck 第 ' + (index + 1) + ' 个账号缺少 Cookie'
            );
        }
        return {
            name: decodeBase64Url(
                values.get('__bing_name'),
                '账号备注',
                index
            ),
            cookie: cookie,
            searchCookie: decodeBase64Url(
                values.get('__bing_search'),
                '搜索 Cookie',
                index
            ) || cookie,
            cookieFingerprint: String(values.get('__bing_fp') || ''),
            refreshToken: decodeBase64Url(
                values.get('__bing_token'),
                'refreshToken',
                index
            ),
            oauthRuid: decodeBase64Url(
                values.get('__bing_ruid'),
                'oauthRuid',
                index
            )
        };
    }

    function decodeAccounts(raw) {
        return splitRecords(raw).map(decodeAccount);
    }

    function encodeAccount(account) {
        if (!account || typeof account !== 'object' || !account.cookie) {
            throw new Error('bing_ck 账号缺少 Cookie');
        }
        const fingerprint = String(account.cookieFingerprint || '');
        const oauthRuid = String(account.oauthRuid || '');
        if (!fingerprint) {
            throw new Error('bing_ck 账号缺少 Cookie 指纹');
        }
        const marker = oauthRuid
            ? 'oauth.' + encodeBase64Url(oauthRuid)
            : 'cookie.' + fingerprint;
        const fields = [
            ACCOUNT_MARKER + '=' + marker,
            VERSION + '=1'
        ];
        for (const entry of parseCookieHeader(account.cookie).entries()) {
            if (METADATA.has(entry[0])) continue;
            fields.push(
                encodeURIComponent(entry[0])
                    + '=' + encodeURIComponent(entry[1])
            );
        }
        fields.push(
            '__bing_search=' + encodeBase64Url(
                account.searchCookie || account.cookie
            ),
            '__bing_fp=' + fingerprint
        );
        if (account.refreshToken) {
            fields.push(
                '__bing_token=' + encodeBase64Url(account.refreshToken)
            );
        }
        if (oauthRuid) {
            fields.push('__bing_ruid=' + encodeBase64Url(oauthRuid));
        }
        if (account.name) {
            fields.push('__bing_name=' + encodeBase64Url(account.name));
        }
        return fields.join('&');
    }

    function identityIndex(accounts, incoming) {
        let oauthIndex = -1;
        let cookieIndex = -1;
        accounts.forEach(function (account, index) {
            if (
                incoming.oauthRuid
                && account.oauthRuid === incoming.oauthRuid
            ) {
                oauthIndex = index;
            }
            if (
                incoming.cookieFingerprint
                && account.cookieFingerprint === incoming.cookieFingerprint
            ) {
                cookieIndex = index;
            }
        });
        if (
            oauthIndex >= 0
            && cookieIndex >= 0
            && oauthIndex !== cookieIndex
        ) {
            throw new Error('Cookie 与 OAuth 身份分别命中两个账号，已拒绝同步');
        }
        return oauthIndex >= 0 ? oauthIndex : cookieIndex;
    }

    function mergeAccountByIdentity(existing, incoming) {
        const result = existing.slice();
        const index = identityIndex(result, incoming);
        if (index >= 0) {
            const current = result[index];
            if (
                current.oauthRuid
                && incoming.oauthRuid
                && current.oauthRuid !== incoming.oauthRuid
            ) {
                throw new Error('Cookie 已绑定另一个 OAuth 身份，已拒绝同步');
            }
            result[index] = incoming;
        } else {
            result.push(incoming);
        }
        return result;
    }

    return {
        encodeAccount: encodeAccount,
        decodeAccounts: decodeAccounts,
        mergeAccountByIdentity: mergeAccountByIdentity
    };
}));
