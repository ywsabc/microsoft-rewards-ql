#!/usr/bin/env node
/**
 * name: 微软积分-06连签
 * cron: 43 11 * * *
 */
// SPDX-License-Identifier: MIT
'use strict';

process.env.BING_REWARDS_TASKS = 'streak';
if (process.env.BING_REWARDS_NOTIFY === undefined) {
    process.env.BING_REWARDS_NOTIFY = '0';
}

require('./microsoft_rewards_ql').main().catch(function (error) {
    console.error('[连签任务错误] ' + error.message);
    process.exitCode = 1;
});
