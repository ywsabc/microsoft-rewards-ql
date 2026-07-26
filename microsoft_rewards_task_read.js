#!/usr/bin/env node
/**
 * name: 微软积分-02阅读
 * cron: 23 9 * * *
 */
// SPDX-License-Identifier: MIT
'use strict';

process.env.BING_REWARDS_TASKS = 'read';
if (process.env.BING_REWARDS_NOTIFY === undefined) {
    process.env.BING_REWARDS_NOTIFY = '0';
}

require('./microsoft_rewards_ql').main().catch(function (error) {
    console.error('[阅读任务错误] ' + error.message);
    process.exitCode = 1;
});
