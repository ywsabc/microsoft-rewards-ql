#!/usr/bin/env node
/**
 * name: 微软积分-05移动搜索
 * cron: 29 11 * * *
 */
// SPDX-License-Identifier: MIT
'use strict';

process.env.BING_REWARDS_TASKS = 'mobile';
if (process.env.BING_REWARDS_NOTIFY === undefined) {
    process.env.BING_REWARDS_NOTIFY = '0';
}

require('./microsoft_rewards_ql').main().catch(function (error) {
    console.error('[移动搜索任务错误] ' + error.message);
    process.exitCode = 1;
});
