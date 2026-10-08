---
description: 修复一个 GitHub issue
difficulty: medium
testCommand:
title: 修复 #{{issue}}：{{issue_title}}
vars: issue, extra?
fetchIssue: issue
---
请修复本仓库的 issue #{{issue}}。

标题：{{issue_title}}

{{issue_body}}

{{extra}}

完成标准：
- 定位并修复 issue 描述的根因，不引入新的回归；
- 为修复补充或更新测试，至少覆盖 issue 里描述的复现路径，全部通过；
- 与该 issue 无关的代码保持不动，不顺手重构或改格式；
- 提交说明写清实际根因（如与表面症状不同），能对应到 issue 编号。
