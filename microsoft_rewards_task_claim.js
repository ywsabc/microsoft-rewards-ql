#!/usr/bin/env node
/**
 * name: 微软积分-07领取
 * cron: 7 12 * * *
 */
// SPDX-License-Identifier: MIT
'use strict';

process.env.BING_REWARDS_TASKS = 'claim';
if (process.env.BING_REWARDS_NOTIFY === undefined) {
    process.env.BING_REWARDS_NOTIFY = '0';
}

require('./microsoft_rewards_ql').main().catch(function (error) {
    console.error('[领取任务错误] ' + error.message);
    process.exitCode = 1;
});
