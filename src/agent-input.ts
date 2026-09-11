import { z } from 'zod';
import { submitSchema } from './catalog.ts';

export const taskInputSchema = z.object({
  taskId: z.string().min(1), goal: z.enum(['reserve', 'cancel']), input: submitSchema,
  recovery: z.object({ priorRunId: z.string(), operationId: z.string().uuid().nullable(), reason: z.string().max(120) }).strict().nullable().default(null),
}).strict();
export type AgentTask = z.infer<typeof taskInputSchema>;
export function renderTask(value: AgentTask): string {
  const task = taskInputSchema.parse(value);
  return `你正在处理库存业务任务 ${task.taskId}。\n当前目标：${task.goal === 'reserve' ? '为指定订单意图预留库存，并报告结果。' : '取消这笔订单预留，处理可能已发生的预留并确认取消结果。'}\n`
    + `业务输入：\n${JSON.stringify(task.input, null, 2)}\n`
    + (task.recovery ? `恢复引用（不是成功证明）：\n${JSON.stringify(task.recovery, null, 2)}\n这是同一任务的接续，不是新的业务意图。\n` : '')
    + '只处理这笔业务意图，不改变数量，不自行新建意图。使用可用业务工具完成任务。区分已受理、业务已完成、结果未知；无法确认时说明所缺证据，不猜测成功。\n'
    + '状态字段语义：reserved=已确认预留；cancelled=已确认取消或释放；unknown=证据不足、结果未知；denied=身份或权限拒绝；not_applied=业务规则拒绝本次目标动作。\n'
    + '最后只输出一个JSON对象：{status:"reserved"|"cancelled"|"unknown"|"denied"|"not_applied",intentRef:string,operationId:string|null,receiptId:string|null,explanation:string}。';
}
