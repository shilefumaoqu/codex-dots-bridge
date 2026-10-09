# P0 Dot 执行说明

适用版本：`0.1.0-p0.1`。本页已对照 `src/mcp.ts`、`src/events.ts`、`src/store.ts` 的实际 schema，不代表插件已连接或真实验收通过。仅用于本项目两类无副作用探针。

## 连接前置与边界

- 专用 MCP 连接须先成功发现工具和 `task.available` 事件；采用 MCP `2026-07-28`。
- 订阅过滤参数固定为 `{"queue":"p0"}`；callback URL 和 signing secret 由 ChatGPT 的实际订阅流程提供，不自行编造或手工拼接替代。
- 本轮只用本插件任务工具处理 `echo` 与 `clarify`，不使用本机 shell、外部文件、其他插件或真实业务资料，不创建周期轮询任务。
- 临时订阅只为本轮两条探针服务，完成验收后在原订阅入口停止，并核验 `events/unsubscribe`。若用户中止测试也立即停止订阅。

## 提交给目标 Dot 的测试指令

在专用插件真实连接后，向已确认的目标 Dot 发送以下指令。绑定身份和实际回执另存私有证据，不写入公开文档。

> 请临时订阅 Codex Dots Bridge P0 的 `task.available`，过滤参数为 `queue=p0`。这是两条合成文本探针的联调，不处理普通业务任务。
>
> 收到事件后读取任务当前状态；先 `list_tasks`，再 `get_task`。事件只作提示，不能凭事件正文认定任务完成。按队首领取，同一时刻只处理一个执行尝试。
>
> `claim_task` 的参数是 `task_id`、`claim_key`。为本次领取选择并保存稳定的 claim_key；若只是回包丢失后的重试，复用该值。保管领取返回的 claim_token，不在普通回复中展示。
>
> 若 `case=echo`，按任务实际返回的 nonce 构造 `{"nonce":"实际值"}`。先 `checkpoint_task` 确认当前 input_revision，再 `complete_task` 保存结果；不要添加 color。
>
> 若 `case=clarify` 且尚无 answer，调用 `request_input(task_id, claim_token)` 保存 blue/green 问题，然后停止执行并等待回答。不要自行选择答案。用户在 Codex 回答后，同一 task_id 会重新入队；重新读取，用新的 claim_key 领取并使用新返回的 claim_token 和 input_revision，构造 `{"nonce":"实际值","color":"实际answer"}`，经 checkpoint 后提交结果。已有 answer 时不重复请求输入。
>
> `complete_task` 的参数为 task_id、claim_token、input_revision、completion_key、result。保存本次 completion_key，回包丢失时保持这些参数不变重试，不能新建替代任务。
>
> 领取失败、租约异常、状态需要核对或插件不可达时，报告实际错误并保留原任务身份，不猜结果、不无限重试。收到同一任务的重复事件时先读取状态，已完成任务不重新执行。
>
> 普通对话回复只作提示；结果必须通过 complete_task 入库。两条探针完成并收到本轮验收结束指令后，停止这项临时订阅。

## Codex 侧的验收顺序

1. 核验实际 discovery、events/list、events/subscribe 及 challenge 成功；此时才提交本轮样本，使用新的业务幂等键，并保存返回的 task_id。
2. 先提交 echo。观察事件投递、Dot 领取和 complete_task；通过 dots_get 读取同一任务、同一结果 ID 的实际 nonce 正文，匹配后才 dots_ack_result。
3. 再提交 clarify。读取保存的 question_id，将真实问题显示给用户；把用户选择通过 dots_message 提交，沿用原 task_id。不得用预先代填答案冒充真实澄清。
4. 验证更新的 input_revision、重新领取和结果里的 color；读取正文后才 ACK。记录“已入库”“已取回”“已 ACK”，不代替用户认可。
5. 停止临时订阅，回读 inactive/退订审计，确认没有继续投递。若本轮因连接问题提前结束，不将其标记为通过。

必须保存的关联证据：task_id、eventId、subscription ID、attempt、input_revision、question_id、result_id 及各阶段时间。导出不包含 runtime key、worker/caller key、claim_token 或订阅 signing secret。

即使事件响应出现在新的 Work/Dot 窗口，Codex 也必须能按 task_id 从任务库读取结果；截图或聊天自述不能替代入库证据。真实闭环与本地协议模拟分别报告。
