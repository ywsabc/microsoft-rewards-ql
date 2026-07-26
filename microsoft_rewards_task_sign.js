#!/usr/bin/env node
/**
 * name: 微软积分-01签到
 * cron: 7 9 * * *
 */
// SPDX-License-Identifier: MIT
'use strict';

process.env.BING_REWARDS_TASKS = 'sign';
if (process.env.BING_REWARDS_NOTIFY === undefined) {
    process.env.BING_REWARDS_NOTIFY = '0';
}

require('./microsoft_rewards_ql').main().catch(function (error) {
    console.error('[签到任务错误] ' + error.message);
    process.exitCode = 1;
});
