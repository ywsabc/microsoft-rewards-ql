#!/usr/bin/env node
/**
 * name: 微软积分-03活动
 * cron: 11 10 * * *
 */
// SPDX-License-Identifier: MIT
'use strict';

process.env.BING_REWARDS_TASKS = 'promos,quiz';
if (process.env.BING_REWARDS_NOTIFY === undefined) {
    process.env.BING_REWARDS_NOTIFY = '0';
}

require('./microsoft_rewards_ql').main().catch(function (error) {
    console.error('[活动任务错误] ' + error.message);
    process.exitCode = 1;
});
