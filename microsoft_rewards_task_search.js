#!/usr/bin/env node
/**
 * name: 微软积分-04电脑搜索
 * cron: 47 10,12,14,16,18 * * *
 */
// SPDX-License-Identifier: MIT
'use strict';

process.env.BING_REWARDS_TASKS = 'search';
if (process.env.BING_REWARDS_NOTIFY === undefined) {
    process.env.BING_REWARDS_NOTIFY = '0';
}

require('./microsoft_rewards_ql').main().catch(function (error) {
    console.error('[电脑搜索任务错误] ' + error.message);
    process.exitCode = 1;
});
